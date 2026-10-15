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
  credentialId?: string;
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

function clearCompletedRunSecrets(run: StoredRun): StoredRun {
  return {
    ...run,
    claimToken: '',
    request: {
      ...run.request,
      input: { inlinePrompt: '' },
      env: {},
      credentials: undefined,
      mcp: undefined,
      mcpSecrets: undefined,
      publicationToken: undefined,
      profileWorkspace: undefined,
    },
    target: { repo: run.target.repo, token: '' },
  };
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
  /** Prune only terminal projections; ambiguous active runs are never age-deleted. */
  pruneTerminalBefore?(updatedAt: number): Promise<void>;
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
export function workerStatus(run: StoredRun, nowMs = Date.now()): WorkerRunStatus {
  if (run.phase === 'done') {
    const exitReason = run.result?.exitReason;
    if (exitReason === 'cancelled') return 'cancelled';
    // Итог рана определяется `exitReason`, а не `LaunchResult.status`: последний говорит
    // только «движок запустился», и `nonzero_exit` там тоже `started`.
    return exitReason === 'completed' ? 'succeeded' : 'failed';
  }
  if (run.phase === 'claimed' || run.phase === 'running') return 'running';
  if (run.phase === 'queued' && nowMs - run.createdAt >= AMBIGUOUS_QUEUED_RUN_MS) return 'unknown';
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
    Object.assign(run, clearCompletedRunSecrets(run));
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
export const AMBIGUOUS_QUEUED_RUN_MS = 2 * 60 * 1000;

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
    Object.assign(run, clearCompletedRunSecrets(run));
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

/** Minimal Cloudflare D1 surface; kept structural so Node tests need no Workers runtime. */
export interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}

export interface D1Like {
  prepare(query: string): D1StatementLike;
  batch(statements: D1StatementLike[]): Promise<{ meta?: { changes?: number } }[]>;
}

type RunRow = { run_json: string };
const phaseRank: Record<RunPhase, number> = { queued: 0, dispatched: 1, claimed: 2, running: 3, done: 4 };

/**
 * D1-backed run projection plus an append-only, secret-free lifecycle journal.
 * Each state transition and its journal row are committed in one D1 batch.
 */
export class D1RunStore implements RunStore {
  constructor(private readonly db: D1Like, private readonly legacy?: RunStore) {}

  private async current(runId: string): Promise<StoredRun | null> {
    const row = await this.db.prepare(`SELECT run_json FROM gateway_runs WHERE run_id = ?
      AND (phase != 'done' OR updated_at >= ?)`).bind(runId, Date.now() - RUN_TTL_SECONDS * 1000).first<RunRow>();
    if (row) return JSON.parse(row.run_json) as StoredRun;
    return this.legacy?.get(runId) ?? null;
  }

  private async fromD1(runId: string): Promise<StoredRun | null> {
    const row = await this.db.prepare(`SELECT run_json FROM gateway_runs WHERE run_id = ?
      AND (phase != 'done' OR updated_at >= ?)`).bind(runId, Date.now() - RUN_TTL_SECONDS * 1000).first<RunRow>();
    return row ? JSON.parse(row.run_json) as StoredRun : null;
  }

  async create(run: StoredRun): Promise<void> {
    const identity = run.request;
    const eventKey = 'created';
    await this.db.batch([
      this.db.prepare(`INSERT INTO gateway_runs
        (run_id, user_task_id, operation_id, job_id, profile_id, conversation_id, owner_generation,
         phase, created_at, updated_at, github_run_id, claim_token, report_token, run_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(run.runId, identity.userTaskId, run.operationId, identity.jobId, identity.profileId,
          identity.conversationId, identity.ownerGeneration, run.phase, run.createdAt, run.updatedAt,
          run.githubRunId, run.claimToken, run.reportToken, JSON.stringify(run)),
      this.eventInsert(run, eventKey, 'created', run.phase, run.updatedAt),
    ]);
  }

  private eventInsert(run: StoredRun, eventKey: string, kind: string, phase: RunPhase, at: number): D1StatementLike {
    return this.db.prepare(`INSERT INTO gateway_run_events
      (run_id, event_key, user_task_id, operation_id, job_id, profile_id, conversation_id,
       owner_generation, github_run_id, event_type, phase, occurred_at)
      SELECT run_id, ?, user_task_id, operation_id, job_id, profile_id, conversation_id,
       owner_generation, github_run_id, ?, phase, updated_at FROM gateway_runs
       WHERE run_id = ? AND phase = ? AND updated_at = ?`)
      .bind(eventKey, kind, run.runId, phase, at);
  }

  async get(runId: string): Promise<StoredRun | null> { return this.current(runId); }

  async findByOperationId(operationId: string): Promise<StoredRun | null> {
    const row = await this.db.prepare(`SELECT run_json FROM gateway_runs WHERE operation_id = ?
      AND (phase != 'done' OR updated_at >= ?)`).bind(operationId, Date.now() - RUN_TTL_SECONDS * 1000).first<RunRow>();
    return row ? JSON.parse(row.run_json) as StoredRun : this.legacy?.findByOperationId(operationId) ?? null;
  }

  async remove(runId: string): Promise<void> {
    const run = await this.db.prepare('SELECT run_json FROM gateway_runs WHERE run_id = ?').bind(runId).first<RunRow>();
    if (!run) { await this.legacy?.remove(runId); return; }
    // Explicit dispatch rejection only: remove the live projection so this operationId
    // can be retried, but retain the sanitized event history for diagnosis.
    await this.db.batch([
      this.db.prepare(`INSERT INTO gateway_run_events
        (run_id, event_key, user_task_id, operation_id, job_id, profile_id, conversation_id,
         owner_generation, github_run_id, event_type, phase, occurred_at)
        SELECT run_id, 'dispatch_rejected', user_task_id, operation_id, job_id, profile_id,
         conversation_id, owner_generation, github_run_id, 'dispatch_rejected', phase, ?
        FROM gateway_runs WHERE run_id = ?`).bind(Date.now(), runId),
      this.db.prepare('DELETE FROM gateway_runs WHERE run_id = ?').bind(runId),
    ]);
  }

  async claim(runId: string, token: string): Promise<StoredRun | null> {
    const run = await this.fromD1(runId);
    if (!run) return this.legacy?.claim(runId, token) ?? null;
    if (!run || run.claimToken !== token || run.phase === 'done' || run.phase === 'claimed' || run.phase === 'running') return null;
    if (run.phase !== 'queued' && run.phase !== 'dispatched') return null;
    const at = Math.max(Date.now(), run.updatedAt + 1);
    const next = { ...run, phase: 'claimed' as const, updatedAt: at };
    try {
      const batch = await this.db.batch([
        this.db.prepare(`UPDATE gateway_runs SET phase = 'claimed', updated_at = ?, run_json = ?
          WHERE run_id = ? AND claim_token = ? AND phase IN ('queued', 'dispatched')`)
          .bind(at, JSON.stringify(next), runId, token),
        this.eventInsert(next, 'claim', 'claimed', 'claimed', at),
      ]);
      if ((batch[0]?.meta?.changes ?? 0) !== 1) return null;
      return await this.get(runId);
    } catch {
      // A concurrent claim may win between the read and conditional update.
      return null;
    }
  }

  async complete(runId: string, token: string, result: LaunchResult): Promise<boolean> {
    const run = await this.fromD1(runId);
    if (!run) return this.legacy?.complete(runId, token, result) ?? false;
    if (!run || run.reportToken !== token) return false;
    if (run.phase === 'done') return true;
    const at = Math.max(Date.now(), run.updatedAt + 1);
    const next = clearCompletedRunSecrets({ ...run, phase: 'done', updatedAt: at, result: structuredClone(result) });
    try {
      await this.db.batch([
        this.db.prepare(`UPDATE gateway_runs SET phase = 'done', updated_at = ?, run_json = ?,
          claim_token = '', report_token = '' WHERE run_id = ? AND report_token = ? AND phase != 'done'`)
          .bind(at, JSON.stringify(next), runId, token),
        this.eventInsert(next, 'completed', 'completed', 'done', at),
      ]);
      const saved = await this.get(runId);
      return saved?.phase === 'done';
    } catch {
      // Duplicate reports are successful no-ops; a lost/failed first report stays retryable.
      const saved = await this.get(runId);
      return saved?.phase === 'done';
    }
  }

  async patch(runId: string, patch: Partial<Pick<StoredRun, 'phase' | 'githubRunId'>>): Promise<void> {
    const run = await this.fromD1(runId);
    if (!run) { await this.legacy?.patch(runId, patch); return; }
    const requestedPhase = patch.phase === 'done' ? undefined : patch.phase;
    const phase = requestedPhase && phaseRank[requestedPhase] > phaseRank[run.phase] ? requestedPhase : run.phase;
    const githubRunId = run.githubRunId ?? patch.githubRunId ?? null;
    if (phase === run.phase && githubRunId === run.githubRunId) return;
    const at = Math.max(Date.now(), run.updatedAt + 1);
    const next = { ...run, phase, githubRunId, updatedAt: at };
    const eventKey = `transition:${phase}:${githubRunId ?? 'none'}`;
    await this.db.batch([
      this.db.prepare(`UPDATE gateway_runs SET phase = ?, github_run_id = ?, updated_at = ?, run_json = ?
        WHERE run_id = ? AND phase != 'done' AND
        CASE phase WHEN 'queued' THEN 0 WHEN 'dispatched' THEN 1 WHEN 'claimed' THEN 2 WHEN 'running' THEN 3 ELSE 4 END <= ?
        AND (phase != ? OR github_run_id IS NOT ?)`)
        .bind(phase, githubRunId, at, JSON.stringify(next), runId, phaseRank[phase], phase, githubRunId),
      this.eventInsert(next, eventKey, 'transition', phase, at),
    ]);
  }

  async listActive(): Promise<StoredRun[]> {
    const { results } = await this.db.prepare(`SELECT run_json FROM gateway_runs WHERE phase != 'done'`).all<RunRow>();
    const runs = results.map(({ run_json }) => JSON.parse(run_json) as StoredRun);
    if (this.legacy) {
      const known = new Set(runs.map((run) => run.runId));
      for (const run of await this.legacy.listActive()) if (!known.has(run.runId)) runs.push(run);
    }
    return runs;
  }

  async pruneTerminalBefore(updatedAt: number): Promise<void> {
    await this.db.prepare(`DELETE FROM gateway_runs WHERE phase = 'done' AND updated_at < ?`).bind(updatedAt).run();
  }
}
