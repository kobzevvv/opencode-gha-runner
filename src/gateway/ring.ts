/**
 * Кольцо репозиториев, между которыми воркер раскидывает запуски агента.
 *
 * Зачем: один репозиторий GitHub Actions — это один потолок одновременных джоб (20 на
 * аккаунт) и один egress-адрес. Кольцо из N репозиториев даёт N таких потолков, при
 * условии что запуски действительно расходятся по репозиториям.
 *
 * Источник кольца — воркер `zen-rings` (D1-таблица `zen_repos`, `GET /zen/ring/payload`),
 * тот же, которым пользуется LLM-пул. Читать его можно только админ-токеном кольца,
 * поэтому есть и второй, менее привилегированный источник: статический список в секрете
 * воркера. Оба дают один и тот же тип цели.
 *
 * Токен цели — это PAT репозитория из кольца: без него нельзя ни диспатчить workflow,
 * ни отменить прогон. Он живёт в записи рана до его завершения и вычищается вместе с
 * ключом LLM.
 */

import { isSafeWorkflowName } from '../contracts.js';
import type { KvLike } from './store.js';

export interface RingTarget {
  /** `owner/name` — репозиторий, в который уйдёт workflow. */
  repo: string;
  /** Токен с правом `workflow` в этом репозитории. */
  token: string;
  /**
   * Имя workflow в этом репозитории. Пусто — берётся имя репозитория с `.yml`, потому
   * что `ring/provision.sh` кладёт файл именно под таким именем. Явное значение нужно
   * только когда провижн делался по-другому.
   */
  workflow?: string;
}

const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

function isTarget(value: unknown): value is RingTarget {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row['repo'] === 'string' &&
    REPO_RE.test(row['repo']) &&
    typeof row['token'] === 'string' &&
    row['token'].length > 0 &&
    row['enabled'] !== false
  );
}

/**
 * Разбирает кольцо из JSON.
 *
 * Два формата, потому что два источника:
 *   - ответ `zen-rings`: `{ repos: [{ repo, token, enabled }] }`
 *   - наш собственный секрет: `[{ repo, token }]` или `{ targets: [...] }`
 *
 * Строки без токена или с `enabled: false` отбрасываются: репозиторий, в который нельзя
 * постучаться, — это не цель, а отложенный отказ на запуске.
 */
export function parseRing(input: unknown): RingTarget[] {
  let rows: unknown = input;
  if (typeof input === 'string') {
    try {
      rows = JSON.parse(input);
    } catch {
      return [];
    }
  }
  if (typeof rows === 'object' && rows !== null && !Array.isArray(rows)) {
    const wrapper = rows as Record<string, unknown>;
    rows = wrapper['repos'] ?? wrapper['targets'] ?? [];
  }
  if (!Array.isArray(rows)) return [];
  return rows.filter(isTarget).map((row) => ({
    repo: row.repo,
    token: row.token,
    // Негодное имя workflow молча игнорируем: цель остаётся целью, а имя возьмётся из
    // имени репозитория. Отбрасывать всю строку из-за одного поля смысла нет.
    ...(isSafeWorkflowName(row.workflow) ? { workflow: row.workflow } : {}),
  }));
}

export interface RingOptions {
  /** Статический список. Пустой — кольцо берётся у zen-rings. */
  targets?: RingTarget[];
  /** `GET /zen/ring/payload` — отдаёт цели с токенами. */
  zenUrl?: string;
  zenAdminToken?: string;
  /** Общее хранилище для курсора и кэша. Без него — память процесса (dev и тесты). */
  kv?: KvLike;
  fetchImpl?: typeof fetch;
  /** Сколько секунд держать кольцо в кэше. */
  cacheTtlSeconds?: number;
  now?: () => number;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

const CACHE_KEY = 'ring:cache';

/**
 * Кольцо: цель запуска выбирается по самому `runId`, без общего состояния.
 *
 * Раньше здесь был курсор round-robin в KV (`rr:cursor`). Он не работает: Cloudflare KV
 * итеретивно непоследователен, поэтому `get` возвращает устаревшее значение, и параллельные
 * `launch` (5 штук на живом замере 05.10.2026) читали одно и то же — все пять ушли в
 * `recruiting-me/runs`. Кольцо существует ради умножения потолка параллельных джоб, и именно
 * при параллельной нагрузке оно не работало.
 *
 * Теперь индекс — хеш `runId` по модулю размера кольца. Свойства ровно те, что нужны:
 *   - разные `runId` расходятся по кольцу, параллельные запуски не сливаются;
 *   - один и тот же `runId` всегда даёт ту же цель, поэтому отмена и поиск осиротевшего
 *     прогона идут туда же, куда ушёл запуск (это требование дедупликации);
 *   - состояния нет — значит, нечему гоняться между изолятами и нечего терять при
 *     холодном старте.
 *
 * Чего это не даёт: строгого чередования. Два запуска подряд могут уйти в одну цель, и
 * при малом кольце это вероятно. Для балансировки по времени это неважно — важно, чтобы
 * одновременные запуски не попали в одну цель, а это обеспечено.
 */
export class Ring {
  private readonly options: RingOptions;
  private cached: RingTarget[] | null = null;
  private cachedAt = 0;

  constructor(options: RingOptions) {
    this.options = options;
  }

  private get log(): (message: string, fields?: Record<string, unknown>) => void {
    return this.options.log ?? ((): void => {});
  }

  /** Цели кольца: статический список, иначе кэш, иначе запрос к zen-rings. */
  async targets(): Promise<RingTarget[]> {
    if (this.options.targets && this.options.targets.length > 0) return this.options.targets;
    const ttlMs = (this.options.cacheTtlSeconds ?? 300) * 1000;
    const now = (this.options.now ?? Date.now)();
    if (this.cached && now - this.cachedAt < ttlMs) return this.cached;

    const fromCache = await this.readCache();
    if (fromCache) {
      this.cached = fromCache;
      this.cachedAt = now;
      return fromCache;
    }

    const fetched = await this.fetchZenRing();
    if (fetched.length > 0) {
      this.cached = fetched;
      this.cachedAt = now;
      await this.writeCache(fetched);
      return fetched;
    }
    // Пустое кольцо — не повод падать: вызывающий решает, что делать (обычно — одна
    // цель из конфига). Но сказать об этом надо: иначе «почему всё в одну репу» ищут долго.
    this.log('ring is empty');
    return [];
  }

  private async readCache(): Promise<RingTarget[] | null> {
    const kv = this.options.kv;
    if (!kv) return null;
    try {
      const raw = await kv.get(CACHE_KEY, 'text');
      if (!raw) return null;
      const parsed = parseRing(raw);
      return parsed.length > 0 ? parsed : null;
    } catch {
      return null;
    }
  }

  private async writeCache(targets: RingTarget[]): Promise<void> {
    const kv = this.options.kv;
    if (!kv) return;
    try {
      // Кэш живёт в KV в открытом виде, а в нём токены. TTL короткий намеренно: это
      // ускоритель, а не хранилище — источник истины остаётся в D1 кольца.
      await kv.put(CACHE_KEY, JSON.stringify(targets), { expirationTtl: this.options.cacheTtlSeconds ?? 300 });
    } catch (cause) {
      this.log('ring cache write failed', { error: cause instanceof Error ? cause.message : String(cause) });
    }
  }

  private async fetchZenRing(): Promise<RingTarget[]> {
    const { zenUrl, zenAdminToken } = this.options;
    if (!zenUrl || !zenAdminToken) return [];
    const fetchImpl = this.options.fetchImpl ?? fetch.bind(globalThis);
    try {
      const response = await fetchImpl(`${zenUrl.replace(/\/+$/, '')}/zen/ring/payload`, {
        headers: { authorization: `Bearer ${zenAdminToken}`, accept: 'application/json' },
      });
      if (!response.ok) {
        this.log('ring fetch refused', { status: response.status });
        return [];
      }
      const targets = parseRing(await response.json());
      this.log('ring fetched', { size: targets.length });
      return targets;
    } catch (cause) {
      this.log('ring fetch failed', { error: cause instanceof Error ? cause.message : String(cause) });
      return [];
    }
  }

  /**
   * Цель для запуска `seed` (это `runId`). `null` — кольцо пусто, вызывающий откатывается
   * на конфиг.
   */
  async next(seed: string): Promise<RingTarget | null> {
    const targets = await this.targets();
    if (targets.length === 0) return null;

    const index = indexForSeed(seed, targets.length);
    const target = targets[index]!;
    this.log('ring pick', { repo: target.repo, index, size: targets.length, seed });
    return target;
  }
}

/**
 * Индекс цели по `runId`.
 *
 * FNV-1a: арифметика на 32-битных целых, без `bitwise`-операций со знаком — в JS
 * `x << 0` для больших значений даёт отрицательное число, и остаток от деления на
 * длину кольца вышел бы отрицательным. Хеш берётся по модулю 2^32 через `>>> 0`.
 */
function indexForSeed(seed: string, size: number): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    // 16777619 — простое 2^32 по модулю; умножение держим в пределах 2^53 через Math.imul.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash >>> 0) % size;
}
