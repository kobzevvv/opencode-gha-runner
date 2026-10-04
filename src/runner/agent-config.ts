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

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpRemoteServerSpec } from '../contracts.js';

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
