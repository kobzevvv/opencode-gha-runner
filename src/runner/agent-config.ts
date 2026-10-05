/**
 * Конфиг агента для джобы.
 *
 * Зачем он нужен: `npm install -g opencode-ai` даёт бинарь, но не даёт провайдера.
 * Без `opencode.json` агент уйдёт в свой дефолтный провайдер и упадёт на
 * авторизации — причём уже после старта, то есть как `nonzero_exit`, а не как
 * preflight-отказ. Схема та же, что в `capability-probe.yml` нашего API.
 *
 * Ключ в конфиг не попадает: `apiKey` — это ссылка `{env:ИМЯ}`, а значение приходит
 * в процесс агента из claim'а под именем `llmKeyEnvName`. Поэтому один и тот же
 * шаблон работает и для `LLM_LADDER_TOKEN`, и для любого другого имени.
 *
 * Remote MCP добавляется тем же приёмом: `url` и `headers` приходят из запроса, но
 * секретные значения заголовков остаются ссылками `{env:ИМЯ}`. Проверено на живом
 * opencode 1.18.34: `{env:...}` в `mcp.<name>.headers` подставляется, токен в файл
 * не пишется.
 *
 * Конфиг кладётся в `~/.config/opencode/opencode.json` идентичности рана, а не в
 * workspace: репозиторий пользователя трогать нельзя, а `HOME` у агента и так
 * свой — поэтому ни workspace, ни чужой репозиторий не видят этой записи.
 */

import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { McpRemoteServerSpec } from '../contracts.js';
import { MINIMAL_PATH, type Identity } from './identity.js';

/** Шаблон лежит в репозитории воркера; в `dist` он лежит на две директории выше. */
export const AGENT_CONFIG_TEMPLATE = fileURLToPath(new URL('../../../agent/opencode.json', import.meta.url));

export interface RenderedConfigOptions {
  llmKeyEnvName: string;
  /** Remote MCP-серверы рана. Ключ — имя сервера в конфиге. */
  mcpServers?: Record<string, McpRemoteServerSpec>;
}

/**
 * Подставляет `{env:NAME}` → `{env:llmKeyEnvName}` в провайдере и переносит
 * remote MCP-серверы из запроса в конфиг.
 */
export function renderAgentConfig(template: string, options: RenderedConfigOptions): string {
  const config = JSON.parse(template) as {
    provider?: Record<string, { options?: { apiKey?: string } }>;
    mcp?: Record<string, unknown>;
  };

  for (const provider of Object.values(config.provider ?? {})) {
    const apiKey = provider.options?.apiKey;
    if (typeof apiKey === 'string' && apiKey.startsWith('{env:')) {
      provider.options!.apiKey = `{env:${options.llmKeyEnvName}}`;
    }
  }

  const servers = options.mcpServers ?? {};
  if (Object.keys(servers).length > 0) {
    config.mcp = { ...(config.mcp ?? {}) };
    for (const [name, server] of Object.entries(servers)) {
      config.mcp[name] = {
        type: 'remote',
        url: server.url,
        // Заголовки с секретами приходят как `{env:ИМЯ}` и остаются ссылками.
        ...(server.headers ? { headers: server.headers } : {}),
        enabled: server.enabled !== false,
      };
    }
  }

  return `${JSON.stringify(config, null, 2)}\n`;
}

/**
 * Кладёт конфиг в `~/.config/opencode/opencode.json` идентичности рана.
 * Возвращает путь, чтобы раннер записал его в лог сессии — без содержимого.
 */
export async function installAgentConfig(options: {
  identityHome: string;
  llmKeyEnvName: string;
  mcpServers?: Record<string, McpRemoteServerSpec>;
  templatePath?: string;
  /**
   * Записать конфиг. По умолчанию — обычная запись, но вызывающий обязан передать
   * функцию, пишущую под идентичностью: `~/.config/opencode` принадлежит UID рана,
   * и запись из процесса раннера падает с EACCES.
   */
  write?: (target: string, contents: string) => Promise<void>;
}): Promise<string> {
  const template = await readFile(options.templatePath ?? AGENT_CONFIG_TEMPLATE, 'utf8');
  const rendered = renderAgentConfig(template, {
    llmKeyEnvName: options.llmKeyEnvName,
    mcpServers: options.mcpServers,
  });
  const target = path.join(options.identityHome, '.config', 'opencode', 'opencode.json');
  if (options.write) {
    await options.write(target, rendered);
  } else {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, rendered, { encoding: 'utf8', mode: 0o600 });
  }
  return target;
}

const exec = promisify(execFile);

export async function withAgentConfigSpool<Result>(rendered: string, owner: { uid: number; gid: number }, consume: (staging: string) => Promise<Result>): Promise<Result> {
  if (!Number.isSafeInteger(owner.uid) || owner.uid < 0 || !Number.isSafeInteger(owner.gid) || owner.gid < 0) {
    throw new Error('Invalid config spool identity');
  }
  const directory = await mkdtemp(path.join(tmpdir(), 'opencode-config-'));
  try {
    const staging = path.join(directory, 'opencode.json');
    await writeFile(staging, rendered, { encoding: 'utf8', mode: 0o600 });
    await chmod(staging, 0o600);
    const initial = await stat(staging);
    if (initial.uid !== owner.uid || initial.gid !== owner.gid) {
      await exec('sudo', ['chown', `${owner.uid}:${owner.gid}`, staging], { env: { PATH: MINIMAL_PATH } });
    }
    const transferred = await stat(staging);
    if (transferred.uid !== owner.uid || transferred.gid !== owner.gid || (transferred.mode & 0o777) !== 0o600) {
      throw new Error('Config spool ownership transfer refused');
    }
    await chmod(directory, 0o711);
    return await consume(staging);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Ставит конфиг агента под идентичностью рана.
 *
 * Отдельная функция, потому что запись конфиг�� — самая неприятная часть джобы по
 * числу неочевидных требований, и в `main()` она размывала весь шаг:
 *
 *   - `~/.config/opencode` принадлежит UID рана, поэтому пишет **раннер** в свой
 *     каталог, а переносит под идентичность (`cp` даёт EPERM на чужой файл, а
 *     `mkdir`/`chmod` оттуда — EACCES/EPERM);
 *   - staging-файл (`0600`) принадлежит UID рана; каталог (`0711`) не раскрывает
 *     содержимое другим UID, даже если MCP-заголовки содержат literal credentials;
 *   - `cp` не создаёт промежуточные каталоги, а `~/.config/opencode` у
 *     свежесозданного пользователя отсутствует;
 *   - `chmod 600` — тоже под идентичностью: после `cp` файл принадлежит UID рана.
 */
export async function installAgentConfigUnderIdentity(options: {
  identity: Identity;
  llmKeyEnvName: string;
  mcpServers?: Record<string, McpRemoteServerSpec>;
}): Promise<string> {
  const { identity } = options;
  const env = { PATH: MINIMAL_PATH, HOME: identity.home };
  const rendered = renderAgentConfig(
    await readFile(AGENT_CONFIG_TEMPLATE, 'utf8'),
    { llmKeyEnvName: options.llmKeyEnvName, mcpServers: options.mcpServers },
  );
  const target = path.join(identity.home, '.config', 'opencode', 'opencode.json');
  return withAgentConfigSpool(rendered, identity, async (staging) => {
    await exec('sudo', ['-u', identity.name, '--', 'mkdir', '-p', path.dirname(target)], { env });
    await exec('sudo', ['-u', identity.name, '--', 'cp', staging, target], { env });
    await exec('sudo', ['-u', identity.name, '--', 'chmod', '600', target], { env });
    return target;
  });
}
