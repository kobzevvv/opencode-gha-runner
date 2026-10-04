/**
 * HTTP-шлюз воркера: единственная точка, в которую стучится наш API
 * (`DynamicIpAzureAdapter` в `trained-assist/ai-agent-runner`).
 *
 * Роутинг написан на голом `Request → Response`, без фреймворка, потому что один и тот
 * же модуль должен подняться и в Cloudflare Worker (прода), и в `node:http` (локальные
 * прогоны и тесты). Проверить работу можно локально, без деплоя: `npm run dev`.
 */

import {
  CANCEL_PATH,
  CLAIM_PATH,
  DEFAULT_LLM_KEY_ENV,
  RESULT_PATH,
  RUN_PATH,
  type ClaimPayload,
} from '../claim.js';
import {
  ENGINE_NAME,
  ValidationError,
  clampTimeout,
  failure,
  isSafeWorkflowName,
  redact,
  validateLaunchRequest,
  type LaunchRequest,
  type LaunchResult,
} from '../contracts.js';
import { GitHubClient, type GitHubClientOptions } from './github.js';
import type { RunStore } from './store.js';

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
  /** Токен GitHub для диспатча и отмены. */
  githubToken: string;
}

export interface GatewayDeps {
  config: GatewayConfig;
  store: RunStore;
  github?: GitHubClient;
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
  const github =
    deps.github ??
    new GitHubClient({
      token: config.githubToken,
      repo: config.repo,
      workflow: config.workflow,
      ref: config.ref,
      fetchImpl: deps.fetchImpl,
    } satisfies GitHubClientOptions);

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
    const existing = await store.get(spec.runId);
    if (existing && existing.phase !== 'done') {
      // Не заводим второй GitHub-прогон на тот же runId: наш API нед��поткрыто.
      return json(
        { runId: spec.runId, status: 'started', phase: existing.phase, pollUrl: `${config.publicBaseUrl}${RUN_PATH(spec.runId)}` },
        200,
        noStore(),
      );
    }

    const claimToken = randomToken();
    const reportToken = randomToken();
    await store.create({
      runId: spec.runId,
      request: spec,
      phase: 'queued',
      createdAt: now(),
      githubRunId: null,
      claimToken,
      reportToken,
      result: null,
    });

    log('dispatching run', { runId: spec.runId, engine: ENGINE_NAME });

    let githubRunId: number;
    let htmlUrl = '';
    try {
      const dispatched = await github.dispatchWorkflow({ runId: spec.runId, claimToken });
      githubRunId = dispatched.runId;
      htmlUrl = dispatched.htmlUrl;
    } catch (cause) {
      const safeSummary = redact(cause instanceof Error ? cause.message : String(cause));
      const result: LaunchResult = {
        runId: spec.runId,
        status: 'failed',
        exitCode: null,
        exitSignal: null,
        exitReason: 'startup_failure',
        stdout: '',
        stderr: '',
        answerSource: null,
        durationMs: 0,
        timedOut: false,
        outputTruncated: false,
        artifacts: [],
        logUrl: '',
        repo: { fullName: spec.repository.fullName, commit: null },
        failure: failure('WORKER_INTERNAL', 'engine', `workflow_dispatch failed: ${safeSummary}`),
      };
      await store.complete(spec.runId, reportToken, result);
      // 502: наш API должен понять, что дело в воркере, и не считать это ран-ошибкой агента.
      return json(result, 502, noStore());
    }

    await store.patch(spec.runId, { phase: 'dispatched', githubRunId });

    return json(
      {
        runId: spec.runId,
        status: 'started',
        phase: 'dispatched',
        githubRunId,
        githubRunUrl: htmlUrl,
        pollUrl: `${config.publicBaseUrl}${RUN_PATH(spec.runId)}`,
        timeoutMs: clampTimeout(spec.limits.timeoutMs),
      },
      202,
      noStore(),
    );
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
      reportUrl: `${config.publicBaseUrl}${RESULT_PATH(run.runId)}`,
      agentBinary: config.agentBinary,
    };

    log('run claimed', { runId: run.runId, outputs: spec.outputs?.length ?? 0 });

    // `no-store` обязателен: ответ содержит `llmKey`, и любой прокси с кэшем — утечка.
    return json(payload, 200, noStore());
  }

  async function handleResult(request: Request, runId: string): Promise<Response> {
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
    return json({ runId, status: 'accepted', exitReason: result.exitReason }, 200, noStore());
  }

  async function handleRunStatus(runId: string): Promise<Response> {
    const run = await store.get(runId);
    if (!run) return json({ error: 'run_not_found' }, 404, noStore());

    if (run.phase !== 'done') {
      return json(
        {
          runId,
          phase: run.phase,
          result: null,
          reportUrl: `${config.publicBaseUrl}${RESULT_PATH(runId)}`,
        },
        202,
        noStore(),
      );
    }
    return json({ runId, phase: run.phase, result: run.result }, 200, noStore());
  }

  async function handleCancel(request: Request, runId: string): Promise<Response> {
    const run = await store.get(runId);
    if (!run) return json({ runId, status: 'unknown', cancelled: false, reason: 'not_found' }, 404, noStore());
    if (run.phase === 'done') {
      const exitReason = run.result?.exitReason ?? 'completed';
      return json({ runId, status: exitReason === 'cancelled' ? 'cancelled' : 'finished', cancelled: false }, 200, noStore());
    }
    if (run.githubRunId === null) {
      // GitHub-прогон ещё не создан — отменять нечего, но рана больше не будет.
      await store.patch(runId, { phase: 'done' });
      return json({ runId, status: 'cancelled', cancelled: true, reason: 'cancelled_before_dispatch' }, 200, noStore());
    }

    const outcome = await github.cancelWorkflowRun(run.githubRunId);
    if (outcome.cancelled) await store.patch(runId, { phase: 'done' });

    return json(
      { runId, status: outcome.cancelled ? 'cancelled' : 'running', cancelled: outcome.cancelled, reason: outcome.reason },
      outcome.reason === 'not_found' ? 404 : 200,
      noStore(),
    );
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

        if (request.method === 'POST' && /^\/v1\/runs\/[^/]+\/result$/.test(path)) {
          const runId = decodeURIComponent(path.split('/')[3]!);
          return await handleResult(request, runId);
        }

        if (request.method === 'POST' && /^\/v1\/runs\/[^/]+\/cancel$/.test(path)) {
          const runId = decodeURIComponent(path.split('/')[3]!);
          const denied = requireWorkerAuth(request);
          if (denied) return denied;
          return await handleCancel(request, runId);
        }

        if (request.method === 'GET' && /^\/v1\/runs\/[^/]+$/.test(path)) {
          const runId = decodeURIComponent(path.split('/')[3]!);
          const denied = requireWorkerAuth(request);
          if (denied) return denied;
          return await handleRunStatus(runId);
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

/** Удобная обёртка для `curl` в тестах и в приёмке. */
export async function pollUntilDone(
  gatewayUrl: string,
  runId: string,
  workerToken: string,
  options: { attempts?: number; intervalMs?: number } = {},
): Promise<LaunchResult> {
  const attempts = options.attempts ?? 120;
  const intervalMs = options.intervalMs ?? 2000;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await fetch(`${gatewayUrl}${RUN_PATH(runId)}`, {
      headers: { authorization: `Bearer ${workerToken}` },
    });
    if (response.status === 200) {
      const body = (await response.json()) as { result: LaunchResult | null };
      if (body.result) return body.result;
    }
    await sleep(intervalMs);
  }
  throw new Error(`run ${runId} did not finish within ${attempts * intervalMs}ms`);
}

export type { LaunchRequest };
