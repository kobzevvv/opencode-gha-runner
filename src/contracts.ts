/**
 * Контракт воркера ↔ Serverless Agent API.
 *
 * Источник истины — issue #73 в `trained-assist/ai-agent-runner`
 * («Контракт API для внешнего запуска агента на GitHub»). Документ помечен как драфт,
 * поэтому здесь зафиксированы только поля, которые реально читает и пишет наш код;
 * любое расширение обязано сначала появиться в issue.
 *
 * Два принципа, из которых выведены все проверки ниже:
 *   1. Воркер stateless — весь контекр��ст рана приходит в `LaunchRequest`.
 *   2. Секреты не едут в открытых полях — `llmKey` живёт только в теле `launch`
 *      и забирается джобой одноразовым claim-токеном.
 */

export const CONTRACT_VERSION = 1 as const;
export const ENGINE_NAME = 'dynamic-ip-azure-agent-run' as const;
export const ENGINE_ADAPTER_VERSION = '1' as const;

// ─────────────────────────────────────────────────────────────────────────────
// LaunchRequest — что наш API шлёт воркеру
// ───────────────────────────────────────────────��─────────────────────────────

export type IsolationMode = 'per_run_unix_identity' | 'none';

export interface EngineModelSettings {
  model?: string;
  temperature?: number;
}

export interface EngineSpec {
  name: string;
  adapterVersion: string;
  modelSettings?: EngineModelSettings;
}

export interface OutputSpec {
  path: string;
  /** Опционально: если не задано, воркер выводит имя из `path`. */
  name?: string;
  /** Опционально: если не задано, воркер определяет MIME по расширению. */
  mime?: string;
}

export interface LaunchLimits {
  timeoutMs: number;
  maxOutputBytes: number;
  maxLogBytes: number;
}

/**
 * Расширение issue #73: ключ LLM едет в теле запроса, а не в полях `env`.
 *
 * Причина в том, что `env` по контракту разрешено пробрасывать в процесс агента
 * дословно (`env` = только `envAllowlist`), и наш API уже умеет отдавать в нём
 * `LLM_LADDER_TOKEN`. Новое отдельное поле даёт воркеру независимое от `envAllowlist`
 * место для ключа и позволяет отказать на preflight, если ключ не пришёл, а не
 * запускать агента, который упадёт на первом же обращении к модели.
 */
export interface LaunchCredentials {
  /** Ключ LLM. Никогда не логируется, не кладётся в inputs диспатча, не пишется в артефакты. */
  llmKey: string;
  /** Имя переменной, под которой ключ должен попасть в процесс агента. */
  envName?: string;
}

/**
 * Remote MCP-сервер, который агент должен видеть.
 *
 * Только `remote`: локальный stdio-сервер в GHA-джобе бессмыслен, потому что
 * настоящий MCP живёт на VM агента — там его секреты, состояние и браузер
 * (`agent-mcp-bridge.js` в `trained-assist-agent` держит ровно эту границу).
 * Значения в `headers` могут ссылаться на env как `{env:ИМЯ}`; тогда само значение
 * приходит в `mcpSecrets` и в конфиг не попадает — opencode подставляет его на старте.
 */
export interface McpRemoteServerSpec {
  type: 'remote';
  url: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

export interface McpSpec {
  servers: Record<string, McpRemoteServerSpec>;
}

export interface LaunchRequest {
  runId: string;
  jobId: string;
  userTaskId: string;
  profileId: string;
  conversationId: string;
  operationId: string;
  ownerGeneration: number;
  engine: EngineSpec;
  input: { inlinePrompt: string };
  /** Абсолютный путь workspace внутри раннера (см. DEVIATIONS: воркер клонирует сам). */
  cwd: string;
  envAllowlist: string[];
  env: Record<string, string>;
  limits: LaunchLimits;
  /**
   * `branch` задаёт наше API, а не воркер: только API знает `runId`, поэтому имя ветки
   * уникально, трассируемо до рана и не может столкнуться с ветками самого юзера. Ветка —
   * единица результата, и воркер обязан коммитить именно в неё, а не выдумывать свою.
   */
  repository: { fullName: string; branch: string };
  /**
   * Куда воркер отдаёт `LaunchResult` этого рана: `POST {resultUrl}` с тем же общим секретом
   * в `Authorization`, которым аутентифицировали launch. Адрес приходит в запросе, поэтому
   * воркеру не нужно знать, где живёт наш API.
   */
  resultUrl: string;
  isolation: { mode: IsolationMode };
  outputs?: OutputSpec[];
  /** Опционально: только если наш API сам кладёт ключ в `envAllowlist`. */
  credentials?: LaunchCredentials;
  /** Remote MCP-серверы, которые подключаются к агенту рана. */
  mcp?: McpSpec;
  /**
   * Секреты для `{env:ИМЯ}` в `mcp.headers`. Отдельно от `env`, потому что `env` —
   * это то, что разрешено пробросить в процесс, а это значения, которые вообще не
   * должны оказаться в конфиге на диске и в логе. Redacted так же, как `llmKey`.
   */
  mcpSecrets?: Record<string, string>;
}

// ─────────────────────────────────────────────────────────────────────────────
// LaunchResult — что воркер возвращает нашему API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Статус в `LaunchResult` — это «запустился ли процесс», а не «чем кончился ран».
 *
 * `started` — движок отработал (в том числе с ненулевым кодом, таймаутом или сигналом:
 * процесс-то был); `failed` — воркер не смог его запустить. Итог рана читается из
 * `exitReason`, а не отсюда.
 */
export type LaunchStatus = 'started' | 'failed';

export type ExitReason =
  | 'completed'
  | 'nonzero_exit'
  | 'startup_failure'
  | 'timeout'
  | 'crash'
  | 'cancelled'
  | 'preflight_refused';

export type FailureClass = 'preflight' | 'engine' | 'runtime' | 'finalization';

export interface Failure {
  code: string;
  failureClass: FailureClass;
  safeSummary: string;
  retryable: boolean;
}

export type AnswerSource = 'engine_stdout' | 'agent_file' | null;

export interface ArtifactRef {
  path: string;
  name: string;
  mime: string;
  sha256: string;
  size: number;
}

export interface LaunchResult {
  runId: string;
  status: LaunchStatus;
  /**
   * pid процесса агента. Обязательное поле контракта, но в GHA-джобе он чужой:
   * агент живёт на другой машине, поэтому здесь всегда `null` — это честнее, чем
   * подставить pid процесса, который к агенту отношения не имеет.
   */
  pid: number | null;
  exitCode: number | null;
  exitSignal: string | null;
  exitReason: ExitReason;
  stdout: string;
  stderr: string;
  answer?: string;
  answerSource: AnswerSource;
  durationMs: number;
  timedOut: boolean;
  outputTruncated: boolean;
  artifacts: ArtifactRef[];
  logUrl: string;
  /**
   * Куда лёг результат: ветка пришла от нашего API, `commit` — HEAD этой ветки.
   *
   * `commit` обязан быть непустой строкой (так требует валидатор нашего API), поэтому
   * когда ничего не запушено, отдаётся null-SHA git (`0…0`) — его собственный маркер
   * «коммита нет», а не выдуманный хэш.
   */
  repo: { fullName: string; branch: string; commit: string; baseRef?: string };
  failure?: Failure;
}

/** Коды отказа из issue #73. */
export const FAILURE_CODES = [
  'AGENT_BINARY_MISSING',
  'AGENT_STARTUP_FAILED',
  'AGENT_TIMEOUT',
  'AGENT_CRASH',
  'WORKER_INTERNAL',
  'ISOLATION_UNSUPPORTED',
  'RUN_NOT_FOUND',
  'RUN_ALREADY_ACTIVE',
  'CLAIM_INVALID',
  'UNSUPPORTED_ENGINE',
  'UNSUPPORTED_ISOLATION',
  // Добавлено воркером: issue #73 перечисляет отказы «процесс не запустился», но ран
  // может и запуститься, и упасть на реальной работе. У `nonzero_exit` не должно
  // быть кода `AGENT_STARTUP_FAILED` — это разные вещи, и наш API по retryable-флагу
  // принял бы решение «повторить» там, где повтор бессмыслен.
  'AGENT_NONZERO_EXIT',
] as const;

export type FailureCode = (typeof FAILURE_CODES)[number];

/** Коды, при которых наш API имеет право повторить запуск. */
const RETRYABLE: ReadonlySet<string> = new Set([
  'AGENT_STARTUP_FAILED',
  'AGENT_TIMEOUT',
  'AGENT_CRASH',
  'WORKER_INTERNAL',
]);

export function isRetryableCode(code: string): boolean {
  return RETRYABLE.has(code);
}

export function failure(
  code: FailureCode,
  failureClass: FailureClass,
  safeSummary: string,
): Failure {
  return { code, failureClass, safeSummary: redact(safeSummary), retryable: isRetryableCode(code) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Промежуточные статусы для асинхронного poll-контракта
// ─────────────────────────────────────────────────────────────────────────────

export type RunPhase = 'queued' | 'dispatched' | 'claimed' | 'running' | 'done';

/**
 * Статус рана в терминах контракта (`GET /v1/runs/{runId}/status`).
 *
 * `unknown` — исход установить нельзя (обрыв связи, смерть воркера без финализации).
 * Это **не** `failed`: задача не теряется, авто-rerun не происходит, следующий шаг —
 * reconcile существующего запуска.
 */
export type WorkerRunStatus = 'accepted' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';

/**
 * Квитанция запуска. `POST /v1/launch` отвечает ею сразу: воркер принял ран и ушёл
 * работать, соединение закрывается. Финальный результат читается отдельно — по
 * `statusUrl` и `resultUrl`.
 */
export interface LaunchReceipt {
  runId: string;
  operationId: string;
  status: 'accepted';
  statusUrl: string;
  resultUrl: string;
}

export interface WorkerStatusView {
  runId: string;
  status: WorkerRunStatus;
  updatedAt: string;
}

export interface RunStatusResponse {
  runId: string;
  phase: RunPhase;
  /** `null`, пока рана нет — наш API отличит «ещё не готов» от «упало». */
  result: LaunchResult | null;
  /** Ссылка, по которой джоба положит результат, если процесс оборвётся. */
  reportUrl?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Валидация
// ─────────────────────────────────────────────────────────────���───────────────

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const REPO_FULL_NAME = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const WORKFLOW_FILE = /^[A-Za-z0-9._-]+\.ya?ml$/;
const MAX_PROMPT_BYTES = 512 * 1024;
const MAX_OUTPUTS = 64;
const MAX_ENV_ENTRIES = 256;

export class ValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`LaunchRequest invalid: ${issues.join('; ')}`);
    this.name = 'ValidationError';
    this.issues = issues;
  }
}

function isSafeId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Длина строки в UTF-8 без Node-глобала: шлюз едет в Cloudflare Worker, где его нет.
 * `TextEncoder` есть и в Workers, и в Node.
 */
const utf8Encoder = new TextEncoder();
function utf8Length(value: string): number {
  return utf8Encoder.encode(value).length;
}

/** Относительный путь без выхода из workspace — та же проверка, что и у нас в API. */
export function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024) return false;
  if (value.startsWith('/') || value.includes('\\')) return false;
  if (utf8Length(value) > 4096) return false;
  return !value
    .split('/')
    .some((segment) => segment === '' || segment === '.' || segment === '..');
}

/** Ветка git: без пробелов, `..`, ведущих `-`/`/` и управляющих символов. */
export function isSafeBranchName(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) return false;
  if (/[\x00-\x20~^:?*\[\\]/.test(value)) return false;
  if (value.startsWith('-') || value.startsWith('/') || value.endsWith('/') || value.endsWith('.')) return false;
  if (value.includes('..') || value.includes('//') || value.includes('@{')) return false;
  return true;
}

export function isSafeWorktreePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith('/') &&
    !value.includes('..') &&
    !value.includes('\0') &&
    value.length <= 1024
  );
}

/**
 * Отсекает секреты от текста, который уходит в лог воркера или в артефакт.
 * Ключ не должен «просачиваться» через сообщение об ошибке провайдера — поэтому
 * любое известное нам значение ключа вычищается из всех строк перед записью.
 */
export function redact(text: string, ...secrets: (string | undefined)[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 8) out = out.split(secret).join('[redacted]');
  }
  return out
    .replace(/(gh[pousr]_[A-Za-z0-9]{16,})/g, '[redacted-gh-token]')
    .replace(/(sk-[A-Za-z0-9_-]{16,})/g, '[redacted-api-key]')
    .replace(/(AKIA[0-9A-Z]{16})/g, '[redacted-aws-key]')
    .replace(/\b(ya29\.[A-Za-z0-9._-]{20,})/g, '[redacted-gcp-token]');
}

export function validateLaunchRequest(input: unknown): LaunchRequest {
  const issues: string[] = [];
  if (!isPlainObject(input)) throw new ValidationError(['expected a JSON object']);

  const req = input as Record<string, unknown>;

  for (const key of ['runId', 'jobId', 'userTaskId', 'profileId', 'conversationId', 'operationId'] as const) {
    if (!isSafeId(req[key])) issues.push(`${key}: expected a safe id`);
  }

  if (typeof req['ownerGeneration'] !== 'number' || !Number.isInteger(req['ownerGeneration']) || req['ownerGeneration'] < 0) {
    issues.push('ownerGeneration: expected a non-negative integer');
  }

  if (!isPlainObject(req['engine'])) {
    issues.push('engine: expected an object');
  } else {
    const engine = req['engine'];
    // Имя движка — это адрес воркера в нашем API, а не его внутренняя деталь: одно и то
    // же развёртывание регистрируется под разными именами (`dynamic-ip-azure-agent-run`,
    // `github-actions-agent-run`). Валидируем форму, а не конкретное значение.
    if (typeof engine['name'] !== 'string' || engine['name'].length === 0 || engine['name'].length > 100) {
      issues.push('engine.name: expected a non-empty string');
    }
    if (engine['adapterVersion'] !== ENGINE_ADAPTER_VERSION) {
      issues.push(`engine.adapterVersion: expected "${ENGINE_ADAPTER_VERSION}"`);
    }
  }

  if (!isPlainObject(req['input'])) {
    issues.push('input: expected an object');
  } else {
    const prompt = req['input']['inlinePrompt'];
    if (typeof prompt !== 'string' || prompt.trim().length === 0) {
      issues.push('input.inlinePrompt: expected a non-empty string');
    } else if (utf8Length(prompt) > MAX_PROMPT_BYTES) {
      issues.push(`input.inlinePrompt: exceeds ${MAX_PROMPT_BYTES} bytes`);
    }
  }

  if (!isSafeWorktreePath(req['cwd'])) issues.push('cwd: expected an absolute path without ".."');

  if (!Array.isArray(req['envAllowlist'])) {
    issues.push('envAllowlist: expected an array');
  } else if (req['envAllowlist'].length > MAX_ENV_ENTRIES) {
    issues.push(`envAllowlist: exceeds ${MAX_ENV_ENTRIES} entries`);
  } else {
    req['envAllowlist'].forEach((name, i) => {
      if (typeof name !== 'string' || !ENV_NAME.test(name)) issues.push(`envAllowlist[${i}]: invalid env name`);
    });
  }

  if (!isPlainObject(req['env'])) {
    issues.push('env: expected an object');
  } else {
    const entries = Object.entries(req['env']);
    if (entries.length > MAX_ENV_ENTRIES) issues.push(`env: exceeds ${MAX_ENV_ENTRIES} entries`);
    for (const [name, value] of entries) {
      if (!ENV_NAME.test(name)) issues.push(`env.${name}: invalid env name`);
      if (typeof value !== 'string') issues.push(`env.${name}: expected a string`);
    }
  }

  if (!isPlainObject(req['limits'])) {
    issues.push('limits: expected an object');
  } else {
    const limits = req['limits'];
    for (const key of ['timeoutMs', 'maxOutputBytes', 'maxLogBytes'] as const) {
      const value = limits[key];
      if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
        issues.push(`limits.${key}: expected a positive integer`);
      }
    }
    const timeoutMs = limits['timeoutMs'];
    if (typeof timeoutMs === 'number' && timeoutMs > MAX_TIMEOUT_MS) {
      issues.push(`limits.timeoutMs: exceeds ${MAX_TIMEOUT_MS}`);
    }
  }

  if (!isPlainObject(req['repository'])) {
    issues.push('repository: expected an object');
  } else {
    if (!REPO_FULL_NAME.test(String(req['repository']['fullName']))) {
      issues.push('repository.fullName: expected "owner/name"');
    }
    // Ветку задаёт наше API: только оно знает runId, поэтому имя уникально и не
    // сталкивается с ветками юзера. Воркер обязан коммитить именно сюда.
    if (!isSafeBranchName(req['repository']['branch'])) {
      issues.push('repository.branch: expected a safe git branch name');
    }
  }

  // Адрес возврата результата. Без него воркеру некуда отдать LaunchResult, и наш API
  // остался бы опрашивать воркер до watchdog'а.
  if (typeof req['resultUrl'] !== 'string' || !/^https?:\/\//.test(req['resultUrl'])) {
    issues.push('resultUrl: expected an http(s) URL');
  }

  if (!isPlainObject(req['isolation'])) {
    issues.push('isolation: expected an object');
  } else if (req['isolation']['mode'] !== 'per_run_unix_identity' && req['isolation']['mode'] !== 'none') {
    issues.push('isolation.mode: expected "per_run_unix_identity" | "none"');
  }

  if (req['outputs'] !== undefined) {
    if (!Array.isArray(req['outputs'])) {
      issues.push('outputs: expected an array');
    } else if (req['outputs'].length > MAX_OUTPUTS) {
      issues.push(`outputs: exceeds ${MAX_OUTPUTS} entries`);
    } else {
      req['outputs'].forEach((output, i) => {
        if (!isPlainObject(output)) {
          issues.push(`outputs[${i}]: expected an object`);
          return;
        }
        if (!isSafeRelativePath(output['path'])) issues.push(`outputs[${i}].path: expected a safe relative path`);
        // name/mime опциональны: контракт разрешает их опустить, и воркер выводит имя
        // из path, а MIME — по расширению.
        if (output['name'] !== undefined && (typeof output['name'] !== 'string' || output['name'].length === 0 || output['name'].length > 255)) {
          issues.push(`outputs[${i}].name: expected 1..255 chars`);
        }
        if (output['mime'] !== undefined && (typeof output['mime'] !== 'string' || output['mime'].length === 0 || output['mime'].length > 255)) {
          issues.push(`outputs[${i}].mime: expected 1..255 chars`);
        }
      });
    }
  }

  if (req['credentials'] !== undefined) {
    if (!isPlainObject(req['credentials'])) {
      issues.push('credentials: expected an object');
    } else if (typeof req['credentials']['llmKey'] !== 'string' || req['credentials']['llmKey'].length < 8) {
      issues.push('credentials.llmKey: expected a string of at least 8 chars');
    } else if (req['credentials']['envName'] !== undefined && !ENV_NAME.test(String(req['credentials']['envName']))) {
      issues.push('credentials.envName: invalid env name');
    }
  }

  if (req['mcp'] !== undefined) {
    if (!isPlainObject(req['mcp'])) {
      issues.push('mcp: expected an object');
    } else if (!isPlainObject(req['mcp']['servers'])) {
      issues.push('mcp.servers: expected an object');
    } else {
      for (const [name, server] of Object.entries(req['mcp']['servers'])) {
        if (!ENV_NAME.test(name) && !/^[A-Za-z0-9._-]{1,64}$/.test(name)) {
          issues.push(`mcp.servers.${name}: invalid server name`);
          continue;
        }
        if (!isPlainObject(server)) {
          issues.push(`mcp.servers.${name}: expected an object`);
          continue;
        }
        // Только `remote`: локальный stdio-сервер в GHA-джобе бессмыслен, а
        // разрешать произвольную команду из запроса — это RCE в публичном CI.
        if (server['type'] !== 'remote') {
          issues.push(`mcp.servers.${name}.type: only "remote" is supported`);
        }
        if (typeof server['url'] !== 'string' || !/^https?:\/\//.test(server['url'])) {
          issues.push(`mcp.servers.${name}.url: expected an http(s) URL`);
        }
        if (server['headers'] !== undefined) {
          if (!isPlainObject(server['headers'])) {
            issues.push(`mcp.servers.${name}.headers: expected an object`);
          } else {
            for (const [header, value] of Object.entries(server['headers'])) {
              if (typeof value !== 'string') issues.push(`mcp.servers.${name}.headers.${header}: expected a string`);
            }
          }
        }
      }
    }
  }

  if (req['mcpSecrets'] !== undefined) {
    if (!isPlainObject(req['mcpSecrets'])) {
      issues.push('mcpSecrets: expected an object');
    } else {
      for (const [name, value] of Object.entries(req['mcpSecrets'])) {
        if (!ENV_NAME.test(name)) issues.push(`mcpSecrets.${name}: invalid env name`);
        if (typeof value !== 'string' || value.length === 0) issues.push(`mcpSecrets.${name}: expected a non-empty string`);
      }
    }
  }

  if (issues.length > 0) throw new ValidationError(issues);
  return input as unknown as LaunchRequest;
}

/** Потолок рана: GHA всё равно не даст job жить дольше 6 часов. */
export const MAX_TIMEOUT_MS = 6 * 60 * 60 * 1000;
export const MIN_TIMEOUT_MS = 5_000;

export function clampTimeout(timeoutMs: number): number {
  return Math.min(Math.max(timeoutMs, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

/** Значение `workflow` для dispatch: имя файла, без пути и без `.github/workflows/`. */
export function isSafeWorkflowName(value: unknown): value is string {
  return typeof value === 'string' && WORKFLOW_FILE.test(value);
}
