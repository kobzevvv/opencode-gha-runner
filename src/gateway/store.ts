/**
 * Хранилище ранов воркера.
 *
 * Воркер stateless *с точки зрения рана* (issue #73, п.3): весь контекст приходит
 * в `LaunchRequest`, и ни один запрос не обязан помнить предыдущий. Но воркер при
 * этом не stateless *хоста*: между `launch` и `result` проходит минута-другая, за
 * время которых диспатченная GHA-джоба должна где-то забрать свой `LaunchRequest`
 * (вместе с `llmKey`) и куда-то положить результат. Это и есть единственное
 * состояние, которое здесь живёт, — и оно удаляется по TTL.
 *
 * Интерфейс намеренно узкий: две платформы (Node для локальных прогонов и тестов,
 * Cloudflare KV для прода) и никакой логики рана внутри.
 */

import type { LaunchRequest, LaunchResult, RunPhase, WorkerRunStatus } from '../contracts.js';
import type { RingTarget } from './ring.js';

export interface StoredRun {
  /** Credential class used by the API client that owns this run. */
  credentialId?: 'primary' | 'telegram_ux';
  runId: string;
  /**
   * Ключ дедупликации запуска. Наш API повторяет доставку, и повтор с тем же
   * `operationId` обязан вернуть ту же квитанцию и тот же ран, а не поднять второй.
   */
  operationId: string;
  request: LaunchRequest;
  phase: RunPhase;
  createdAt: number;
  /** Время последнего изменения статуса — уходит в `GET /status`. */
  updatedAt: number;
  /** id прогона в GitHub Actions — по нему живут cancel и разбор логов. */
  githubRunId: number | null;
  /**
   * Куда ушёл ран: репозиторий кольца и его токен.
   *
   * Хранится, потому что отмена и поиск осиротевшего прогона обязаны идти в тот же
   * репозиторий и тем же токеном, а не в «текущую» цель кольца: к моменту отмены
   * round-robin уже мог выбрать другую. Токен вычищается вместе с ключом LLM, когда
   * ран завершён.
   */
  target: RingTarget;
  /**
   * Одноразовый токен, который единственный раз едет в `workflow_dispatch`.
   * Он не даёт доступа ни к ключу LLM, ни к промпту: им обмениваются на
   * `POST /v1/claim`, и только один раз. Поэтому публичный репозиторий не течёт
   * ни ключом, ни содержимым задачи через метаданные прогона.
   */
  claimToken: string;
  /** Одноразовый токен для `POST /v1/runs/{runId}/result`. */
  reportToken: string;
  result: LaunchResult | null;
}

export interface RunStore {
  create(run: StoredRun): Promise<void>;
  get(runId: string): Promise<StoredRun | null>;
  /** Дедупликация запуска: ран, уже принятый с этим `operationId`. */
  findByOperationId(operationId: string): Promise<StoredRun | null>;
  /**
   * Снять рана. Нужно, когда диспатч не удался: запись о непринятом ране заставила бы
   * повтор с тем же `operationId` задедуплицироваться в мёртвый ран.
   */
  remove(runId: string): Promise<void>;
  /** Помечает рана claimed и возвращает его. Повторный claim возвращает `null`. */
  claim(runId: string, claimToken: string): Promise<StoredRun | null>;
  /** Кладёт финальный результат. Повторная отправка того же результата — no-op. */
  complete(runId: string, reportToken: string, result: LaunchResult): Promise<boolean>;
  patch(runId: string, patch: Partial<Pick<StoredRun, 'phase' | 'githubRunId'>>): Promise<void>;
  /** Все не завершённые раны — воркер держит их в памяти для отмены. */
  listActive(): Promise<StoredRun[]>;
}

/**
 * Статус рана в терминах контракта.
 *
 * Внутренние фазы богаче (`queued | dispatched | claimed | running | done`), но наружу
 * отдаётся ровно то, что описано в `WorkerRunStatus`: наш API не должен знать, что ран
 * сначала стоял в очереди GHA, а потом был claim'нут.
 *
 * `done` раскрывается по `exitReason`: `cancelled` — отдельный статус, а не `failed`.
 */
export function workerStatus(run: StoredRun): WorkerRunStatus {
  if (run.phase === 'done') {
    const exitReason = run.result?.exitReason;
    if (exitReason === 'cancelled') return 'cancelled';
    // Итог рана определяется `exitReason`, а не `LaunchResult.status`: последний говорит
    // только «движок запустился», и `nonzero_exit` там тоже `started`.
    return exitReason === 'completed' ? 'succeeded' : 'failed';
  }
  if (run.phase === 'claimed' || run.phase === 'running') return 'running';
  return 'accepted';
}

/** Терминальные статусы: только для них отдаётся результат, иначе 409. */
export function isTerminal(status: WorkerRunStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

/** Ключ, под которым лежит рана. Префикс важен: по нему же чистится прод. */
export const runKey = (runId: string): string => `run:${runId}`;

const PREFIX = 'run:';

export class MemoryRunStore implements RunStore {
  private readonly runs = new Map<string, StoredRun>();

  async create(run: StoredRun): Promise<void> {
    this.runs.set(run.runId, structuredClone(run));
  }

  async get(runId: string): Promise<StoredRun | null> {
    const run = this.runs.get(runId);
    return run ? structuredClone(run) : null;
  }

  async findByOperationId(operationId: string): Promise<StoredRun | null> {
    for (const run of this.runs.values()) {
      if (run.operationId === operationId) return structuredClone(run);
    }
    return null;
  }

  async remove(runId: string): Promise<void> {
    this.runs.delete(runId);
  }

  async claim(runId: string, claimToken: string): Promise<StoredRun | null> {
    const run = this.runs.get(runId);
    if (!run || run.claimToken !== claimToken || run.phase === 'done') return null;
    if (run.phase === 'claimed' || run.phase === 'running') return null;
    run.phase = 'claimed';
    // Статус сменился accepted → running, значит и `updatedAt` обязан смениться:
    // наш API отличает «ран стоит» от «ран поехал» именно по нему.
    run.updatedAt = Date.now();
    return structuredClone(run);
  }

  async complete(runId: string, reportToken: string, result: LaunchResult): Promise<boolean> {
    const run = this.runs.get(runId);
    if (!run || run.reportToken !== reportToken) return false;
    if (run.phase === 'done') return true;
    run.result = structuredClone(result);
    run.phase = 'done';
    run.updatedAt = Date.now();
    // Ключ LLM больше не нужен: джоба получила его на claim, результат она уже послала.
    // Токен цели — тоже: отменять и искать уже нечего.
    run.request = { ...run.request, env: {}, credentials: undefined, publicationToken: undefined, profileWorkspace: undefined };
    run.target = { repo: run.target.repo, token: '' };
    return true;
  }

  async patch(runId: string, patch: Partial<Pick<StoredRun, 'phase' | 'githubRunId'>>): Promise<void> {
    const run = this.runs.get(runId);
    if (run) Object.assign(run, patch, { updatedAt: Date.now() });
  }

  async listActive(): Promise<StoredRun[]> {
    return [...this.runs.values()]
      .filter((run) => run.phase !== 'done')
      .map((run) => structuredClone(run));
  }
}

export interface KvLike {
  get(key: string, type: 'text'): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(options: { prefix: string }): Promise<{ keys: { name: string }[] }>;
}

/**
 * Индекс дедупликации: `op:{operationId}` → runId.
 *
 * Отдельный ключ, а не скан всех ранов: KV `list` отдаёт ключи, но не тела, и искать
 * по телу пришлось бы читать весь namespace на каждый повтор доставки.
 */
export const operationKey = (operationId: string): string => `op:${operationId}`;

/** TTL рана: холодный старт GHA — 15–45 с, но очередь на бесплатных тарифах бывает длиннее. */
export const RUN_TTL_SECONDS = 60 * 60 * 6;

export class KvRunStore implements RunStore {
  constructor(
    private readonly kv: KvLike,
    private readonly ttlSeconds: number = RUN_TTL_SECONDS,
  ) {}

  async create(run: StoredRun): Promise<void> {
    await this.kv.put(runKey(run.runId), JSON.stringify(run), { expirationTtl: this.ttlSeconds });
    await this.kv.put(operationKey(run.operationId), run.runId, { expirationTtl: this.ttlSeconds });
  }

  async get(runId: string): Promise<StoredRun | null> {
    const raw = await this.kv.get(runKey(runId), 'text');
    return raw ? (JSON.parse(raw) as StoredRun) : null;
  }

  async findByOperationId(operationId: string): Promise<StoredRun | null> {
    const runId = await this.kv.get(operationKey(operationId), 'text');
    return runId ? this.get(runId) : null;
  }

  async remove(runId: string): Promise<void> {
    const run = await this.get(runId);
    await this.kv.delete(runKey(runId));
    if (run) await this.kv.delete(operationKey(run.operationId));
  }

  async claim(runId: string, claimToken: string): Promise<StoredRun | null> {
    const run = await this.get(runId);
    if (!run || run.claimToken !== claimToken || run.phase === 'done') return null;
    if (run.phase === 'claimed' || run.phase === 'running') return null;
    run.phase = 'claimed';
    run.updatedAt = Date.now();
    await this.kv.put(runKey(run.runId), JSON.stringify(run), { expirationTtl: this.ttlSeconds });
    return run;
  }

  async complete(runId: string, reportToken: string, result: LaunchResult): Promise<boolean> {
    const run = await this.get(runId);
    if (!run || run.reportToken !== reportToken) return false;
    if (run.phase === 'done') return true;
    run.result = result;
    run.phase = 'done';
    run.updatedAt = Date.now();
    run.request = { ...run.request, env: {}, credentials: undefined, publicationToken: undefined, profileWorkspace: undefined };
    run.target = { repo: run.target.repo, token: '' };
    await this.kv.put(runKey(runId), JSON.stringify(run), { expirationTtl: this.ttlSeconds });
    return true;
  }

  async patch(runId: string, patch: Partial<Pick<StoredRun, 'phase' | 'githubRunId'>>): Promise<void> {
    const run = await this.get(runId);
    if (!run) return;
    Object.assign(run, patch, { updatedAt: Date.now() });
    await this.kv.put(runKey(runId), JSON.stringify(run), { expirationTtl: this.ttlSeconds });
  }

  async listActive(): Promise<StoredRun[]> {
    const listed = await this.kv.list({ prefix: PREFIX });
    const runs = await Promise.all(
      listed.keys.map(({ name }) => this.kv.get(name, 'text')),
    );
    return runs
      .filter((raw): raw is string => typeof raw === 'string')
      .map((raw) => JSON.parse(raw) as StoredRun)
      .filter((run) => run.phase !== 'done');
  }
}
