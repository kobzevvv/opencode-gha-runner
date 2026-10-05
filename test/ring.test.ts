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

test('разные runId расходятся по кольцу, а один runId всегда даёт одну цель', async () => {
  const ring = new Ring({ targets: [A, B, C], kv: memoryKv() });
  const seed = (n: number): string => `run_${String(n).padStart(4, '0')}`;

  // Один и тот же runId обязан давать ту же цель: отмена и поиск осиротевшего прогона
  // идут по сохранённой цели, и повтор launch с тем же runId — тоже в неё.
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await ring.next(seed(7)))!.repo, (await ring.next(seed(7)))!.repo);
  }

  // Разные runId не должны сливаться в одну цель: кольцо ради этого и существует.
  const picks = new Set<string>();
  for (let i = 0; i < 30; i += 1) picks.add((await ring.next(seed(i)))!.repo);
  assert.equal(picks.size, 3, `кольцо из трёх целей не использовано целиком: ${[...picks]}`);
});

test('параллельные запуски расходятся по кольцу, а не сливаются в одну цель', async () => {
  // Живой дефект 05.10.2026: пять одновременных launch ушли все в один репозиторий,
  // потому что курсор в KV читался гонкой. Здесь те же пять запусков приходят так,
  // как их приводит воркер: без общего состояния и одновременно.
  //
  // Пять запусков на три цели не могут дать пять разных целей — это принцип Дирихле.
  // Проверяем то, что важно: кольцо использовано целиком, и ни одна цель не забрала
  // все пять запусков (это и был дефект).
  const ring = new Ring({ targets: [A, B, C], kv: memoryKv() });
  const seeds = ['run_a', 'run_b', 'run_c', 'run_d', 'run_e'];
  const picked = await Promise.all(seeds.map((seed) => ring.next(seed)));
  const repos = picked.map((target) => target!.repo);
  assert.equal(new Set(repos).size, 3, `кольцо из трёх целей использовано не целиком: ${repos}`);
});

test('выбор не зависит от KV: он идёт по runId, а не по общему счётчику', async () => {
  // Два экземпляра — как два изолята воркера. Раньше им нужен был общий курсор в KV, и
  // без него оба начинали с первого репозитория; теперь состояния нет вообще, поэтому
  // один и тот же runId даёт одну цель в любом изоляте, а разные — расходятся.
  const kv = memoryKv();
  const first = new Ring({ targets: [A, B], kv });
  const second = new Ring({ targets: [A, B], kv });
  assert.equal((await first.next('run_x'))!.repo, (await second.next('run_x'))!.repo);

  const repos = new Set<string>();
  for (let i = 0; i < 20; i += 1) {
    repos.add((await (i % 2 === 0 ? first : second).next(`run_${i}`))!.repo);
  }
  assert.equal(repos.size, 2, `изоляты не разошлись по кольцу: ${[...repos]}`);
});

test('выбор переживает отказ KV: цель всё равно есть', async () => {
  const brokenKv: KvLike = {
    async get() {
      throw new Error('kv unavailable');
    },
    async put() {
      throw new Error('kv unavailable');
    },
    async delete() {
      throw new Error('kv unavailable');
    },
    async list() {
      throw new Error('kv unavailable');
    },
  };
  const ring = new Ring({ targets: [A, B, C], kv: brokenKv });
  assert.ok(await ring.next('run_1'), 'отказ KV не должен ронять выбор цели');
});

test('пустое кольцо возвращает null — вызывающий откатывается на конфиг', async () => {
  assert.equal(await new Ring({ targets: [], kv: memoryKv() }).next('run_1'), null);
});

test('кольцо берётся у zen-rings и кэшируется', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ repos: [{ repo: 'zen/one', token: 'zt' }] }), { status: 200 });
  }) as unknown as typeof fetch;

  const kv = memoryKv();
  const ring = new Ring({ zenUrl: 'https://zen.example', zenAdminToken: 'adm', kv, fetchImpl });
  assert.equal((await ring.next('run_1'))!.repo, 'zen/one');
  assert.equal((await ring.next('run_2'))!.repo, 'zen/one');
  assert.equal(calls, 1, 'второй вызов обязан прийти из кэша');
  assert.ok(kv.dump()['ring:cache'], 'кэш лежит в KV, чтобы пережить холодный старт изолята');
});

test('отказ zen-rings не роняет выбор: пустое кольцо', async () => {
  const fetchImpl = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch;
  const ring = new Ring({ zenUrl: 'https://zen.example', zenAdminToken: 'adm', kv: memoryKv(), fetchImpl });
  assert.equal(await ring.next('run_1'), null);
});

test('без админ-токена к zen-rings не ходим вовсе', async () => {
  let called = false;
  const fetchImpl = (async () => {
    called = true;
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  assert.equal(await new Ring({ zenUrl: 'https://zen.example', kv: memoryKv(), fetchImpl }).next('run_1'), null);
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

test('параллельные запуски шлюза расходятся по репозиториям кольца', async () => {
  // Живой дефект 05.10.2026: пять одновременных launch ушли все в `recruiting-me/runs`.
  // Свойство, которое его закрывает: у разных runId разные цели, даже когда запуски
  // приходят одновременно и в разные изоляты.
  const h = ringGateway([A, B, C]);
  const ids = ['run_1', 'run_2', 'run_3', 'run_4', 'run_5', 'run_6'];
  const responses = await Promise.all(ids.map((id, i) => h.fetch(launch(id, `op_${i}`))));
  for (const response of responses) assert.equal(response.status, 202);
  assert.equal(new Set(h.dispatched.map((d) => d.target)).size, 3, `кольцо не использовано: ${h.dispatched}`);
});

test('отмена идёт в тот репозиторий, куда ушёл ран, а не в другой', async () => {
  // Иначе отмена уйдёт не туда: цель хранится в записи рана, а не выбирается заново.
  const h = ringGateway([A, B, C]);
  await h.fetch(launch('run_1', 'op_1'));
  await h.fetch(launch('run_2', 'op_2'));
  const targetOf = (runId: string): string | undefined => h.dispatched.find((d) => d.runId === runId)?.target;
  const first = targetOf('run_1');
  assert.ok(first, 'первый ран должен быть диспатчен');

  const cancel = await h.fetch(
    new Request('https://worker.example/v1/runs/run_1/cancel', { method: 'POST', headers: { authorization: 'Bearer wt' } }),
  );
  assert.equal(cancel.status, 200);
  assert.deepEqual(h.cancelled, [{ target: first, runId: 101 }]);
});

test('повтор launch с тем же runId уходит в ту же цель', async () => {
  // Отмена и поиск осиротевшего прогона идут по сохранённой цели, поэтому выбор обязан быть
  // детерминирован по runId, а не «как выпадет».
  const h = ringGateway([A, B, C]);
  await h.fetch(launch('run_7', 'op_7'));
  const first = h.dispatched.find((d) => d.runId === 'run_7')?.target;
  assert.ok(first);

  const repeat = ringGateway([A, B, C]);
  await repeat.fetch(launch('run_7', 'op_7'));
  assert.equal(repeat.dispatched.find((d) => d.runId === 'run_7')?.target, first);
});

test('пустое кольцо откатывается на репозиторий из конфига', async () => {
  const h = ringGateway([]);
  await h.fetch(launch('run_1', 'op_1'));
  assert.deepEqual(h.dispatched.map((d) => d.target), ['fallback/repo']);
});

// ── имя workflow у цели ─────────────────────────────────────────────────────────

/**
 * Настоящий `GitHubClient` с перехватом fetch: здесь важно, в какой URL ушёл диспатч,
 * а мок клиента в `ringGateway` этот URL вообще не строит.
 */
function dispatchUrls(ring: RingTarget[], configWorkflow = 'run-agent.yml'): Promise<string[]> {
  const urls: string[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    urls.push(String(url));
    if (init?.method === 'POST') return new Response(null, { status: 204 });
    // Ветка резолвится отдельным вызовом `/repos/{repo}`, а прогоны берутся списком.
    // Оба ответа отдаёт один объект: тесту важен URL, а не содержимое.
    return new Response(JSON.stringify({ default_branch: 'main', workflow_runs: [] }), { status: 200 });
  }) as unknown as typeof fetch;
  const app = createGateway({
    config: {
      workerToken: 'wt',
      repo: 'fallback/repo',
      workflow: configWorkflow,
      publicBaseUrl: 'https://worker.example',
      agentBinary: 'opencode',
      githubToken: 'fallback-token',
      ringTargets: ring,
    },
    store: new MemoryRunStore(),
    ring: new Ring({ targets: ring, kv: memoryKv() }),
    kv: memoryKv(),
    fetchImpl,
  });
  return app.fetch(launch('run_1', 'op_1')).then(() => urls);
}

test('в цель кольца диспатчим workflow с именем репозитория', async () => {
  // Общий `run-agent.yml` в репозитории кольца не существует: провижн кладёт файл под
  // именем репозитория. С общим именем GitHub отвечал бы 422 на каждом запуске.
  const urls = await dispatchUrls([A]);
  assert.ok(
    urls.some((u) => u === 'https://api.github.com/repos/a/one/actions/workflows/one.yml/dispatches'),
    `диспатч должен идти в one.yml, а не в run-agent.yml: ${urls.join(', ')}`,
  );
});

test('явное имя workflow в цели важнее имени репозитория', async () => {
  const urls = await dispatchUrls([{ repo: 'a/one', token: 't1', workflow: 'agent.yml' }]);
  assert.ok(urls.some((u) => u.endsWith('/repos/a/one/actions/workflows/agent.yml/dispatches')), urls.join(', '));
});

test('fallback-репозиторий раннера диспатчит свой workflow из конфига', async () => {
  // Это не цель кольца, а сам репозиторий раннера: у него файл называется как в конфиге.
  const urls = await dispatchUrls([], 'run-agent.yml');
  assert.ok(urls.some((u) => u.endsWith('/repos/fallback/repo/actions/workflows/run-agent.yml/dispatches')), urls.join(', '));
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
