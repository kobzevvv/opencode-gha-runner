/**
 * Запуск агента с таймаутом и капами вывода.
 *
 * Требования issue #73:
 *   п.4 — `env` процесса = только `envAllowlist`, без секретов хоста;
 *   п.5 — по `limits.timeoutMs` процесс обязательно убивается;
 *   LaunchResult — `stdout`/`stderr` обрезаны до `maxOutputBytes`, хвост сохраняется,
 *                  а превышение помечается `outputTruncated: true`.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { redact } from '../contracts.js';
import { buildLaunchCommand, MINIMAL_PATH, resolveBinaryAbsolute, type Identity } from './identity.js';

export interface ExecOptions {
  identity: Identity;
  binary: string;
  argv: string[];
  /** Уже готовое окружение: только разрешённые имена. */
  env: Record<string, string>;
  timeoutMs: number;
  maxOutputBytes: number;
  /** Секреты, которые нужно вырезать из stdout/stderr перед возвратом наверх. */
  secrets: (string | undefined)[];
  /** Куда писать поток (для лога сессии в GCS). */
  onChunk?: (stream: 'stdout' | 'stderr', text: string) => void;
  /** Обработка отмены от нашего API. */
  onSpawn?: (child: ChildProcess) => void;
  signal?: AbortSignal;
  cancelGraceMs?: number;
}

export interface ExecOutcome {
  exitCode: number | null;
  exitSignal: string | null;
  exitReason: 'completed' | 'nonzero_exit' | 'timeout' | 'crash' | 'cancelled' | 'startup_failure';
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  outputTruncated: boolean;
}

/** Хвост вывода важнее начала: ошибка агента и ответ модели — в конце. */
export function capOutput(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return { text, truncated: false };
  const tail = buffer.subarray(buffer.length - maxBytes).toString('utf8');
  // Первые байты многобайтового символа ломают парсинг — отбрасываем до границы.
  const safeTail = tail.replace(/^�+/, '');
  return { text: safeTail, truncated: true };
}

const exec = promisify(execFile);

async function killTree(child: ChildProcess, signal: NodeJS.Signals, privileged: boolean): Promise<void> {
  if (!Number.isSafeInteger(child.pid) || child.pid! <= 0) return;
  if (privileged) {
    try {
      await exec('sudo', ['-n', '/bin/kill', '-s', signal, '--', `-${child.pid}`],
        { timeout: 1000, env: { PATH: MINIMAL_PATH } });
      return;
    } catch {}
  }
  try {
    // Отрицательный pid — вся процессная группа, которую создал `detached: true`.
    process.kill(-child.pid!, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Процесс уже мёртв — это нормальный исход.
    }
  }
}

export async function runAgent(options: ExecOptions): Promise<ExecOutcome> {
  const startedAt = Date.now();
  const unstarted = (): ExecOutcome => ({ exitCode: null, exitSignal: null, exitReason: 'startup_failure',
    stdout: '', stderr: 'host cancellation before agent spawn', durationMs: Date.now() - startedAt,
    timedOut: false, outputTruncated: false });
  if (options.signal?.aborted) return unstarted();
  // Бинарь резолвится заранее: у агента будет `env -i` с минимальным PATH, а opencode
  // в GHA лежит в tool cache, которого в этом наборе нет.
  const binary = (await resolveBinaryAbsolute(options.binary)) ?? options.binary;
  if (options.signal?.aborted) return unstarted();
  const { command, argv, stdin } = buildLaunchCommand({
    identity: options.identity,
    binary,
    argv: options.argv,
    env: options.env,
  });

  const child = spawn(command, argv, {
    cwd: options.identity.workspace,
    // Внешнему процессу (setpriv/env) PATH нужен для поиска бинаря; всё, что важно
    // для агента, задаётся через `env -i` внутри buildLaunchCommand.
    env: { PATH: MINIMAL_PATH },
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin?.on('error', () => {});
  child.stdin?.end(stdin);

  let stdout = '';
  let stderr = '';
  let stdoutTruncated = false;
  let stderrTruncated = false;
  // Кап на суммарный stdout+stderr (issue #73, limits.maxOutputBytes), а не на каждый
  // поток отдельно: иначе сумма вдвое превысит кап, который нас ограничивает.
  let totalBytes = 0;
  const cap = options.maxOutputBytes;

  const onStream = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
    const text = chunk.toString('utf8');
    options.onChunk?.(stream, text);
    if (totalBytes >= cap) {
      if (stream === 'stdout') stdoutTruncated = true;
      else stderrTruncated = true;
      return;
    }
    const remaining = cap - totalBytes;
    const piece = chunk.length <= remaining ? text : chunk.subarray(0, remaining).toString('utf8');
    totalBytes += Buffer.byteLength(piece, 'utf8');
    if (stream === 'stdout') stdout += piece;
    else stderr += piece;
    if (piece.length < text.length) {
      if (stream === 'stdout') stdoutTruncated = true;
      else stderrTruncated = true;
    }
  };

  child.stdout?.on('data', (chunk: Buffer) => onStream('stdout', chunk));
  child.stderr?.on('data', (chunk: Buffer) => onStream('stderr', chunk));

  let timedOut = false;
  let cancelled = false;
  let spawnFailed = false;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const stop = (graceMs: number): void => {
    void killTree(child, 'SIGTERM', options.identity.enforced);
    escalation ??= setTimeout(() => void killTree(child, 'SIGKILL', options.identity.enforced),
      graceMs);
  };
  const cancel = (): void => {
    if (cancelled || timedOut) return;
    cancelled = true;
    stop(Math.max(1, Math.min(5000, options.cancelGraceMs ?? 1000)));
  };
  const timer = setTimeout(() => {
    if (cancelled) return;
    timedOut = true;
    stop(5000);
  }, options.timeoutMs);

  const settled = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('error', (error) => {
      spawnFailed = true;
      stderr += `\nspawn error: ${error.message}`;
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve(spawnFailed ? { code: null, signal: null } : { code, signal });
    });
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted) cancel();
    options.onSpawn?.(child);
  });
  if (escalation) clearTimeout(escalation);
  options.signal?.removeEventListener('abort', cancel);

  const durationMs = Date.now() - startedAt;

  let exitReason: ExecOutcome['exitReason'];
  if (spawnFailed) exitReason = 'startup_failure';
  else if (cancelled && (settled.code !== null || settled.signal !== null)) exitReason = 'cancelled';
  else if (timedOut) exitReason = 'timeout';
  else if (settled.signal !== null) exitReason = 'crash';
  else if (settled.code === 0) exitReason = 'completed';
  else exitReason = 'nonzero_exit';

  const redactSecrets = (text: string): string => redact(text, ...options.secrets);

  return {
    exitCode: settled.code,
    exitSignal: settled.signal,
    exitReason,
    stdout: redactSecrets(stdout),
    stderr: redactSecrets(stderr),
    durationMs,
    timedOut,
    outputTruncated: stdoutTruncated || stderrTruncated,
  };
}

/**
 * Собирает `env` процесса агента.
 *
 * Жёсткое правило: в результат попадают **только** имена из `envAllowlist`. Ключ LLM
 * добавляется отдельным исключением — и только если его имя тоже в allowlist либо
 * его прислали в `credentials` (это отдельное, намеренное поле контракта).
 */
export function resolveAgentEnv(options: {
  envAllowlist: string[];
  env: Record<string, string>;
  identityHome: string;
  llmKeyEnvName: string;
  llmKey: string;
  extra?: Record<string, string>;
  /**
   * Изоляция включена. Тогда HOME всегда указывает на home идентичности, даже если
   * наш API прислал своё значение: процесс идёт под UID рана, и opencode не смог бы
   * писать свой лог в `/home/runner/.local/share/opencode/log` — падал с
   * `PermissionDenied: FileSystem.open`.
   */
  isolationEnforced?: boolean;
  /**
   * Секреты, которые наш API объявил отдельным каналом (`mcpSecrets`), а не через
   * `envAllowlist`. Инъектируются в процесс агента под своими именами и redacted из
   * любого вывода — ровно как `llmKey`. Через `env` их пропускать нельзя: `env` по
   * контракту пробрасывается дословно и может попасть в лог.
   */
  injectedSecrets?: Record<string, string>;
}): Record<string, string> {
  const allow = new Set(options.envAllowlist);
  const resolved: Record<string, string> = {};

  for (const name of allow) {
    const provided = options.env[name];
    if (provided !== undefined) {
      resolved[name] = provided;
      continue;
    }
    // HOME без значения означал бы, что агент пишет в HOME хоста — это ровно то, чего
    // изоляция не должна допускать. Подставляем home идентичности рана.
    if (name === 'HOME') resolved['HOME'] = options.identityHome;
  }

  if (options.isolationEnforced) {
    resolved['HOME'] = options.identityHome;
  }

  if (options.llmKey.length > 0) {
    resolved[options.llmKeyEnvName] = options.llmKey;
  }

  for (const [name, value] of Object.entries(options.injectedSecrets ?? {})) {
    if (value.length > 0) resolved[name] = value;
  }

  for (const [name, value] of Object.entries(options.extra ?? {})) {
    if (allow.has(name)) resolved[name] = value;
  }

  return resolved;
}
