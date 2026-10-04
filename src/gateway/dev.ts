/**
 * Локальный запуск шлюза: `npm run dev`.
 *
 * Ничего не подставляет «по умолчанию» из небезопасных значений: без `WORKER_TOKEN`
 * и `GITHUB_TOKEN` процесс падает на старте, а не поднимается с пустым секретом.
 */

import { MemoryRunStore } from './store.js';
import { configFromEnv, startNodeServer } from './node-server.js';

const config = configFromEnv();
const server = await startNodeServer({
  config,
  store: new MemoryRunStore(),
  port: Number(process.env['PORT'] ?? '8787'),
  log: (message, fields) => {
    // Тело launch/claim с `llmKey` в лог не пишется — только идентификаторы.
    console.log(JSON.stringify({ level: 'info', message, ...fields }));
  },
});

console.log(
  JSON.stringify({
    level: 'info',
    message: 'gateway listening',
    url: server.url,
    repo: config.repo,
    workflow: config.workflow,
  }),
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
