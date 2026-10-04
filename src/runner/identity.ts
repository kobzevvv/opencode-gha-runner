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

import { execFile } from 'node:child_process';
import path from 'node:path';
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
  const { stdout: passwd } = await exec('id', ['-u', '-g', name]);
  const [uidRaw = '0', gidRaw = '0'] = passwd.trim().split(/\s+/);
  const uid = Number(uidRaw);
  const gid = Number(gidRaw);
  const home = `/home/${name}`;

  await exec('sudo', ['mkdir', '-p', workspace]);
  await exec('sudo', ['chown', '-R', `${uid}:${gid}`, workspace]);
  // Бинари и кеши — только на чтение: агент не должен переписывать opencode.
  if (options.sharedBinDir) {
    await exec('sudo', ['chmod', '-R', 'a+rX', options.sharedBinDir]);
  }

  // HOME ран�� переопределяет системный: иначе агент писал бы в ~/.local/share раннера.
  await exec('sudo', ['-u', name, 'sh', '-c', `mkdir -p ${JSON.stringify(`${home}/.cache`)} ${JSON.stringify(`${home}/.config`)}`]);

  return { name, uid, gid, home, workspace, enforced: true };
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

export const MINIMAL_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

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
export function buildLaunchCommand(args: LaunchIdentityArgs): { command: string; argv: string[] } {
  const env = { ...args.env, PATH: buildChildPath(args.env['PATH'], path.dirname(args.binary)) };
  const assignments = Object.entries(env).map(([name, value]) => `${name}=${value}`);
  const inner = ['-i', ...assignments, args.binary, ...args.argv];

  if (!args.identity.enforced) {
    return { command: 'env', argv: inner };
  }
  const { uid, gid } = args.identity;
  return {
    command: 'setpriv',
    argv: [
      `--reuid=${uid}`,
      `--regid=${gid}`,
      '--init-groups',
      '--',
      'env',
      ...inner,
    ],
  };
}

export async function isBinaryAvailable(binary: string): Promise<boolean> {
  return (await resolveBinaryAbsolute(binary)) !== null;
}
