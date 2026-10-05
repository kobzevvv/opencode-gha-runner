/**
 * Кольцо репозиториев, между которыми воркер раскидывает запуски агента.
 *
 * Зачем: один репозиторий GitHub Actions — это один потолок одновременных джоб (20 на
 * аккаунт) и один egress-адрес. Кольцо из N репозиториев даёт N таких потолков, а
 * round-robin не даёт одному репозиторию выгореть.
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

import type { KvLike } from './store.js';

export interface RingTarget {
  /** `owner/name` — репозиторий, в который уйдёт workflow. */
  repo: string;
  /** Токен с правом `workflow` в этом репозитории. */
  token: string;
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
  return rows.filter(isTarget).map((row) => ({ repo: row.repo, token: row.token }));
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

const CURSOR_KEY = 'rr:cursor';
const CACHE_KEY = 'ring:cache';

/**
 * Кольцо с round-robin.
 *
 * Курсор лежит в общем KV, а не в памяти изолята: запросы воркера попадают в разные
 * изоляты, и счётчик в памяти возвращал бы к первому репозиторию на каждом холодном
 * старте. KV не транзакционен, поэтому два одновременных запуска могут выбрать один
 * репозиторий — для балансировки это безвредно (дублируется выбор, а не ран).
 */
export class Ring {
  private readonly options: RingOptions;
  private memoryCursor = 0;
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
   * Следующая цель по циклу.
   *
   * Курсор сдвигается на каждой выдаче, поэтому следующий запуск уходит в следующий
   * репозиторий. `null` — кольцо пусто, вызывающий откатывается на конфиг.
   */
  async next(): Promise<RingTarget | null> {
    const targets = await this.targets();
    if (targets.length === 0) return null;

    const cursor = await this.nextCursor();
    const target = targets[cursor % targets.length]!;
    this.log('ring pick', { repo: target.repo, cursor: cursor % targets.length, size: targets.length });
    return target;
  }

  /**
   * Индекс цели для ЭТОЙ выдачи (0-based) и сдвиг курсора на следующую.
   *
   * Возвращается именно текущее значение, а не следующее: иначе первый запуск после
   * пустого курсора уходил бы во вторую репозиторию кольца, а первая не получала бы
   * работы никогда.
   */
  private async nextCursor(): Promise<number> {
    const kv = this.options.kv;
    if (!kv) {
      return this.memoryCursor++;
    }
    try {
      const raw = await kv.get(CURSOR_KEY, 'text');
      const parsed = raw ? Number.parseInt(raw, 10) : 0;
      const current = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
      await kv.put(CURSOR_KEY, String(current + 1));
      return current;
    } catch (cause) {
      this.log('ring cursor read failed', { error: cause instanceof Error ? cause.message : String(cause) });
      return this.memoryCursor++;
    }
  }
}
