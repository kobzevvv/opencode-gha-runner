/**
 * HTTP-шлюз воркера: единственная точка, в которую стучится наш API
 * (`DynamicIpAzureAdapter` в `trained-assist/ai-agent-runner`).
 *
 * Роутинг написан на голом `Request → Response`, без фреймворка, потому что один и тот
 * же модуль должен подняться и в Cloudflare Worker (прода), и в `node:http` (локальные
 * прогоны и тесты). Проверить работу можно локально, без деплоя: `npm run dev`.
 */

import {
  API_RESULT_PATH,
  CLAIM_PATH,
  DEFAULT_LLM_KEY_ENV,
  REPORT_PATH,
  STATUS_PATH,
  type ClaimPayload,
} from '../claim.js';
import {
  ENGINE_NAME,
  ValidationError,
  failure,
  isSafeWorkflowName,
  redact,
  validateLaunchRequest,
  type LaunchReceipt,
  type LaunchRequest,
  type LaunchResult,
} from '../contracts.js';
import { DispatchError, GitHubClient, type GitHubClientOptions } from './github.js';
import { Ring, type RingTarget } from './ring.js';
import { isTerminal, workerStatus, type KvLike, type RunStore, type StoredRun } from './store.js';

export interface GatewayConfig {
  /** Общий секрет между нашим API и воркером (`Authorization: Bearer`). */
  workerToken: string;
  /** Репозиторий с workflow: `owner/name`. */
  repo: string;
  /** Файл workflow, например `run-agent.yml`. */
  workflow: string;
  ref?: string;
  /** Публичный адрес шлюза — джоба сама его не знает. */
  publicBaseUrl: string;
  /** Бинарь агента, который джоба должна запустить. */
  agentBinary: string;
  /**
   * Запасная цель, если кольцо пусто: репозиторий и токен для диспатча.
   * Кольцо, когда оно есть, перекрывает её — оно и есть список мест запуска.
   */
  githubToken: string;
  /** Статический список целей кольца (repo+token). Пустой — кольцо берётся у zen-rings. */
  ringTargets?: RingTarget[];
  /** `https://llm-ladder.trainedassist.store` — источник кольца. */
  zenRingUrl?: string;
  /** Админ-токен кольца: только им читается `/zen/ring/payload`. */
  zenRingAdminToken?: string;
}

export interface GatewayDeps {
  config: GatewayConfig;
  store: RunStore;
  /** Один клиент на все цели — для тестов, которым важно только поведение. */
  github?: GitHubClient;
  /** Клиент под конкретную цель кольца — чтобы тест видел, куда ушёл ран. */
  githubFor?: (target: RingTarget) => GitHubClient;
  /** Кольцо; если не передано, собирается из конфига. */
  ring?: Ring;
  /** Общее хранилище для курсора round-robin и кэша кольца. */
  kv?: KvLike;
  fetchImpl?: typeof fetch;
  /** Генератор токенов — подменяется в тестах на детерминированный. */
  randomToken?: () => string;
  /** Логирование. По умолчанию ничего не печатает: тело запроса содержит `llmKey`. */
  log?: (message: string, fields?: Record<string, unknown>) => void;
  now?: () => number;
}

export function defaultRandomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

function noStore(extra: Record<string, string> = {}): Record<string, string> {
  return { 'cache-control': 'no-store', ...extra };
}

function bearer(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? null;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `POST /v1/launch` обязан подтвердить приём синхронно и ответить сразу, а не ждать
 * агента: холодный старт GHA-джобы — 15–45 с, а бывает и очередь. Поэтому успешный
 * `launch` — это 202 с `status: "started"` и ссылкой для poll'а; финальный
 * `LaunchResult` наш API забирает через `GET /v1/runs/{runId}`.
 */
export function createGateway(deps: GatewayDeps): { fetch: (request: Request) => Promise<Response> } {
  const { config, store } = deps;
  const randomToken = deps.randomToken ?? defaultRandomToken;
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? ((): void => {});
  // Клиент строится под цель: у каждого репозитория кольца свой токен и своя история
  // прогонов. Кэш по ключу «репозиторий+токен» — чтобы не пересобирать на каждый запрос.
  const clientCache = new Map<string, GitHubClient>();
  const clientFor = (target: RingTarget): GitHubClient => {
    if (deps.githubFor) return deps.githubFor(target);
    if (deps.github) return deps.github;
    const key = `${target.repo}\n${target.token}`;
    let client = clientCache.get(key);
    if (!client) {
      client = new GitHubClient({
        token: target.token,
        repo: target.repo,
        workflow: config.workflow,
        ref: config.ref,
        fetchImpl: deps.fetchImpl,
      } satisfies GitHubClientOptions);
      clientCache.set(key, client);
    }
    return client;
  };

  const ring =
    deps.ring ??
    new Ring({
      targets: config.ringTargets,
      zenUrl: config.zenRingUrl,
      zenAdminToken: config.zenRingAdminToken,
      kv: deps.kv,
      fetchImpl: deps.fetchImpl,
      log,
    });
  /** Куда идти, если кольцо пусто или недоступно. */
  const fallbackTarget: RingTarget = { repo: config.repo, token: config.githubToken };

  /** Куда идти этому запуску; падение кольца не должно ронять запуск. */
  async function pickTarget(runId: string): Promise<RingTarget> {
    try {
      return (await ring.next(runId)) ?? fallbackTarget;
    } catch (cause) {
      log('ring pick failed', { runId, error: cause instanceof Error ? cause.message : String(cause) });
      return fallbackTarget;
    }
  }

  if (!isSafeWorkflowName(config.workflow)) {
    throw new Error(`config.workflow must look like "run-agent.yml", got "${config.workflow}"`);
  }

  async function readJson(request: Request): Promise<unknown> {
    const text = await request.text();
    if (text.length === 0) throw new ValidationError(['request body is empty']);
    try {
      return JSON.parse(text);
    } catch {
      throw new ValidationError(['request body is not valid JSON']);
    }
  }

  function requireWorkerAuth(request: Request): Response | null {
    const token = bearer(request);
    if (!token || !timingSafeEqual(token, config.workerToken)) {
      return json({ error: 'unauthorized' }, 401, noStore({ 'www-authenticate': 'Bearer' }));
    }
    return null;
  }

  async function handleLaunch(request: Request): Promise<Response> {
    const spec = validateLaunchRequest(await readJson(request));

    // Дедупликация по operationId, а не по runId: наш API повторяет доставку того же
    // запуска, и повтор обязан вернуть ту же квитанцию и тот же ран. Дедуп по runId
    // этого не даёт — при повторе с новым runId поднялся бы второй ран там, где первый
    // ещё идёт, ровно тот дефект, который контракт исключает.
    const existing = await store.findByOperationId(spec.operationId);
    if (existing) {
      log('launch deduplicated', { runId: existing.runId, operationId: spec.operationId, phase: existing.phase });
      return json(receipt(existing), 202, noStore());
    }

    // Цель кольца выбирается до записи рана: она часть записи, потому что отмена и
    // поиск осиротевшего прогона обязаны идти именно в этот репозиторий. Выбор детерминирован
    // по runId, поэтому повтор с тем же runId пришёл бы в ту же цель.
    const target = await pickTarget(spec.runId);
    const github = clientFor(target);

    const claimToken = randomToken();
    const reportToken = randomToken();
    await store.create({
      runId: spec.runId,
      operationId: spec.operationId,
      request: spec,
      phase: 'queued',
      createdAt: now(),
      updatedAt: now(),
      githubRunId: null,
      target,
      claimToken,
      reportToken,
      result: null,
    });

    log('dispatching run', {
      runId: spec.runId,
      operationId: spec.operationId,
      engine: spec.engine.name,
      repo: target.repo,
    });

    // Момент до диспатча: по нему ищем прогон, если ответ потеряется.
    const dispatchStartedAt = now();
    try {
      const dispatched = await github.dispatchWorkflow({ runId: spec.runId, claimToken });
      await store.patch(spec.runId, { phase: 'dispatched', githubRunId: dispatched.runId });
    } catch (cause) {
      const rejected = cause instanceof DispatchError && cause.rejected;

      // Явный 4xx — GitHub запрос отверг (нет workflow, нет прав, нет репо), прогона
      // заведомо нет. Снимаем запись, чтобы повтор с тем же operationId не
      // задедуплицировался в мёртвый ран, и повтор диспатчит заново.
      if (!rejected) {
        // Ответа не было или пришёл 5xx: диспатч **мог** пройти. Прежде чем забывать
        // ран, спрашиваем GitHub, появился ли прогон. Иначе повтор поднял бы вторую
        // GHA-джобу там, где первая уже работает, — ровно тот дефект, который
        // дедупликация по operationId обязана исключать.
        const adopted = await github.findRunSince(dispatchStartedAt).catch(() => null);
        if (adopted) {
          await store.patch(spec.runId, { phase: 'dispatched', githubRunId: adopted.id });
          log('dispatch recovered after a lost response', { runId: spec.runId, githubRunId: adopted.id });
          const recovered = await store.get(spec.runId);
          if (recovered) return json(receipt(recovered), 202, noStore());
        }
      }

      await store.remove(spec.runId);
      const safeSummary = redact(cause instanceof Error ? cause.message : String(cause));
      log('dispatch failed', { runId: spec.runId, rejected, error: safeSummary });
      // 502: наш API должен понять, что дело в воркере, и повторить — это retryable.
      // Повтор безопасен: ран снят, второй джобы не будет.
      return json(
        {
          runId: spec.runId,
          status: 'failed',
          failure: failure('WORKER_INTERNAL', 'engine', `workflow_dispatch failed: ${safeSummary}`),
        },
        502,
        noStore(),
      );
    }

    const run = await store.get(spec.runId);
    if (!run) return json({ error: 'worker_internal', message: 'run vanished after dispatch' }, 500, noStore());
    return json(receipt(run), 202, noStore());
  }

  /** Квитанция запуска: адреса, по которым наш API спросит статус и заберёт результат. */
  function receipt(run: StoredRun): LaunchReceipt {
    return {
      runId: run.runId,
      operationId: run.operationId,
      status: 'accepted',
      statusUrl: `${config.publicBaseUrl}${STATUS_PATH(run.runId)}`,
      resultUrl: `${config.publicBaseUrl}${API_RESULT_PATH(run.runId)}`,
    };
  }

  async function handleClaim(request: Request): Promise<Response> {
    const token = bearer(request);
    if (!token) return json({ error: 'unauthorized' }, 401, noStore());

    const body = (await readJson(request)) as { runId?: unknown };
    if (typeof body.runId !== 'string' || body.runId.length === 0) {
      return json({ error: 'bad_request', issues: ['runId: expected a string'] }, 400, noStore());
    }

    const run = await store.claim(body.runId, token);
    if (!run) {
      // Один и тот же ответ на «не найден» и «токен уже использован»: иначе claim
      // превращается в способ перебирать runId.
      return json({ error: 'claim_invalid' }, 409, noStore());
    }

    const spec = run.request;
    const payload: ClaimPayload = {
      runId: run.runId,
      spec,
      llmKey: spec.credentials?.llmKey ?? spec.env[spec.credentials?.envName ?? DEFAULT_LLM_KEY_ENV] ?? '',
      llmKeyEnvName: spec.credentials?.envName ?? DEFAULT_LLM_KEY_ENV,
      reportToken: run.reportToken,
      reportUrl: `${config.publicBaseUrl}${REPORT_PATH(run.runId)}`,
      agentBinary: config.agentBinary,
    };

    log('run claimed', { runId: run.runId, outputs: spec.outputs?.length ?? 0 });

    // `no-store` обязателен: ответ содержит `llmKey`, и любой прокси с кэшем — утечка.
    return json(payload, 200, noStore());
  }

  /**
   * Приём результата от джобы (внутренний маршрут по одноразовому report-токену).
   *
   * Сразу после сохранения результат **пересылается нашему API** на `resultUrl` из
   * запроса запуска: контракт не заставляет API опрашивать воркер. Опрос остаётся
   * запасным путём, поэтому неудачная пересылка не роняет приём — API заберёт результат
   * через `GET /result`, когда сработает его watchdog.
   */
  async function handleReport(request: Request, runId: string): Promise<Response> {
    const token = bearer(request);
    if (!token) return json({ error: 'unauthorized' }, 401, noStore());

    const body = (await readJson(request)) as Partial<LaunchResult>;
    if (typeof body !== 'object' || body === null) {
      return json({ error: 'bad_request', issues: ['expected a JSON object'] }, 400, noStore());
    }

    const stored = await store.get(runId);
    if (!stored) return json({ error: 'run_not_found' }, 404, noStore());
    if (!timingSafeEqual(token, stored.reportToken)) return json({ error: 'unauthorized' }, 401, noStore());

    // `runId` в теле игнорируется: эхом всегда идёт значение из пути.
    const result: LaunchResult = { ...(body as LaunchResult), runId };
    const accepted = await store.complete(runId, token, result);
    log('run result accepted', { runId, accepted, exitReason: result.exitReason });

    await deliverToApi(stored.request.resultUrl, result);
    return json({ runId, status: 'accepted', exitReason: result.exitReason }, 200, noStore());
  }

  /**
   * Пересылка `LaunchResult` нашему API. Best-effort с двумя повторами: если не вышло,
   * результат уже лежит у нас, и API заберёт его опросом. Молча терять нельзя — поэтому
   * в лог уходит причина без тела результата.
   */
  async function deliverToApi(resultUrl: string, result: LaunchResult): Promise<void> {
    const fetchImpl = deps.fetchImpl ?? fetch.bind(globalThis);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetchImpl(resultUrl, {
          method: 'POST',
          headers: { authorization: `Bearer ${config.workerToken}`, 'content-type': 'application/json' },
          body: JSON.stringify(result),
        });
        if (response.ok || response.status === 409) {
          log('result delivered to api', { runId: result.runId, status: response.status });
          return;
        }
        log('result delivery rejected', { runId: result.runId, status: response.status });
      } catch (cause) {
        log('result delivery failed', { runId: result.runId, error: redact(cause instanceof Error ? cause.message : String(cause)) });
      }
      await sleep(200 * (attempt + 1));
    }
  }

  /** `GET /v1/runs/{runId}/status` — контрактный статус, без результата. */
  async function handleRunStatus(runId: string): Promise<Response> {
    const run = await store.get(runId);
    // Неизвестный ран — это `unknown`, а не 404: исход установить нельзя, и наш API
    // должен пойти в reconcile, а не решить, что запуска не было.
    if (!run) {
      return json({ runId, status: 'unknown', updatedAt: new Date(now()).toISOString() }, 200, noStore());
    }
    return json(
      { runId, status: workerStatus(run), updatedAt: new Date(run.updatedAt).toISOString() },
      200,
      noStore(),
    );
  }

  /** `GET /v1/runs/{runId}/result` — `LaunchResult` или 409, пока ран не терминальный. */
  async function handleRunResult(runId: string): Promise<Response> {
    const run = await store.get(runId);
    if (!run || !run.result || !isTerminal(workerStatus(run))) {
      return json({ runId, status: 'not_ready' }, 409, noStore());
    }
    return json(run.result, 200, noStore());
  }

  // Авторизацию проверяет роутер: до обработчика доживает только валидный токен.
async function handleCancel(runId: string): Promise<Response> {
    const run = await store.get(runId);
    if (!run) return json({ status: 'unknown_run' }, 200, noStore());
    if (run.phase === 'done') {
      // Идемпотентно: ран уже завершён, отменять нечего.
      return json({ status: workerStatus(run) === 'cancelled' ? 'cancelled' : 'rejected', reason: 'already_finished' }, 200, noStore());
    }
    if (run.githubRunId === null) {
      // GitHub-прогон ещё не создан — отменять нечего, но рана больше не будет.
      await store.complete(runId, run.reportToken, cancelledResult(run));
      return json({ status: 'cancelled', reason: 'cancelled_before_dispatch' }, 200, noStore());
    }

    // Клиент — под цель рана, а не под текущую: round-robin к этому моменту мог
    // выбрать другой репозиторий, и отмена ушла бы не туда.
    const outcome = await clientFor(run.target).cancelWorkflowRun(run.githubRunId);
    if (outcome.cancelled) {
      await store.complete(runId, run.reportToken, cancelledResult(run));
      return json({ status: 'cancelled' }, 200, noStore());
    }
    // «Не нашёл» и «уже завершился» — не отказ воркера: отменять действительно нечего.
    return json({ status: 'rejected', reason: outcome.reason }, 200, noStore());
  }

  /** Результат отменённого рана: наш API читает его из `/result`, а не из пустоты. */
  function cancelledResult(run: StoredRun): LaunchResult {
    return {
      runId: run.runId,
      status: 'failed',
      pid: null,
      exitCode: null,
      exitSignal: 'SIGTERM',
      exitReason: 'cancelled',
      stdout: '',
      stderr: '',
      answerSource: null,
      durationMs: now() - run.createdAt,
      timedOut: false,
      outputTruncated: false,
      artifacts: [],
      logUrl: '',
      repo: { fullName: run.request.repository.fullName, branch: run.request.repository.branch, commit: '0'.repeat(40) },
    };
  }

  return {
    fetch: async (request: Request): Promise<Response> => {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, '') || '/';

      try {
        if (request.method === 'GET' && (path === '/healthz' || path === '/')) {
          return json({ ok: true, engine: ENGINE_NAME, repo: config.repo, workflow: config.workflow }, 200, noStore());
        }

        if (request.method === 'POST' && path === '/v1/launch') {
          const denied = requireWorkerAuth(request);
          if (denied) return denied;
          return await handleLaunch(request);
        }

        if (request.method === 'POST' && path === CLAIM_PATH) {
          return await handleClaim(request);
        }

        // Внутренний приём результата от GHA-джобы (одноразовый report-токен).
        if (request.method === 'POST' && /^\/v1\/runs\/[^/]+\/report$/.test(path)) {
          const runId = decodeURIComponent(path.split('/')[3]!);
          return await handleReport(request, runId);
        }

        if (request.method === 'POST' && /^\/v1\/runs\/[^/]+\/cancel$/.test(path)) {
          const runId = decodeURIComponent(path.split('/')[3]!);
          const denied = requireWorkerAuth(request);
          if (denied) return denied;
          return await handleCancel(runId);
        }

        if (request.method === 'GET' && /^\/v1\/runs\/[^/]+\/status$/.test(path)) {
          const runId = decodeURIComponent(path.split('/')[3]!);
          const denied = requireWorkerAuth(request);
          if (denied) return denied;
          return await handleRunStatus(runId);
        }

        if (request.method === 'GET' && /^\/v1\/runs\/[^/]+\/result$/.test(path)) {
          const runId = decodeURIComponent(path.split('/')[3]!);
          const denied = requireWorkerAuth(request);
          if (denied) return denied;
          return await handleRunResult(runId);
        }

        return json({ error: 'not_found' }, 404, noStore());
      } catch (cause) {
        if (cause instanceof ValidationError) {
          return json({ error: 'invalid_launch_request', issues: cause.issues }, 400, noStore());
        }
        const safeSummary = redact(cause instanceof Error ? cause.message : String(cause));
        log('gateway error', { error: safeSummary });
        return json(
          {
            error: 'worker_internal',
            message: safeSummary,
            failure: failure('WORKER_INTERNAL', 'engine', safeSummary),
          },
          500,
          noStore(),
        );
      }
    },
  };
}

export type { LaunchRequest };
