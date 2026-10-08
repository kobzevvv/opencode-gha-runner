/**
 * Cloudflare Worker: тот же `createGateway`, другое транспортное слово.
 * KV binding `RUNS` (namespace) обязателен — в нём лежат раны между `launch` и `result`.
 */

import { createGateway } from './gateway/app.js';
import { parseRing } from './gateway/ring.js';
import { KvRunStore, type KvLike } from './gateway/store.js';

export interface Env {
  RUNS: KvLike;
  WORKER_TOKEN: string;
  WORKER_TOKEN_TELEGRAM_UX?: string;
  GITHUB_TOKEN: string;
  GITHUB_REPO: string;
  GITHUB_WORKFLOW?: string;
  GITHUB_REF?: string;
  PUBLIC_BASE_URL: string;
  AGENT_BINARY?: string;
  /** Источник кольца: `https://llm-ladder.trainedassist.store`. */
  ZEN_RING_URL?: string;
  /** Админ-токен кольца — только им читается `/zen/ring/payload`. */
  ZEN_RING_ADMIN_TOKEN?: string;
  /** Статическое кольцо `[{repo, token}]` — секрет, потому что в нём токены. */
  RING_TARGETS?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Store зависит от binding, а binding приходит только в запросе — поэтому gateway
    // собирается на каждый вызов, а не один раз на уровне модуля.
    const app = createGateway({
      config: {
        workerToken: env.WORKER_TOKEN,
        telegramUxWorkerToken: env.WORKER_TOKEN_TELEGRAM_UX,
        repo: env.GITHUB_REPO,
        workflow: env.GITHUB_WORKFLOW ?? 'run-agent.yml',
        ref: env.GITHUB_REF || undefined,
        publicBaseUrl: env.PUBLIC_BASE_URL.replace(/\/+$/, ''),
        agentBinary: env.AGENT_BINARY ?? 'opencode',
        githubToken: env.GITHUB_TOKEN,
        zenRingUrl: env.ZEN_RING_URL,
        zenRingAdminToken: env.ZEN_RING_ADMIN_TOKEN,
        // Статическое кольцо приходит **секретом**, а не переменной: в нём токены
        // репозиториев, а переменные воркера читаются в дашборде как обычный текст.
        ...(env.RING_TARGETS ? { ringTargets: parseRing(env.RING_TARGETS) } : {}),
      },
      store: new KvRunStore(env.RUNS),
      // Тот же KV держит курсор round-robin и кэш кольца: запросы попадают в разные
      // изоляты, и счётчик в памяти возвращал бы к первому репозиторию на каждом.
      kv: env.RUNS,
      // Тело `launch` содержит `llmKey`, поэтому в лог уходят только идентификаторы.
      log: (message, fields) => console.log(JSON.stringify({ level: 'info', message, ...fields })),
    });
    return app.fetch(request);
  },
};
