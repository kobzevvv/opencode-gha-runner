/**
 * Приёмка шлюза без сети и без GitHub: поднимает шлюз локально, прогоняет полный цикл
 * launch → poll → claim → result и проверяет, что контракт соблюдён на каждом шаге.
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
  repository: { fullName: 'vovalikessmoothy-png/opencode-gha-runner' },
  isolation: { mode: 'per_run_unix_identity' },
  outputs: [{ path: 'report.md', name: 'report.md', mime: 'text/markdown' }],
  credentials: { llmKey: 'smoke-llm-key-value' },
};

console.log('1. POST /v1/launch');
const launchResponse = await fetch(`${base}/v1/launch`, {
  method: 'POST',
  headers: { ...worker, 'content-type': 'application/json' },
  body: JSON.stringify(spec),
});
assert.equal(launchResponse.status, 202, 'launch обязан отвечать 202, а не ждать агента');
const launchBody = (await launchResponse.json()) as { status: string; pollUrl: string; githubRunId: number };
assert.equal(launchBody.status, 'started');
assert.equal(launchBody.githubRunId, 999);
console.log(`   → ${launchBody.status}, pollUrl=${launchBody.pollUrl}`);

console.log('2. В dispatch уехал только claim-токен');
assert.equal(dispatched.length, 1);
const dispatchPayload = JSON.stringify(dispatched[0]);
assert.ok(!dispatchPayload.includes('smoke-llm-key-value'), 'ключ LLM не должен уезжать в inputs');
assert.ok(!dispatchPayload.includes('Напиши отчёт'), 'промпт не должен уезжать в inputs');
assert.ok(!dispatchPayload.includes(GITHUB_TOKEN), 'токен GitHub не должен уезжать в inputs');
console.log(`   → ${dispatchPayload}`);

console.log('3. GET /v1/runs/{runId} до готовности — 202 без результата');
const pending = await fetch(`${base}/v1/runs/${runId}`, { headers: worker });
assert.equal(pending.status, 202);
assert.equal(((await pending.json()) as { result: unknown }).result, null);
console.log('   → 202, result=null');

console.log('4. POST /v1/claim — джоба забирает spec и ключ');
const claimResponse = await fetch(`${base}/v1/claim`, {
  method: 'POST',
  headers: { authorization: `Bearer ${dispatched[0]!.claimToken}`, 'content-type': 'application/json' },
  body: JSON.stringify({ runId }),
});
assert.equal(claimResponse.status, 200);
assert.equal(claimResponse.headers.get('cache-control'), 'no-store');
const claim = (await claimResponse.json()) as {
  llmKey: string;
  llmKeyEnvName: string;
  reportToken: string;
  reportUrl: string;
  spec: LaunchRequest;
};
assert.equal(claim.llmKey, 'smoke-llm-key-value');
assert.equal(claim.llmKeyEnvName, 'LLM_LADDER_TOKEN');
assert.equal(claim.spec.input.inlinePrompt, 'Напиши отчёт в report.md');
console.log(`   → llmKey получен, reportToken=${claim.reportToken.slice(0, 8)}…`);

console.log('5. Повторный claim того же токена — 409');
const replay = await fetch(`${base}/v1/claim`, {
  method: 'POST',
  headers: { authorization: `Bearer ${dispatched[0]!.claimToken}`, 'content-type': 'application/json' },
  body: JSON.stringify({ runId }),
});
assert.equal(replay.status, 409);
console.log('   → 409 claim_invalid');

console.log('6. POST /v1/runs/{runId}/result — джоба кладёт результат');
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
  artifacts: [
    {
      path: 'artifacts/report.md',
      name: 'report.md',
      mime: 'text/markdown',
      sha256: 'a'.repeat(64),
      size: 1234,
    },
  ],
  logUrl: 'https://storage.googleapis.com/bucket/run_smoke_0001/session.log',
  repo: { fullName: 'vovalikessmoothy-png/opencode-gha-runner', commit: 'abc123' },
};
const resultResponse = await fetch(`${base}/v1/runs/${runId}/result`, {
  method: 'POST',
  headers: { authorization: `Bearer ${claim.reportToken}`, 'content-type': 'application/json' },
  body: JSON.stringify(resultPayload),
});
assert.equal(resultResponse.status, 200);
console.log('   → 200 accepted');

console.log('7. GET /v1/runs/{runId} — 200 с результатом, runId из пути');
const done = await fetch(`${base}/v1/runs/${runId}`, { headers: worker });
assert.equal(done.status, 200);
const doneBody = (await done.json()) as { result: { runId: string; exitReason: string; artifacts: unknown[] } };
assert.equal(doneBody.result.runId, runId, 'runId в теле игнорируется');
assert.equal(doneBody.result.exitReason, 'completed');
assert.equal(doneBody.result.artifacts.length, 1);
console.log(`   → exitReason=${doneBody.result.exitReason}, artifacts=${doneBody.result.artifacts.length}`);

console.log('8. Ключ LLM вычищен из хранилища');
const stored = await store.get(runId);
assert.ok(stored);
assert.ok(!JSON.stringify(stored).includes('smoke-llm-key-value'), 'ключ не должен оставаться в ране');
console.log('   → ключа в хранилище нет');

console.log('9. Отмена завершённого рана идемпотентна и не трогает GitHub');
const cancelDone = await fetch(`${base}/v1/runs/${runId}/cancel`, { method: 'POST', headers: worker });
assert.equal(cancelDone.status, 200);
assert.equal(((await cancelDone.json()) as { status: string }).status, 'finished');
assert.deepEqual(cancelled, [], 'у завершённого рана нечего отменять');

console.log('10. POST /v1/runs/{runId}/cancel на живом ране гасит GitHub-прогон');
const liveRunId = 'run_smoke_0002';
await fetch(`${base}/v1/launch`, {
  method: 'POST',
  headers: { ...worker, 'content-type': 'application/json' },
  body: JSON.stringify({ ...spec, runId: liveRunId }),
});
const cancelResponse = await fetch(`${base}/v1/runs/${liveRunId}/cancel`, { method: 'POST', headers: worker });
assert.equal(cancelResponse.status, 200);
assert.deepEqual(cancelled, [999]);
console.log('   → cancelled');

console.log('11. Отказ без авторизации — 401');
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
