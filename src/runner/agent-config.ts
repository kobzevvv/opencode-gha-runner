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
 * Конфиг кладётся в `~/.config/opencode/opencode.json` идентичности рана, а не в
 * workspace: репозиторий пользователя трогать нельзя, а `HOME` у агента и так
 * свой — поэтому ни workspace, ни чужой репозиторий не видят этой записи.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Шаблон лежит в репозитории воркера; в `dist` он лежит на две директории выше. */
export const AGENT_CONFIG_TEMPLATE = fileURLToPath(new URL('../../../agent/opencode.json', import.meta.url));

/** Подставляет `{env:NAME}` → `{env:llmKeyEnvName}` во всём документе. */
export function renderAgentConfig(template: string, llmKeyEnvName: string): string {
  const config = JSON.parse(template) as {
    provider?: Record<string, { options?: { apiKey?: string } }>;
  };
  for (const provider of Object.values(config.provider ?? {})) {
    const apiKey = provider.options?.apiKey;
    if (typeof apiKey === 'string' && apiKey.startsWith('{env:')) {
      provider.options!.apiKey = `{env:${llmKeyEnvName}}`;
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
  templatePath?: string;
}): Promise<string> {
  const template = await readFile(options.templatePath ?? AGENT_CONFIG_TEMPLATE, 'utf8');
  const rendered = renderAgentConfig(template, options.llmKeyEnvName);
  const target = path.join(options.identityHome, '.config', 'opencode', 'opencode.json');
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, rendered, { encoding: 'utf8', mode: 0o600 });
  return target;
}