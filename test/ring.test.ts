/**
 * Кольцо: разбор источников, round-robin и то, что шлюз действительно идёт по цели.
 *
 * Кольцо — это список мест запуска, поэтому ошибка здесь не «неудобно», а «все раны
 * уходят в один репозиторий» или «отмена уходит не туда». Проверяем оба.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGateway, type GatewayConfig } from '../src/gateway/app.js';
import type { DispatchResult, GitHubClient } from '../src/gateway/github.js';
import { Ring, parseRing, type RingTarget } from '../src/gateway/ring.js';
import { MemoryRunStore, type KvLike } from '../src/gateway/store.js';
import { validLaunchRequest } from './contracts.test.js';

// ── parseRing ──────────────────────────────────────────────────────────────────

test('разбирает ответ zen-rings: { repos: [...] }', () => {
  const ring = parseRing({
    repos: [
      { repo: 'a/one', token: 'ghp_1', enabled: true },
      { repo: 'a/two', token: 'ghp_2' },
    ],
  });
  assert.deepEqual(ring, [
    { repo: 'a/one', token: 'ghp_1' },
    { repo: 'a/two', token: 'ghp_2' },
  ]);
});

test('разбирает наш собственный формат: массив и { targets: [...] }', () => {
  assert.deepEqual(parseRing([{ repo: 'a/one', token: 't' }]), [{ repo: 'a/one', token: 't' }]);
  assert.deepEqual(parseRing({ targets: [{ repo: 'a/one', token: 't' }] }), [{ repo: 'a/one', token: 't' }]);
  assert.deepEqual(parseRing('[{"repo":"a/one","token":"t"}]'), [{ repo: 'a/one', token: 't' }]);
});

test('отбрасывает выключенные строки и строки без токена', () => {
  // Репозиторий, в который нельзя постучаться, — это не цель, а отложенный отказ
  // на запуске: лучше не выбрать его вовсе.
  const ring = parseRing({
    repos: [
      { repo: 'a/off', token: 't', enabled: false },
      { repo: 'a/notoken' },
      { repo: 'a/ok', token: 't' },
    ],
  });
  assert.deepEqual(ring, [{ repo: 'a/ok', token: 't' }]);
});

test('отбрасывает мусор вместо падения', () => {
  for (const input of [null, undefined, 42, 'не json', { repos: 'нет' }, { repos: [{ repo: 'без-слэша', token: 't' }] }]) {
    assert.deepEqual(parseRing(input), []);
  }
});

// ── round-robin ────────────────────────────────────────────────────────────────

/** KV в памяти — курсор и кэш ведут себя как настоящие. */
function memoryKv(): KvLike & { dump: () => Record<string, string> } {
  const data = new Map<string, string>();
  return {
    async get(key) {
      return data.get(key) ?? null;
    },
    async put(key, value) {
      data.set(key, value);
    },
    async delete(key) {
      data.delete(key);
    },
    async list() {
      return { keys: [...data.keys()].map((name) => ({ name })) };
    },
    dump: () => Object.fromEntries(data),
  };
}

const A: RingTarget = { repo: 'a/one', token: 't1' };
const B: RingTarget = { repo: 'a/two', token: 't2' };
const C: RingTarget = { repo: 'a/three', token: 't3' };

test('next() идёт по циклу и возвращается к началу', async () => {
  const ring = new Ring({ targets: [A, B, C], kv: memoryKv() });
  const picks = [];
  for (let i = 0; i < 7; i += 1) picks.push((await ring.next())!.repo);
  assert.deepEqual(picks, ['a/one', 'a/two', 'a/three', 'a/one', 'a/two', 'a/three', 'a/one']);
});

test('курсор живёт в общем KV, а не в памяти изолята', async () => {
  const kv = memoryKv();
  const first = new Ring({ targets: [A, B], kv });
  assert.equal((await first.next())!.repo, 'a/one');
  // Второй экземпляр — как другой изолят воркера: он обязан продолжить цикл, а не начать заново.
  const second = new Ring({ targets: [A, B], kv });
  assert.equal((await second.next())!.repo, 'a/two');
  assert.equal((await first.next())!.repo, 'a/one');
});

test('пустое кольцо возвращает null — вызывающий откатывается на конфиг', async () => {
  assert.equal(await new Ring({ targets: [], kv: memoryKv() }).next(), null);
});

test('кольцо берётся у zen-rings и кэшируется', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ repos: [{ repo: 'zen/one', token: 'zt' }] }), { status: 200 });
  }) as unknown as typeof fetch;

  const kv = memoryKv();
  const ring = new Ring({ zenUrl: 'https://zen.example', zenAdminToken: 'adm', kv, fetchImpl });
  assert.equal((await ring.next())!.repo, 'zen/one');
  assert.equal((await ring.next())!.repo, 'zen/one');
  assert.equal(calls, 1, 'второй вызов обязан прийти из кэша');
  assert.ok(kv.dump()['ring:cache'], 'кэш лежит в KV, чтобы пережить холодный старт изолята');
});

test('отказ zen-rings не роняет выбор: пустое кольцо', async () => {
  const fetchImpl = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch;
  const ring = new Ring({ zenUrl: 'https://zen.example', zenAdminToken: 'adm', kv: memoryKv(), fetchImpl });
  assert.equal(await ring.next(), null);
});

test('без админ-токена к zen-rings не ходим вовсе', async () => {
  let called = false;
  const fetchImpl = (async () => {
    called = true;
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  assert.equal(await new Ring({ zenUrl: 'https://zen.example', kv: memoryKv(), fetchImpl }).next(), null);
  assert.equal(called, false);
});

// ── шлюз идёт по цели ──────────────────────────────────────────────────────────

function ringGateway(ring: RingTarget[], kv = memoryKv()) {
  const store = new MemoryRunStore();
  const dispatched: Array<{ target: string; runId: string }> = [];
  const cancelled: Array<{ target: string; runId: number }> = [];
  const config: GatewayConfig = {
    workerToken: 'wt',
    repo: 'fallback/repo',
    workflow: 'run-agent.yml',
    publicBaseUrl: 'https://worker.example',
    agentBinary: 'opencode',
    githubToken: 'fallback-token',
    ringTargets: ring,
  };
  const githubFor = (target: RingTarget): GitHubClient =>
    ({
      dispatchWorkflow: async (input: { runId: string }): Promise<DispatchResult> => {
        dispatched.push({ target: target.repo, runId: input.runId });
        return { runId: 100 + dispatched.length, htmlUrl: '' };
      },
      findRunSince: async () => null,
      cancelWorkflowRun: async (runId: number) => {
        cancelled.push({ target: target.repo, runId });
        return { cancelled: true, reason: 'cancelled' as const };
      },
    }) as unknown as GitHubClient;

  const app = createGateway({
    config,
    store,
    githubFor,
    ring: new Ring({ targets: ring, kv }),
    kv,
    randomToken: (() => { let n = 0; return () => `tok-${++n}`; })(),
    // Доставка результата нашему API перехвачена: тест не должен ждать сетевых таймаутов.
    fetchImpl: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
  });
  return { fetch: app.fetch, store, dispatched, cancelled };
}

const launch = (runId: string, operationId: string): Request =>
  new Request('https://worker.example/v1/launch', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer wt' },
    body: JSON.stringify({
      ...validLaunchRequest(),
      runId,
      operationId,
      repository: { fullName: 'o/r', branch: `agent-run/${runId}` },
      resultUrl: 'https://api.example/v1/worker/launches/x/result',
    }),
  });

test('последовательные запуски уходят в разные репозитории кольца', async () => {
  const h = ringGateway([A, B]);
  for (const [i, id] of ['run_1', 'run_2', 'run_3'].entries()) {
    assert.equal((await h.fetch(launch(id, `op_${i}`))).status, 202);
  }
  assert.deepEqual(h.dispatched.map((d) => d.target), ['a/one', 'a/two', 'a/one']);
});

test('отмена идёт в тот репозиторий, куда ушёл ран, а не в текущий по циклу', async () => {
  // Иначе round-robin к моменту отмены выберет другую репу, и отмена уйдёт не туда.
  const h = ringGateway([A, B]);
  await h.fetch(launch('run_1', 'op_1')); // → a/one
  await h.fetch(launch('run_2', 'op_2')); // → a/two

  const cancel = await h.fetch(
    new Request('https://worker.example/v1/runs/run_1/cancel', { method: 'POST', headers: { authorization: 'Bearer wt' } }),
  );
  assert.equal(cancel.status, 200);
  assert.deepEqual(h.cancelled, [{ target: 'a/one', runId: 101 }]);
});

test('пустое кольцо откатывается на репозиторий из конфига', async () => {
  const h = ringGateway([]);
  await h.fetch(launch('run_1', 'op_1'));
  assert.deepEqual(h.dispatched.map((d) => d.target), ['fallback/repo']);
});

test('токен цели не остаётся в записи рана после завершения', async () => {
  const h = ringGateway([A]);
  await h.fetch(launch('run_1', 'op_1'));
  const claim = (await (
    await h.fetch(
      new Request('https://worker.example/v1/claim', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer tok-1' },
        body: JSON.stringify({ runId: 'run_1' }),
      }),
    )
  ).json()) as { reportToken: string };

  await h.fetch(
    new Request('https://worker.example/v1/runs/run_1/report', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${claim.reportToken}` },
      body: JSON.stringify({
        status: 'started',
        pid: null,
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
        repo: { fullName: 'o/r', branch: 'b', commit: '0'.repeat(40) },
      }),
    }),
  );

  const stored = await h.store.get('run_1');
  assert.equal(stored?.target.token, '', 'токен репозитория вычищается вместе с ключом LLM');
  assert.equal(stored?.target.repo, 'a/one', 'репозиторий остаётся: он не секрет');
});
