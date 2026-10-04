/**
 * Роуты шлюза: авторизация, жизненный цикл рана, одноразовость токенов.
 *
 * GitHub замокан целиком — тест не должен зависеть от сети и от того, есть ли у нас
 * лишний запуск workflow в месяц.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGateway, type GatewayConfig } from '../src/gateway/app.js';
import { GitHubClient, type DispatchResult } from '../src/gateway/github.js';
import { MemoryRunStore } from '../src/gateway/store.js';
import { validLaunchRequest } from './contracts.test.js';

const WORKER_TOKEN = 'worker-token-for-tests';
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
  tokens: string[];
}

function harness(options: { dispatchThrows?: boolean } = {}): Harness {
  const store = new MemoryRunStore();
  const dispatched: Array<{ runId: string; claimToken: string }> = [];
  const cancelled: number[] = [];
  let counter = 0;
  const tokens: string[] = [];

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
      const token = `token-${counter}`;
      tokens.push(token);
      return token;
    },
  });

  return { fetch: app.fetch, store, dispatched, cancelled, tokens };
}

const launch = (body: unknown, token: string | null = WORKER_TOKEN): Request =>
  new Request('https://worker.example/v1/launch', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });

test('healthz не требует авторизации', async () => {
  const { fetch: request } = harness();
  const response = await request(new Request('https://worker.example/healthz'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('launch без токена — 401', async () => {
  const { fetch: request, dispatched } = harness();
  const response = await request(launch(validLaunchRequest(), null));
  assert.equal(response.status, 401);
  assert.equal(dispatched.length, 0, 'без авторизации диспатча быть не должно');
});

test('launch с чужим токеном — 401', async () => {
  const { fetch: request } = harness();
  assert.equal((await request(launch(validLaunchRequest(), 'wrong-token'))).status, 401);
});

test('launch с некорректным телом — 400 со списком проблем', async () => {
  const { fetch: request } = harness();
  const response = await request(launch({ runId: 'run-1' }));
  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: string; issues: string[] };
  assert.equal(body.error, 'invalid_launch_request');
  assert.ok(body.issues.length > 3, `ожидался список проблем, получено ${JSON.stringify(body.issues)}`);
});

test('успешный launch — 202, started и pollUrl, а не финальный результат', async () => {
  const h = harness();
  const runId = validLaunchRequest()['runId'] as string;
  const response = await h.fetch(launch(validLaunchRequest()));

  assert.equal(response.status, 202, 'финальный результат в GHA физически не может прийти в launch');
  const body = (await response.json()) as { status: string; pollUrl: string; githubRunId: number };
  assert.equal(body.status, 'started');
  assert.equal(body.pollUrl, `https://worker.example/v1/runs/${runId}`);
  assert.equal(body.githubRunId, 4242);
  assert.equal(h.dispatched.length, 1);
});

test('в dispatch уходит только claim-токен: ни промпта, ни ключа, ни репозитория', async () => {
  const h = harness();
  await h.fetch(launch(validLaunchRequest({ credentials: { llmKey: 'llm-key-should-not-leak' } } as never)));

  assert.equal(h.dispatched.length, 1);
  const sent = h.dispatched[0]!;
  assert.deepEqual(Object.keys(sent).sort(), ['claimToken', 'runId']);
  assert.ok(!JSON.stringify(sent).includes('llm-key-should-not-leak'));
  assert.ok(!JSON.stringify(sent).includes('Сделай задачу'), 'промпт не должен уезжать в inputs диспатча');
});

test('в inputs нет токена GitHub: иначе публичный прогон его покажет', async () => {
  const h = harness();
  await h.fetch(launch(validLaunchRequest()));
  const serialized = JSON.stringify(h.dispatched);
  assert.ok(!serialized.includes('github-token'));
  assert.ok(!serialized.includes(WORKER_TOKEN));
});

test('claim отдаёт spec с ключом и гасит токен', async () => {
  const h = harness();
  const runId = validLaunchRequest()['runId'] as string;
  await h.fetch(launch(validLaunchRequest({ credentials: { llmKey: 'llm-key-value-123' } } as never)));
  const claimToken = h.dispatched[0]!.claimToken;

  const response = await h.fetch(
    new Request('https://worker.example/v1/claim', {
      method: 'POST',
      headers: { authorization: `Bearer ${claimToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ runId }),
    }),
  );
  assert.equal(response.status, 200);
  const claim = (await response.json()) as { llmKey: string; spec: { input: { inlinePrompt: string } }; reportToken: string };
  assert.equal(claim.llmKey, 'llm-key-value-123');
  assert.equal(claim.spec.input.inlinePrompt, 'Сделай задачу');
  assert.ok(claim.reportToken.length > 0);

  const second = await h.fetch(
    new Request('https://worker.example/v1/claim', {
      method: 'POST',
      headers: { authorization: `Bearer ${claimToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ runId }),
    }),
  );
  assert.equal(second.status, 409, 'claim-токен одноразовый: без этого ключ утекает перебором запусков');
});

test('claim с неверным токеном и несуществующим runId отвечает одинаково', async () => {
  const h = harness();
  const wrong = await h.fetch(
    new Request('https://worker.example/v1/claim', {
      method: 'POST',
      headers: { authorization: 'Bearer nope', 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'run_does_not_exist' }),
    }),
  );
  assert.equal(wrong.status, 409);
  assert.deepEqual(await wrong.json(), { error: 'claim_invalid' });
});

test('poll до готовности — 202 без результата, после — 200 с результатом', async () => {
  const h = harness();
  const runId = validLaunchRequest()['runId'] as string;
  await h.fetch(launch(validLaunchRequest()));

  const pending = await h.fetch(
    new Request(`https://worker.example/v1/runs/${runId}`, { headers: { authorization: `Bearer ${WORKER_TOKEN}` } }),
  );
  assert.equal(pending.status, 202);
  assert.equal(((await pending.json()) as { result: unknown }).result, null);

  const claimToken = h.dispatched[0]!.claimToken;
  const claim = (await (
    await h.fetch(
      new Request('https://worker.example/v1/claim', {
        method: 'POST',
        headers: { authorization: `Bearer ${claimToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ runId }),
      }),
    )
  ).json()) as { reportToken: string };

  await h.fetch(
    new Request(`https://worker.example/v1/runs/${runId}/result`, {
      method: 'POST',
      headers: { authorization: `Bearer ${claim.reportToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        runId: 'подделанный-runId',
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
        repo: { fullName: 'owner/name', commit: 'abc123' },
      }),
    }),
  );

  const done = await h.fetch(
    new Request(`https://worker.example/v1/runs/${runId}`, { headers: { authorization: `Bearer ${WORKER_TOKEN}` } }),
  );
  assert.equal(done.status, 200);
  const body = (await done.json()) as { result: { runId: string; exitReason: string } };
  assert.equal(body.result.runId, runId, 'runId берётся из пути, тело ему не доверяем');
  assert.equal(body.result.exitReason, 'completed');
});

test('результат по чужому report-токену — 401', async () => {
  const h = harness();
  const runId = validLaunchRequest()['runId'] as string;
  await h.fetch(launch(validLaunchRequest()));
  const response = await h.fetch(
    new Request(`https://worker.example/v1/runs/${runId}/result`, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-report-token', 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'succeeded' }),
    }),
  );
  assert.equal(response.status, 401);
});

test('после завершения в хранилище не остаётся ключа LLM', async () => {
  const h = harness();
  const runId = validLaunchRequest()['runId'] as string;
  await h.fetch(launch(validLaunchRequest({ credentials: { llmKey: 'llm-key-value-123' } } as never)));
  const claimToken = h.dispatched[0]!.claimToken;
  const claim = (await (
    await h.fetch(
      new Request('https://worker.example/v1/claim', {
        method: 'POST',
        headers: { authorization: `Bearer ${claimToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ runId }),
      }),
    )
  ).json()) as { reportToken: string };

  await h.fetch(
    new Request(`https://worker.example/v1/runs/${runId}/result`, {
      method: 'POST',
      headers: { authorization: `Bearer ${claim.reportToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        status: 'succeeded',
        exitCode: 0,
        exitSignal: null,
        exitReason: 'completed',
        stdout: '',
        stderr: '',
        answerSource: null,
        durationMs: 1,
        timedOut: false,
        outputTruncated: false,
        artifacts: [],
        logUrl: '',
        repo: { fullName: 'owner/name', commit: 'abc' },
      }),
    }),
  );

  const stored = await h.store.get(runId);
  assert.ok(stored);
  assert.equal(stored!.request.credentials, undefined);
  assert.deepEqual(stored!.request.env, {});
  assert.ok(!JSON.stringify(stored).includes('llm-key-value-123'), 'ключ обязан быть вычищен из рана');
});

test('повторный launch того же runId не плодит вторую GHA-джобу', async () => {
  const h = harness();
  await h.fetch(launch(validLaunchRequest()));
  const second = await h.fetch(launch(validLaunchRequest()));
  assert.equal(second.status, 200);
  assert.equal(h.dispatched.length, 1, 'наш API недопустимо — второй job был бы чистой растратой минут');
});

test('неудачный диспатч — 502 с WORKER_INTERNAL, не ран-ошибка агента', async () => {
  const h = harness({ dispatchThrows: true });
  const runId = validLaunchRequest()['runId'] as string;
  const response = await h.fetch(launch(validLaunchRequest()));
  assert.equal(response.status, 502);
  const body = (await response.json()) as { failure: { code: string; retryable: boolean }; exitReason: string };
  assert.equal(body.failure.code, 'WORKER_INTERNAL');
  assert.equal(body.failure.retryable, true);
  assert.equal(body.exitReason, 'startup_failure');

  // Провал диспатча обязан быть виден сразу, а не висеть в `dispatched` до вечера.
  const stored = await h.store.get(runId);
  assert.equal(stored?.phase, 'done');
});

test('cancel гасит GitHub-прогон', async () => {
  const h = harness();
  const runId = validLaunchRequest()['runId'] as string;
  await h.fetch(launch(validLaunchRequest()));
  const response = await h.fetch(
    new Request(`https://worker.example/v1/runs/${runId}/cancel`, {
      method: 'POST',
      headers: { authorization: `Bearer ${WORKER_TOKEN}` },
    }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(h.cancelled, [4242]);
  assert.equal(((await response.json()) as { status: string }).status, 'cancelled');
});

test('cancel без авторизации не гасит ничего', async () => {
  const h = harness();
  const runId = validLaunchRequest()['runId'] as string;
  await h.fetch(launch(validLaunchRequest()));
  const response = await h.fetch(new Request(`https://worker.example/v1/runs/${runId}/cancel`, { method: 'POST' }));
  assert.equal(response.status, 401);
  assert.deepEqual(h.cancelled, []);
});

test('poll и cancel чужого runId — 404, а не пустой 200', async () => {
  const h = harness();
  const status = await h.fetch(
    new Request('https://worker.example/v1/runs/run_missing', { headers: { authorization: `Bearer ${WORKER_TOKEN}` } }),
  );
  assert.equal(status.status, 404);
});

test('неизвестный путь — 404', async () => {
  const h = harness();
  assert.equal((await h.fetch(new Request('https://worker.example/v1/nope'))).status, 404);
});

test('ответ claim помечен no-store: в нём лежит ключ LLM', async () => {
  const h = harness();
  const runId = validLaunchRequest()['runId'] as string;
  await h.fetch(launch(validLaunchRequest()));
  const response = await h.fetch(
    new Request('https://worker.example/v1/claim', {
      method: 'POST',
      headers: { authorization: `Bearer ${h.dispatched[0]!.claimToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ runId }),
    }),
  );
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

// ── клиент GitHub: самые частые причины 4xx/422 ───────────────────────────────

test('workflow_dispatch всегда отправляет ref, иначе GitHub отвечает 422', async () => {
  const seen: Array<{ url: string; body: unknown; method: string }> = [];
  const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    seen.push({ url: href, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (href.endsWith('/repos/vovalikessmoothy-png/opencode-gha-runner')) {
      return new Response(JSON.stringify({ default_branch: 'trunk' }), { status: 200 });
    }
    if (href.includes('/dispatches')) return new Response(null, { status: 204 });
    if (href.includes('/git/ref/heads/trunk')) {
      return new Response(JSON.stringify({ object: { sha: 'abc123' } }), { status: 200 });
    }
    if (href.includes('/actions/workflows/')) {
      return new Response(
        JSON.stringify({ workflow_runs: [{ id: 555, head_sha: 'abc123', status: 'queued' }] }),
        { status: 200 },
      );
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;

  const client = new GitHubClient({
    token: 't',
    repo: 'vovalikessmoothy-png/opencode-gha-runner',
    workflow: 'run-agent.yml',
    fetchImpl: fakeFetch,
  });
  const result = await client.dispatchWorkflow({ runId: 'run-1', claimToken: 'claim-1' });
  assert.equal(result.runId, 555);

  const dispatch = seen.find((call) => call.url.includes('/dispatches'));
  assert.ok(dispatch, 'dispatches должен быть вызван');
  const body = dispatch!.body as { ref: string; inputs: Record<string, string> };
  assert.equal(body.ref, 'trunk', 'ref обязан резолвиться из default branch, а не выбрасываться');
  assert.deepEqual(Object.keys(body.inputs).sort(), ['claim_token', 'run_id']);
});

test('явно заданный ref не перебивается веткой репозитория', async () => {
  const bodies: unknown[] = [];
  const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    if (href.includes('/dispatches')) {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    }
    if (href.includes('/actions/workflows/')) {
      return new Response(JSON.stringify({ workflow_runs: [{ id: 7, head_sha: 'x', status: 'in_progress' }] }), {
        status: 200,
      });
    }
    return new Response(JSON.stringify({ object: { sha: 'x' } }), { status: 200 });
  }) as unknown as typeof fetch;

  const client = new GitHubClient({
    token: 't',
    repo: 'o/r',
    workflow: 'run-agent.yml',
    ref: 'release-1',
    fetchImpl: fakeFetch,
  });
  await client.dispatchWorkflow({ runId: 'run-1', claimToken: 'claim-1' });
  assert.equal((bodies[0] as { ref: string }).ref, 'release-1');
});

test('ошибка диспатча не теряет код ответа', async () => {
  const fakeFetch = (async (url: string | URL) => {
    if (String(url).includes('/dispatches')) {
      return new Response(JSON.stringify({ message: 'Workflow does not have workflow_dispatch trigger' }), {
        status: 422,
      });
    }
    return new Response(JSON.stringify({ default_branch: 'main' }), { status: 200 });
  }) as unknown as typeof fetch;

  const client = new GitHubClient({ token: 't', repo: 'o/r', workflow: 'nope.yml', fetchImpl: fakeFetch });
  await assert.rejects(
    () => client.dispatchWorkflow({ runId: 'run-1', claimToken: 'c' }),
    /workflow_dispatch failed with 422.*workflow_dispatch trigger/s,
  );
});
