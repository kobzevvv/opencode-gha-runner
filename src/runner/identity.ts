/**
 * Идентичность рана: `per_run_unix_identity`.
 *
 * Требование issue #73, п.6: агент не должен идти под UID сервиса, который его запустил.
 * В GHA это особенно важно — иначе агент получает парольless-sudo хоста целиком и может
 * тронуть что угодно вне своего workspace.
 *
 * На GitHub-hosted раннере `sudo` без пароля — штатное свойство (замерено в
 * `docs/GITHUB-ACTIONS-CAPABILITY.md` в `trained-assist/ai-agent-runner`), поэтому
 * границу можно поставить честно: `useradd` + `chown` воркспейса + `setpriv` на запуске.
 *
 * Если хоста без sudo (для локальных прогонов это норма) — режим `none`, и воркер
 * честно сообщает об этом, а не притворяется, что изоляция есть.
 */

import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export interface Identity {
  /** Unix-имя пользователя рана. */
  name: string;
  uid: number;
  gid: number;
  home: string;
  /** Рабочий каталог, принадлежащий этой идентичности. */
  workspace: string;
  /** Сборка идентичности реально выполнена (а не пропущена из-за отсутствия sudo). */
  enforced: boolean;
}

export interface IdentityOptions {
  runId: string;
  workspace: string;
  /** Разрешить `useradd`/`chown` через sudo. `false` — режим `none`. */
  allowSudo: boolean;
  /** Каталог для бинарей, доступных идентичности (opencode, npm-кеш). */
  sharedBinDir?: string;
}

/** Имя безопасно для Unix: только `[a-z0-9-]`, начинается с буквы, ≤ 31 символа. */
export function identityName(runId: string): string {
  const digest = [...runId].reduce(
    (acc, char) => (acc * 33 + char.charCodeAt(0)) >>> 0,
    5381,
  );
  return `ocrun-${digest.toString(36).slice(0, 12)}`;
}

async function hasSudo(): Promise<boolean> {
  try {
    await exec('sudo', ['-n', 'true']);
    return true;
  } catch {
    return false;
  }
}

async function findOnPath(binary: string): Promise<string | null> {
  try {
    const { stdout } = await exec('sh', ['-c', `command -v ${JSON.stringify(binary)}`]);
    const path = stdout.trim();
    return path.length > 0 ? path : null;
  } catch {
    return null;
  }
}

export async function detectSudo(): Promise<boolean> {
  return hasSudo();
}

/**
 * Создаёт идентичность рана и передаёт ей workspace в собственность.
 *
 * `sharedBinDir` (каталог с opencode и его кешами) делается world-readable: агент
 * запускается под новым UID и не может ставить пакеты, но должен иметь возможность
 * *исполнить* уже установленный бинарь. Права на запись туда не выдаются.
 */
export async function createRunIdentity(options: IdentityOptions): Promise<Identity> {
  const name = identityName(options.runId);
  const workspace = options.workspace;

  const sudoAvailable = options.allowSudo && (await hasSudo());
  if (!sudoAvailable) {
    return {
      name,
      uid: process.getuid?.() ?? 0,
      gid: process.getgid?.() ?? 0,
      home: process.env['HOME'] ?? '/tmp',
      workspace,
      enforced: false,
    };
  }

  await exec('sudo', ['useradd', '--create-home', '--shell', '/bin/bash', name]);
  // `id -u -g` не сработает: оба флага — «only», и GNU id отвечает
  // «cannot print "only" of more than one choice». Берём строку passwd целиком.
  const { stdout: passwd } = await exec('getent', ['passwd', name]);
  const [uidRaw = '0', gidRaw = '0'] = passwd.trim().split(':').slice(2, 4);
  const uid = Number(uidRaw);
  const gid = Number(gidRaw);
  const home = `/home/${name}`;
  const identity: Identity = { name, uid, gid, home, workspace, enforced: true };

  await exec('sudo', ['mkdir', '-p', workspace]);
  await exec('sudo', ['chown', '-R', `${uid}:${gid}`, workspace]);
  // Идентичность обязана уметь дойти до своего workspace. `runner.temp` и прочие
  // каталоги раннера обычно 700, и без `a+x` на каждом родителе git падает с
  // «Permission denied» уже внутри принадлежащего идентичности каталога.
  await ensureTraversable(workspace);
  // Бинари и кеши — только на чтение: агент не должен переписывать opencode.
  if (options.sharedBinDir) {
    await exec('sudo', ['chmod', '-R', 'a+rX', options.sharedBinDir]);
  }

  // HOME рана переопределяет системный: иначе агент писал бы в ~/.local/share раннера.
  await runUnderIdentity(identity, 'mkdir', ['-p', `${home}/.cache`, `${home}/.config`], {
    PATH: MINIMAL_PATH,
    HOME: home,
  });

  return identity;
}

/** Родители `workspace` вплоть до корня, без самого workspace. */
export function parentDirs(workspace: string): string[] {
  const absolute = path.resolve(workspace);
  const parents: string[] = [];
  let current = path.dirname(absolute);
  while (current !== path.dirname(current)) {
    parents.push(current);
    current = path.dirname(current);
  }
  return parents;
}

/**
 * Добавляет `a+x` на каждом родителе workspace вплоть до корня.
 *
 * Только execute-бит, не read и не write: идентичность получает возможность пройти
 * через каталог, но не получает доступа к его содержимому. Без этого любой
 * непривилегированный пользователь не может попасть в workspace, даже если сам
 * workspace принадлежит ему, — и `git clone` падает с «Permission denied».
 *
 * `run` инъектируется, чтобы проверка не зависела от наличия sudo на хосте.
 */
export async function ensureTraversable(
  workspace: string,
  run: (args: string[]) => Promise<unknown> = (args) => exec('sudo', ['chmod', 'a+x', ...args]),
): Promise<void> {
  for (const parent of parentDirs(workspace)) {
    await run([parent]);
  }
}

export async function destroyRunIdentity(identity: Identity): Promise<void> {
  if (!identity.enforced) return;
  try {
    await exec('sudo', ['userdel', '--remove', identity.name]);
  } catch {
    // Уборка не должна ронять рана: результат уже отправлен нашему API.
  }
}

export interface LaunchIdentityArgs {
  identity: Identity;
  binary: string;
  argv: string[];
  env: Record<string, string>;
}

export const MINIMAL_PATH = '/usr/sbin:/usr/bin:/sbin:/bin';

/**
 * Абсолютный путь к бинарю агента.
 *
 * Резолвить заранее обязательно: у процесса агента будет `env -i` с минимальным PATH,
 * а `npm install -g opencode-ai` в GHA кладёт бинарь в `/opt/hostedtoolcache/...`, —
 * этого пути в минимальном наборе нет и поиск по имени не сработал бы.
 */
export async function resolveBinaryAbsolute(binary: string): Promise<string | null> {
  if (binary.includes('/')) {
    return (await isExecutableFile(binary)) ? binary : null;
  }
  const found = await findOnPath(binary);
  if (!found) return null;
  return (await isExecutableFile(found)) ? found : null;
}

async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    const { stdout } = await exec('test', ['-x', candidate]);
    return stdout.length >= 0;
  } catch {
    return false;
  }
}

/**
 * PATH для процесса агента: разрешённый нашим API, а если его нет — минимальный.
 * Каталог самого бинаря добавляется всегда, иначе агент не найдёт `node`, которым
 * он написан, и не сможет запустить свои дочерние процессы.
 */
export function buildChildPath(allowlisted: string | undefined, binaryDir: string): string {
  const base = (allowlisted && allowlisted.length > 0 ? allowlisted : MINIMAL_PATH)
    .split(':')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const dirs = base.includes(binaryDir) ? base : [binaryDir, ...base];
  return dirs.join(':');
}

/**
 * Команда запуска агента под идентичностью рана.
 *
 * `env -i` — обязателен: без него агент унаследует весь environ хоста (в том числе
 * `GITHUB_TOKEN` джобы и `ACTIONS_RUNTIME_TOKEN`), что прямо нарушает требование
 * issue #73, п.4. Дальше — только явно разрешённые имена плюс гарантированный PATH.
 */
export function buildLaunchCommand(args: LaunchIdentityArgs): { command: string; argv: string[]; stdin: string } {
  const env = { ...args.env, PATH: buildChildPath(args.env['PATH'], path.dirname(args.binary)) };
  const stdin = JSON.stringify({ binary: args.binary, argv: args.argv, env });
  if (Buffer.byteLength(stdin) > 1048576) throw new Error('private launch payload exceeds limit');
  const inner = ['-i', process.execPath, fileURLToPath(new URL('./private-launch.js', import.meta.url))];

  if (!args.identity.enforced) {
    return { command: 'env', argv: inner, stdin };
  }
  // Через `sudo -u`, а не через `setpriv --reuid`: setpriv меняет uid только
  // при наличии CAP_SETUID, а у процесса раннера его нет — он получает только
  // passwordless sudo. Прямой вызов давал `setpriv: setresuid failed:
  // Operation not permitted`, то есть изоляция не ставилась вообще.
  return {
    command: 'sudo',
    argv: ['-u', args.identity.name, '--', 'env', ...inner],
    stdin,
  };
}

export async function isBinaryAvailable(binary: string): Promise<boolean> {
  return (await resolveBinaryAbsolute(binary)) !== null;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export class CommandError extends Error {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;

  constructor(message: string, exitCode: number | null, signal: NodeJS.Signals | null) {
    super(message);
    this.name = 'CommandError';
    this.exitCode = exitCode;
    this.signal = signal;
  }
}

/**
 * Запускает команду под идентичностью рана, возвращая stdout и stderr.
 *
 * Нужно для всего, что пишет в workspace: клон, установка зависимостей, сам агент.
 * Пока клон шёл под пользователем раннера, а workspace принадлежал идентичности —
 * `git clone` падал с «Permission denied» на `.git`, потому что создать каталог внутри
 * чужого 755-каталога раннер не мог.
 *
 * stderr возвращается отдельно и попадает в текст ошибки: `promisify(execFile)`
 * сообщает только `Command failed: ...` без stderr, и диагностика занимала лишний
 * запуск на каждый такой баг.
 */
export function runUnderIdentity(
  identity: Identity,
  command: string,
  argv: string[],
  env: Record<string, string>,
): Promise<CommandResult> {
  const launch = buildLaunchCommand({ identity, binary: command, argv, env });
  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(launch.command, launch.argv, {
      cwd: identity.workspace,
      env: { PATH: MINIMAL_PATH },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(launch.stdin);
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', (cause) => {
      reject(new CommandError(`failed to spawn ${command}: ${cause.message}`, null, null));
    });
    child.once('close', (code, signal) => {
      const result: CommandResult = { stdout, stderr };
      if (code === 0 && signal === null) {
        resolve(result);
        return;
      }
      const detail = stderr.trim().length > 0 ? stderr.trim() : stdout.trim();
      const summary = detail.length > 0 ? ` — ${detail.split('\n').slice(-6).join(' | ')}` : '';
      reject(
        new CommandError(
          `${command} exited with ${signal ?? code}${summary}`,
          code,
          signal,
        ),
      );
    });
  });
}
