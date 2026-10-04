/**
 * Роуты шлюза под асинхронный контракт (issue #73 / docs/EXTERNAL-WORKER-CONTRACT.md):
 * receipt → status → result, дедупликация по `operationId`, callback в наш API.
 *
 * GitHub замокан целиком — тест не должен зависеть от сети и от того, есть ли у нас
 * лишний запуск workflow в месяц.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGateway, type GatewayConfig } from '../src/gateway/app.js';
import type { DispatchResult, GitHubClient } from '../src/gateway/github.js';
import { MemoryRunStore } from '../src/gateway/store.js';
import { validLaunchRequest } from './contracts.test.js';

const WORKER_TOKEN = 'worker-token-for-tests';
const API_RESULT_URL = 'https://api.example/v1/worker/launches/run_x/result';
const config: GatewayConfig = {
  workerToken: WORKER_TOKEN,
  repo: 'vovalikessmoothy-png/opencode-gha-runner',
  workflow: 'run-agent.yml',
  publicBaseUrl: 'https://worker.example',
  agentBinary: 'opencode',
  githubToken: 'github-token',
};

interface Harness {
  fetch: (request: Request) => Promise<Response>;
  store: MemoryRunStore;
  dispatched: Array<{ runId: string; claimToken: string }>;
  cancelled: number[];
  /** Что шлюз переслал нашему API на `resultUrl`. */
  delivered: Array<{ url: string; auth: string | null; body: unknown }>;
}

function harness(options: { dispatchThrows?: boolean; deliveryStatus?: number } = {}): Harness {
  const store = new MemoryRunStore();
  const dispatched: Array<{ runId: string; claimToken: string }> = [];
  const cancelled: number[] = [];
  const delivered: Array<{ url: string; auth: string | null; body: unknown }> = [];
  let counter = 0;

  const github = {
    dispatchWorkflow: async (input: { runId: string; claimToken: string }): Promise<DispatchResult> => {
      if (options.dispatchThrows) throw new Error('boom 500 from github');
      dispatched.push(input);
      return { runId: 4242, htmlUrl: 'https://github.com/x/y/actions/runs/4242' };
    },
    cancelWorkflowRun: async (runId: number) => {
      cancelled.push(runId);
      return { cancelled: true, reason: 'cancelled' as const };
    },
  } as unknown as GitHubClient;

  const app = createGateway({
    config,
    store,
    github,
    randomToken: () => {
      counter += 1;
      return `token-${counter}`;
    },
    // Callback в наш API перехватываем: тест не должен стучаться в интернет.
    fetchImpl: (async (url: string | URL, init?: RequestInit) => {
      delivered.push({
        url: String(url),
        auth: (init?.headers as Record<string, string> | undefined)?.['authorization'] ?? null,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return new Response('{}', { status: options.deliveryStatus ?? 200 });
    }) as unknown as typeof fetch,
  });

  return { fetch: app.fetch, store, dispatched, cancelled, delivered };
}

const spec = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...validLaunchRequest(over as never),
  resultUrl: API_RESULT_URL,
});

const launch = (body: unknown, token: string | null = WORKER_TOKEN): Request =>
  new Request('https://worker.example/v1/launch', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });

const get = (path: string, token: string | null = WORKER_TOKEN): Request =>
  new Request(`https://worker.example${path}`, {
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });

const post = (path: string, body: unknown, token: string | null = WORKER_TOKEN): Request =>
  new Request(`https://worker.example${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });

const RUN_ID = validLaunchRequest()['runId'] as string;

/** Доводит ран до терминального: claim → report. */
async function finish(
  h: Harness,
  result: Record<string, unknown> = {},
): Promise<void> {
  const claim = (await (
    await h.fetch(post('/v1/claim', { runId: RUN_ID }, h.dispatched[0]!.claimToken))
  ).json()) as { reportToken: string };
  await h.fetch(
    post(`/v1/runs/${RUN_ID}/report`, {
      status: 'succeeded',
      exitCode: 0,
      exitSignal: null,
      exitReason: 'completed',
      stdout: 'готово',
      stderr: '',
      answerSource: 'engine_stdout',
      durationMs: 1234,
      timedOut: false,
      outputTruncated: false,
      artifacts: [],
      logUrl: 'https://storage.googleapis.com/bucket/run/session.log',
      repo: { fullName: 'owner/name', branch: `agent-run/${RUN_ID}`, commit: 'abc123' },
      ...result,
    }, claim.reportToken),
  );
}

// ── launch: квитанция ──────────────────────────────────────────────────────────

test('launch отвечает квитанцией accepted, а не результатом', async () => {
  const h = harness();
  const response = await h.fetch(launch(spec()));
  assert.equal(response.status, 202);
  const body = (await response.json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ['operationId', 'resultUrl', 'runId', 'status', 'statusUrl']);
  assert.equal(body['status'], 'accepted');
  assert.equal(body['runId'], RUN_ID);
  assert.equal(body['statusUrl'], `https://worker.example/v1/runs/${RUN_ID}/status`);
  assert.equal(body['resultUrl'], `https://worker.example/v1/runs/${RUN_ID}/result`);
  assert.equal(h.dispatched.length, 1);
});

test('launch без токена — 401', async () => {
  const h = harness();
  assert.equal((await h.fetch(launch(spec(), null))).status, 401);
  assert.equal(h.dispatched.length, 0);
});

test('launch с некорректным телом — 400 со списком проблем', async () => {
  const h = harness();
  const response = await h.fetch(launch({ runId: 'run-1' }));
  assert.equal(response.status, 400);
  assert.equal(((await response.json()) as { error: string }).error, 'invalid_launch_request');
});

test('в dispatch уходит только claim-токен: ни промпта, ни ключа', async () => {
  const h = harness();
  await h.fetch(launch(spec({ credentials: { llmKey: 'llm-key-should-not-leak' } })));
  const serialized = JSON.stringify(h.dispatched);
  assert.deepEqual(Object.keys(h.dispatched[0]!).sort(), ['claimToken', 'runId']);
  assert.ok(!serialized.includes('llm-key-should-not-leak'));
  assert.ok(!serialized.includes('Сделай задачу'));
  assert.ok(!serialized.includes('github-token'));
});

test('дедупликация по operationId: повтор не поднимает второй ран', async () => {
  const h = harness();
  const first = (await (await h.fetch(launch(spec()))).json()) as Record<string, unknown>;
  // Тот же operationId, но другой runId — так выглядит повторная доставка от нашего API.
  const second = (await (await h.fetch(launch(spec({ runId: 'run_other_0002' })))).json()) as Record<string, unknown>;

  assert.equal(h.dispatched.length, 1, 'второй GHA-прогон — это ровно тот дефект, который контракт исключает');
  assert.equal(second['runId'], first['runId'], 'повтор обязан вернуть тот же runId');
  assert.equal(second['operationId'], first['operationId']);
});

test('неудачный диспатч — 502 и запись снята, чтобы повтор сработал', async () => {
  const h = harness({ dispatchThrows: true });
  const response = await h.fetch(launch(spec()));
  assert.equal(response.status, 502);
  assert.equal(((await response.json()) as { failure: { code: string } }).failure.code, 'WORKER_INTERNAL');

  // Если бы запись осталась, повтор с тем же operationId задедуплицировался бы в мёртвый ран.
  assert.equal(await h.store.get(RUN_ID), null);
  const retry = harness();
  assert.equal((await retry.fetch(launch(spec()))).status, 202);
});

// ── status ─────────────────────────────────────────────────────────────────────

test('status: accepted сразу после запуска, running после claim', async () => {
  const h = harness();
  await h.fetch(launch(spec()));

  const accepted = (await (await h.fetch(get(`/v1/runs/${RUN_ID}/status`))).json()) as Record<string, unknown>;
  assert.equal(accepted['status'], 'accepted');
  assert.equal(accepted['runId'], RUN_ID);
  assert.ok(typeof accepted['updatedAt'] === 'string');

  await h.fetch(post('/v1/claim', { runId: RUN_ID }, h.dispatched[0]!.claimToken));
  const running = (await (await h.fetch(get(`/v1/runs/${RUN_ID}/status`))).json()) as Record<string, unknown>;
  assert.equal(running['status'], 'running');
});

test('status завершённого рана — succeeded', async () => {
  const h = harness();
  await h.fetch(launch(spec()));
  await finish(h);
  const body = (await (await h.fetch(get(`/v1/runs/${RUN_ID}/status`))).json()) as Record<string, unknown>;
  assert.equal(body['status'], 'succeeded');
});

test('status неизвестного рана — unknown, а не 404: наш API идёт в reconcile', async () => {
  const h = harness();
  const response = await h.fetch(get('/v1/runs/run_нет_такого/status'));
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as { status: string }).status, 'unknown');
});

test('status без авторизации — 401', async () => {
  const h = harness();
  assert.equal((await h.fetch(get(`/v1/runs/${RUN_ID}/status`, null))).status, 401);
});

// ── result ─────────────────────────────────────────────────────────────────────

test('result до готовности — 409, после — LaunchResult', async () => {
  const h = harness();
  await h.fetch(launch(spec()));

  const notReady = await h.fetch(get(`/v1/runs/${RUN_ID}/result`));
  assert.equal(notReady.status, 409);
  assert.equal(((await notReady.json()) as { status: string }).status, 'not_ready');

  await finish(h);
  const ready = await h.fetch(get(`/v1/runs/${RUN_ID}/result`));
  assert.equal(ready.status, 200);
  const result = (await ready.json()) as { runId: string; exitReason: string; repo: { branch: string } };
  assert.equal(result.runId, RUN_ID);
  assert.equal(result.exitReason, 'completed');
  assert.equal(result.repo.branch, `agent-run/${RUN_ID}`);
});

test('runId берётся из пути, а не из тела отчёта', async () => {
  const h = harness();
  await h.fetch(launch(spec()));
  await finish(h, { runId: 'подделанный' });
  const result = (await (await h.fetch(get(`/v1/runs/${RUN_ID}/result`))).json()) as { runId: string };
  assert.equal(result.runId, RUN_ID);
});

test('отчёт по чужому report-токену — 401', async () => {
  const h = harness();
  await h.fetch(launch(spec()));
  const response = await h.fetch(post(`/v1/runs/${RUN_ID}/report`, { status: 'succeeded' }, 'wrong-token'));
  assert.equal(response.status, 401);
});

// ── callback в наш API ─────────────────────────────────────────────────────────

test('результат пересылается нашему API на resultUrl с общим секретом', async () => {
  const h = harness();
  await h.fetch(launch(spec()));
  await finish(h);

  assert.equal(h.delivered.length, 1, 'без пересылки наш API ждал бы watchdog');
  assert.equal(h.delivered[0]!.url, API_RESULT_URL);
  assert.equal(h.delivered[0]!.auth, `Bearer ${WORKER_TOKEN}`, 'тот же секрет, которым аутентифицировали launch');
  assert.equal((h.delivered[0]!.body as { exitReason: string }).exitReason, 'completed');
});

test('неудачная пересылка не роняет приём: результат остаётся в воркере', async () => {
  const h = harness({ deliveryStatus: 500 });
  await h.fetch(launch(spec()));
  await finish(h);
  // Приём всё равно 200 — иначе джоба считала бы отчёт непринятым и повторяла бы его.
  assert.equal((await h.fetch(get(`/v1/runs/${RUN_ID}/result`))).status, 200);
  assert.ok(h.delivered.length >= 1, 'пересылка всё же была попытка');
});

test('после завершения в хранилище не остаётся ключа LLM', async () => {
  const h = harness();
  await h.fetch(launch(spec({ credentials: { llmKey: 'llm-key-value-123' } })));
  await finish(h);
  const stored = await h.store.get(RUN_ID);
  assert.ok(stored);
  assert.equal(stored!.request.credentials, undefined);
  assert.deepEqual(stored!.request.env, {});
  assert.ok(!JSON.stringify(stored).includes('llm-key-value-123'));
});

// ── cancel ─────────────────────────────────────────────────────────────────────

test('cancel живого рана гасит GitHub-прогон и делает его терминальным', async () => {
  const h = harness();
  await h.fetch(launch(spec()));
  const response = await h.fetch(post(`/v1/runs/${RUN_ID}/cancel`, {}));
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as { status: string }).status, 'cancelled');
  assert.deepEqual(h.cancelled, [4242]);

  // Результат отмены читается из /result, а не из пустоты.
  const status = (await (await h.fetch(get(`/v1/runs/${RUN_ID}/status`))).json()) as { status: string };
  assert.equal(status.status, 'cancelled');
  const result = (await (await h.fetch(get(`/v1/runs/${RUN_ID}/result`))).json()) as { exitReason: string };
  assert.equal(result.exitReason, 'cancelled');
});

test('cancel неизвестного рана — unknown_run', async () => {
  const h = harness();
  const response = await h.fetch(post('/v1/runs/run_нет/cancel', {}));
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as { status: string }).status, 'unknown_run');
});

test('cancel без авторизации не гасит ничего', async () => {
  const h = harness();
  await h.fetch(launch(spec()));
  assert.equal((await h.fetch(post(`/v1/runs/${RUN_ID}/cancel`, {}, null))).status, 401);
  assert.deepEqual(h.cancelled, []);
});

// ── прочее ─────────────────────────────────────────────────────────────────────

test('healthz без авторизации', async () => {
  const h = harness();
  const response = await h.fetch(new Request('https://worker.example/healthz'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('claim отдаёт spec с ключом и гасит токен', async () => {
  const h = harness();
  await h.fetch(launch(spec({ credentials: { llmKey: 'llm-key-value-123' } })));
  const claimToken = h.dispatched[0]!.claimToken;

  const response = await h.fetch(post('/v1/claim', { runId: RUN_ID }, claimToken));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const claim = (await response.json()) as { llmKey: string; reportUrl: string };
  assert.equal(claim.llmKey, 'llm-key-value-123');
  assert.equal(claim.reportUrl, `https://worker.example/v1/runs/${RUN_ID}/report`);

  assert.equal((await h.fetch(post('/v1/claim', { runId: RUN_ID }, claimToken))).status, 409);
});

test('неизвестный путь — 404', async () => {
  const h = harness();
  assert.equal((await h.fetch(get('/v1/nope'))).status, 404);
});
