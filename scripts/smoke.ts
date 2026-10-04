/**
 * Приёмка шлюза без сети и без GitHub: поднимает шлюз локально и прогоняет полный
 * асинхронный цикл контракта — launch → receipt → status → claim → report → result →
 * callback в наш API — проверяя, что контракт соблюдён на каждом шаге.
 *
 * Запуск: `npm run smoke`. Ничего не деплоит и не дёргает GitHub.
 */

import assert from 'node:assert/strict';
import { MemoryRunStore } from '../src/gateway/store.js';
import { startNodeServer } from '../src/gateway/node-server.js';
import { ENGINE_NAME, type LaunchRequest } from '../src/contracts.js';

const WORKER_TOKEN = 'smoke-worker-token';
const GITHUB_TOKEN = 'smoke-github-token';
const runId = 'run_smoke_0001';

const dispatched: Array<{ runId: string; claimToken: string }> = [];
const cancelled: number[] = [];
/** Что шлюз переслал нашему API на `resultUrl` — проверяем сам callback. */
const delivered: Array<{ url: string; auth: string | null; body: unknown }> = [];

const github = {
  dispatchWorkflow: async (input: { runId: string; claimToken: string }) => {
    dispatched.push(input);
    return { runId: 999, htmlUrl: 'https://github.com/example/repo/actions/runs/999' };
  },
  cancelWorkflowRun: async (runId: number) => {
    cancelled.push(runId);
    return { cancelled: true, reason: 'cancelled' as const };
  },
};

const store = new MemoryRunStore();
// Порт фиксированный, а не 0: `publicBaseUrl` участвует в `pollUrl`, который
// шлюз возвращает в ответе, и он должен совпадать с тем, куда реально можно дойти.
const PORT = 18_787;
const server = await startNodeServer({
  config: {
    workerToken: WORKER_TOKEN,
    repo: 'vovalikessmoothy-png/opencode-gha-runner',
    workflow: 'run-agent.yml',
    publicBaseUrl: `http://127.0.0.1:${PORT}`,
    agentBinary: 'opencode',
    githubToken: GITHUB_TOKEN,
  },
  store,
  github: github as never,
  // Callback в наш API перехватываем: приёмка не должна стучаться в интернет.
  fetchImpl: (async (url: string | URL, init?: RequestInit) => {
    delivered.push({
      url: String(url),
      auth: (init?.headers as Record<string, string> | undefined)?.['authorization'] ?? null,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch,
  port: PORT,
  log: (message, fields) => console.log(`  [gateway] ${message}`, JSON.stringify(fields ?? {})),
});

const base = server.url;
console.log(`Gateway: ${base}\n`);
const worker = { authorization: `Bearer ${WORKER_TOKEN}` };

const spec: LaunchRequest = {
  runId,
  jobId: 'job-smoke',
  userTaskId: 'task-smoke',
  profileId: 'profile-smoke',
  conversationId: 'conv-smoke',
  operationId: 'op-smoke',
  ownerGeneration: 1,
  engine: { name: ENGINE_NAME, adapterVersion: '1', modelSettings: { model: 'free' } },
  input: { inlinePrompt: 'Напиши отчёт в report.md' },
  cwd: '/home/runner/work/repo/repo',
  envAllowlist: ['PATH', 'HOME', 'LLM_LADDER_TOKEN'],
  env: { PATH: '/usr/bin', HOME: '/home/runner' },
  limits: { timeoutMs: 300_000, maxOutputBytes: 1_048_576, maxLogBytes: 1_048_576 },
  repository: { fullName: 'vovalikessmoothy-png/opencode-gha-runner', branch: `agent-run/${runId}` },
  resultUrl: 'https://api.example/v1/worker/launches/run_smoke_0001/result',
  isolation: { mode: 'per_run_unix_identity' },
  outputs: [{ path: 'report.md', name: 'report.md', mime: 'text/markdown' }],
  credentials: { llmKey: 'smoke-llm-key-value' },
};

console.log('1. POST /v1/launch — квитанция, а не результат');
const launchResponse = await fetch(`${base}/v1/launch`, {
  method: 'POST',
  headers: { ...worker, 'content-type': 'application/json' },
  body: JSON.stringify(spec),
});
assert.equal(launchResponse.status, 202, 'launch обязан отвечать 202, а не ждать агента');
const launchBody = (await launchResponse.json()) as {
  runId: string; operationId: string; status: string; statusUrl: string; resultUrl: string;
};
assert.equal(launchBody.status, 'accepted');
assert.equal(launchBody.runId, runId);
assert.equal(launchBody.statusUrl, `${base}/v1/runs/${runId}/status`);
assert.equal(launchBody.resultUrl, `${base}/v1/runs/${runId}/result`);
console.log(`   → accepted, statusUrl=${launchBody.statusUrl}`);

console.log('2. В dispatch уехал только claim-токен');
assert.equal(dispatched.length, 1);
const dispatchPayload = JSON.stringify(dispatched[0]);
assert.ok(!dispatchPayload.includes('smoke-llm-key-value'), 'ключ LLM не должен уезжать в inputs');
assert.ok(!dispatchPayload.includes('Напиши отчёт'), 'промпт не должен уезжать в inputs');
assert.ok(!dispatchPayload.includes(GITHUB_TOKEN), 'токен GitHub не должен уезжать в inputs');
console.log(`   → ${dispatchPayload}`);

console.log('3. GET /status до claim — accepted');
const acceptedStatus = await fetch(`${base}/v1/runs/${runId}/status`, { headers: worker });
assert.equal(acceptedStatus.status, 200);
assert.equal(((await acceptedStatus.json()) as { status: string }).status, 'accepted');
console.log('   → accepted');

console.log('4. GET /result до готовности — 409, а не пустое тело');
const notReady = await fetch(`${base}/v1/runs/${runId}/result`, { headers: worker });
assert.equal(notReady.status, 409);
console.log('   → 409 not_ready');

console.log('5. POST /v1/claim — джоба забирает spec и ключ');
const claimResponse = await fetch(`${base}/v1/claim`, {
  method: 'POST',
  headers: { authorization: `Bearer ${dispatched[0]!.claimToken}`, 'content-type': 'application/json' },
  body: JSON.stringify({ runId }),
});
assert.equal(claimResponse.status, 200);
assert.equal(claimResponse.headers.get('cache-control'), 'no-store');
const claim = (await claimResponse.json()) as {
  llmKey: string; llmKeyEnvName: string; reportToken: string; reportUrl: string; spec: LaunchRequest;
};
assert.equal(claim.llmKey, 'smoke-llm-key-value');
assert.equal(claim.llmKeyEnvName, 'LLM_LADDER_TOKEN');
assert.equal(claim.reportUrl, `${base}/v1/runs/${runId}/report`, 'отчёт джобы идёт на внутренний маршрут');
console.log(`   → llmKey получен, reportToken=${claim.reportToken.slice(0, 8)}…`);

console.log('6. GET /status после claim — running');
const runningStatus = await fetch(`${base}/v1/runs/${runId}/status`, { headers: worker });
assert.equal(((await runningStatus.json()) as { status: string }).status, 'running');
console.log('   → running');

console.log('7. Повторный claim того же токена — 409');
const replay = await fetch(`${base}/v1/claim`, {
  method: 'POST',
  headers: { authorization: `Bearer ${dispatched[0]!.claimToken}`, 'content-type': 'application/json' },
  body: JSON.stringify({ runId }),
});
assert.equal(replay.status, 409);
console.log('   → 409 claim_invalid');

console.log('8. POST /v1/runs/{runId}/report — джоба кладёт результат');
const resultPayload = {
  runId: 'подделанный',
  status: 'succeeded',
  exitCode: 0,
  exitSignal: null,
  exitReason: 'completed',
  stdout: 'готово, отчёт в report.md',
  stderr: '',
  answer: 'Готово, отчёт в report.md',
  answerSource: 'engine_stdout',
  durationMs: 45_230,
  timedOut: false,
  outputTruncated: false,
  artifacts: [{ path: 'artifacts/report.md', name: 'report.md', mime: 'text/markdown', sha256: 'a'.repeat(64), size: 1234 }],
  logUrl: 'https://storage.googleapis.com/bucket/run_smoke_0001/session.log',
  repo: { fullName: 'vovalikessmoothy-png/opencode-gha-runner', branch: `agent-run/${runId}`, commit: 'abc123' },
};
const resultResponse = await fetch(`${base}/v1/runs/${runId}/report`, {
  method: 'POST',
  headers: { authorization: `Bearer ${claim.reportToken}`, 'content-type': 'application/json' },
  body: JSON.stringify(resultPayload),
});
assert.equal(resultResponse.status, 200);
console.log('   → 200 accepted');

console.log('9. Результат переслан нашему API на resultUrl с общим секретом');
assert.equal(delivered.length, 1, 'без пересылки наш API ждал бы watchdog');
assert.equal(delivered[0]!.url, spec.resultUrl);
assert.equal(delivered[0]!.auth, `Bearer ${WORKER_TOKEN}`);
console.log(`   → POST ${delivered[0]!.url} (Bearer …)`);

console.log('10. GET /result — 200 с результатом, runId из пути');
const done = await fetch(`${base}/v1/runs/${runId}/result`, { headers: worker });
assert.equal(done.status, 200);
const doneBody = (await done.json()) as { runId: string; exitReason: string; artifacts: unknown[] };
assert.equal(doneBody.runId, runId, 'runId в теле игнорируется');
assert.equal(doneBody.exitReason, 'completed');
assert.equal(doneBody.artifacts.length, 1);
console.log(`   → exitReason=${doneBody.exitReason}, artifacts=${doneBody.artifacts.length}`);

console.log('11. GET /status — succeeded');
const succeeded = (await (await fetch(`${base}/v1/runs/${runId}/status`, { headers: worker })).json()) as { status: string };
assert.equal(succeeded.status, 'succeeded');
console.log('   → succeeded');

console.log('12. Ключ LLM вычищен из хранилища');
const stored = await store.get(runId);
assert.ok(stored);
assert.ok(!JSON.stringify(stored).includes('smoke-llm-key-value'), 'ключ не должен оставаться в ране');
console.log('   → ключа в хранилище нет');

console.log('13. Дедупликация: повтор launch с тем же operationId — та же квитанция');
const replayLaunch = await fetch(`${base}/v1/launch`, {
  method: 'POST',
  headers: { ...worker, 'content-type': 'application/json' },
  body: JSON.stringify({ ...spec, runId: 'run_smoke_duplicate' }),
});
assert.equal(replayLaunch.status, 202);
assert.equal(((await replayLaunch.json()) as { runId: string }).runId, runId, 'повтор обязан вернуть тот же runId');
assert.equal(dispatched.length, 1, 'второй GHA-прогон — ровно тот дефект, который контракт исключает');
console.log('   → тот же runId, второго диспатча нет');

console.log('14. cancel неизвестного рана — unknown_run');
const unknownCancel = await fetch(`${base}/v1/runs/run_нет/cancel`, { method: 'POST', headers: worker });
assert.equal(unknownCancel.status, 200);
assert.equal(((await unknownCancel.json()) as { status: string }).status, 'unknown_run');
console.log('   → unknown_run');

console.log('15. Отказ без авторизации — 401');
const unauthorized = await fetch(`${base}/v1/launch`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(spec),
});
assert.equal(unauthorized.status, 401);
console.log('   → 401');

console.log('\nSMOKE OK: контракт соблюдён на всех шагах');

// Явно закрываем сервер: иначе слушающий сокет держит event loop и процесс не выйдет.
await server.close();
