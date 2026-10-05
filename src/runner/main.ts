/**
 * Точка входа GHA-джобы.
 *
 * Порядок шагов продиктован одним правилом: **ничего, что может утечь, не попадает в
 * `inputs` диспатча**. В inputs живут ровно два значения — `run_id` и `claim_token`.
 * Всё остальное (промпт, ключ LLM, allowlist, лимиты, репозиторий) джоба забирает
 * у шлюза одноразовым claim'ом уже внутри своего рантайма.
 *
 * Шаги:
 *   1. claim   → `{ spec, llmKey, reportToken, agentBinary }`
 *   2. ident   → per-run Unix-идентичность (или честный отказ на preflight)
 *   3. clone   → `repository.fullName` в `cwd`
 *   4. run     → агент под этой идентичностью, только с разрешённым env, по таймауту
 *   5. collect → объявленные выходы + манифест → коммит в репозиторий юзера
 *   6. log     → GCS, наружу только `logUrl`
 *   7. report  → `LaunchResult` по одноразовому report-токену
 *
 * Отчёт уходит в `finally`: агент упал, ключ не пришёл, клон не удался — наш API
 * всё равно должен получить `LaunchResult`, иначе ран навсегда останется `running`.
 */

import { execFile } from 'node:child_process';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { REPORT_PATH, type ClaimPayload } from '../claim.js';
import {
  clampTimeout,
  failure,
  redact,
  type AnswerSource,
  type ArtifactRef,
  type Failure,
  type LaunchRequest,
  type LaunchResult,
  type OutputSpec,
} from '../contracts.js';
import { GitHubRepoApi, NULL_SHA, buildManifest, collectArtifacts, type CollectResult } from './artifacts.js';
import { resolveAgentEnv, runAgent, type ExecOutcome } from './exec.js';
import { createRunIdentity, destroyRunIdentity, isBinaryAvailable, runUnderIdentity, type Identity } from './identity.js';
import { installAgentConfigUnderIdentity } from './agent-config.js';
import { uploadSessionLog, type LogUploadMode } from './logs.js';
import { agentOutputFormat, extractAnswer } from './answer.js';
import { buildAgentPrompt, declaredOutputFailure } from './finalization.js';

const exec = promisify(execFile);

export interface RunnerEnv {
  GATEWAY_URL: string;
  CLAIM_TOKEN: string;
  RUN_ID: string;
  /** Токен для клона `repository.fullName` и пуша артефактов. `GITHUB_TOKEN` джобы не годится. */
  ARTIFACTS_TOKEN?: string;
  /** `gcs` в бою, `local` — чтобы прогнать приёмку без бакета. */
  LOG_UPLOAD?: LogUploadMode;
  GCS_LOG_BUCKET?: string;
  /** Корень, внутри которого создаётся workspace рана. */
  WORKSPACE_ROOT?: string;
  /** Дополнительные флаги агенту (модель и т.п.), через пробел. */
  AGENT_ARGS?: string;
  /** `false` — запретить sudo, чтобы прогнать приёмку без создания пользователей. */
  ALLOW_SUDO?: string;
  /** `skip` — не ставить конфиг провайдера (агент уже сконфигурирован в репозитории). */
  AGENT_CONFIG?: string;
}

const startedAt = new Date();
/** Коды возврата самого раннера (не агента) — по ним видно, докуда дошла джоба. */
export const RUNNER_EXIT = {
  ok: 0,
  badEnv: 2,
  claimFailed: 3,
  preflightRefused: 4,
  cloneFailed: 5,
  agentFailed: 6,
  crashed: 7,
} as const;

function logLine(line: string): void {
  process.stdout.write(`[gha-runner] ${line}\n`);
}

class SessionLog {
  private ready = false;

  async open(filePath: string, header: string): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, header, 'utf8');
    this.filePath = filePath;
    this.ready = true;
  }

  private filePath = '';

  append(stream: 'stdout' | 'stderr', text: string): void {
    if (!this.ready) return;
    void appendFile(this.filePath, `[${stream}] ${text}`, 'utf8').catch(() => undefined);
  }
}

async function report(url: string, reportToken: string, result: LaunchResult): Promise<void> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${reportToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(result),
  });
  if (!response.ok) {
    const text = redact(await response.text(), reportToken).slice(0, 300);
    logLine(`report rejected (${response.status}): ${text}`);
    return;
  }
  logLine(`result reported: exitReason=${result.exitReason} artifacts=${result.artifacts.length}`);
}

function emptyResult(
  runId: string,
  repo: { fullName: string; branch: string },
  partial: Partial<LaunchResult> = {},
): LaunchResult {
  return {
    runId,
    status: 'failed',
    exitCode: null,
    exitSignal: null,
    exitReason: 'startup_failure',
    stdout: '',
    stderr: '',
    answerSource: null,
    durationMs: Date.now() - startedAt.getTime(),
    timedOut: false,
    outputTruncated: false,
    artifacts: [],
    logUrl: '',
    repo: { fullName: repo.fullName, branch: repo.branch, commit: NULL_SHA },
    ...partial,
    // `pid` фиксирован: его не должен перебить ни один вызов.
    pid: null,
  };
}

/**
 * Клон репозитория юзера в workspace рана.
 *
 * Токен передаётся через `GIT_CONFIG_*` в окружении, а не в URL аргумента: argv
 * виден любому процессу на хосте через `ps`, и issue #73, п.4 требует, чтобы секреты
 * рана не покидали хост.
 *
 * Отклонение от ТЗ: клонирует воркер, а не наш API. У GHA-джобы нет общей файловой
 * системы с нашим API — «уже склонированный workspace» через HTTP не передаётся.
 */
async function cloneWorkspace(
  spec: LaunchRequest,
  workspace: string,
  token: string,
  identity: Identity,
): Promise<void> {
  await mkdir(workspace, { recursive: true });
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  // Клон обязан идти под идентичностью рана: workspace принадлежит ей, и под
  // пользователем раннера `git clone` падает с «Permission denied» на `.git`.
  await runUnderIdentity(identity, 'git', ['clone', '--depth', '1', '--quiet', `https://github.com/${spec.repository.fullName}.git`, workspace], {
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    // HOME — home идентичности: git пишет в `$HOME/.config/git`, а у раннера он 700.
    HOME: identity.home,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  });
}

/** Шаг, который может отказать до старта агента. */
type Step<T> = { ok: true; value: T } | { ok: false; failure: Failure; exit: number };

interface PreparedWorkspace {
  identity: Identity;
  workspace: string;
  artifactsToken: string;
  logFile: string;
}

/**
 * Готовит workspace рана: идентичность, права, клон репозитория.
 *
 * Отказы собираются здесь, а не размазываются по `main()`: раньше на каждый отказ
 * приходилось повторять `await report(...); return RUNNER_EXIT.x`, и из-за этого
 * добавление новой проверки было легче пропустить, чем сделать.
 *
 * Функция владеет идентичностью до успешного возврата: на любом отказе после
 * `createRunIdentity` она убирает её сама, иначе пользователь остался бы висеть в
 * системе, а `finally` в `main()` до него уже не добрался бы.
 */
async function prepareWorkspace(options: {
  env: RunnerEnv;
  spec: LaunchRequest;
  runId: string;
  allowSudo: boolean;
}): Promise<Step<PreparedWorkspace>> {
  const { env, spec, runId, allowSudo } = options;
  const workspaceRoot = env.WORKSPACE_ROOT ?? process.env['RUNNER_WORKSPACE'] ?? process.cwd();
  const workspace = path.resolve(workspaceRoot, path.basename(spec.cwd));
  // Через sudo: прошлый рана мог оставить каталог, принадлежащий своей идентичности,
  // и обычный `rm` его не удалит.
  await exec('sudo', ['rm', '-rf', workspace]);

  const identity = await createRunIdentity({
    runId,
    workspace,
    allowSudo,
    sharedBinDir: process.env['RUNNER_TOOL_CACHE'] ?? undefined,
  });

  const refuse = async (failure: Failure, exit: number): Promise<Step<PreparedWorkspace>> => {
    await destroyRunIdentity(identity);
    return { ok: false, failure, exit };
  };

  if (spec.isolation.mode === 'per_run_unix_identity' && !identity.enforced) {
    return refuse(
      failure(
        'ISOLATION_UNSUPPORTED',
        'preflight',
        'passwordless sudo is unavailable on this runner, per_run_unix_identity cannot be enforced',
      ),
      RUNNER_EXIT.preflightRefused,
    );
  }
  logLine(`identity=${identity.name} uid=${identity.uid} enforced=${identity.enforced}`);

  const artifactsToken = env.ARTIFACTS_TOKEN ?? '';
  if (artifactsToken.length === 0) {
    return refuse(
      failure(
        'WORKER_INTERNAL',
        'preflight',
        'ARTIFACTS_TOKEN is unset: the runner cannot clone repository.fullName nor push artifacts',
      ),
      RUNNER_EXIT.preflightRefused,
    );
  }

  try {
    await cloneWorkspace(spec, workspace, artifactsToken, identity);
  } catch (cause) {
    const safeSummary = redact(cause instanceof Error ? cause.message : String(cause), artifactsToken);
    logLine(`clone failed: ${safeSummary}`);
    return refuse(
      failure('WORKER_INTERNAL', 'engine', `clone of ${spec.repository.fullName} failed: ${safeSummary}`),
      RUNNER_EXIT.cloneFailed,
    );
  }

  // Лог сессии живёт ВНЕ workspace. Workspace принадлежит идентичности рана
  // (755, owner — uid рана), и процесс раннера не может писать в него: `EACCES
  // ... mkdir .agent`. Кроме того, агент не должен видеть свой же лог в
  // собственной рабочей папке, а артефакты собираются из объявленных путей.
  return {
    ok: true,
    value: {
      identity,
      workspace,
      artifactsToken,
      logFile: path.join(workspaceRoot, 'session-logs', runId, 'session.log'),
    },
  };
}

interface RepoRef {
  fullName: string;
  branch: string;
  commit: string;
}

/**
 * Кладёт выходы рана в репозиторий юзера.
 *
 * Ветку задаёт наше API (`repository.branch`), а не воркер: только API знает `runId`,
 * и ветка — единица результата, которую API мержит одним действием.
 *
 * Неудача пуша не фатальна: она уходит в `stderr` ответа, потому что ран-то отработал,
 * и наш API должен увидеть его итог, а не потерять из-за проблемы с git.
 */
export async function publishArtifacts(options: {
  spec: LaunchRequest;
  runId: string;
  workspace: string;
  token: string;
  collected: CollectResult;
  outcome: ExecOutcome;
  startedAt: Date;
  sessionLog: Pick<SessionLog, 'append'>;
}): Promise<{ artifactRefs: ArtifactRef[]; repo: RepoRef; note: string | null }> {
  const { spec, runId, token, collected, outcome, startedAt, sessionLog } = options;
  const fallback: RepoRef = { fullName: spec.repository.fullName, branch: spec.repository.branch, commit: NULL_SHA };

  const files = [...collected.files];
  const availableArtifacts = collected.artifacts;
  // Манифест кладём всегда: результат должен читаться из ветки, даже если выходов нет.
  files.push({
    path: 'artifacts/run-manifest.json',
    content: buildManifest({
      runId,
      jobId: spec.jobId,
      exitReason: outcome.exitReason,
      exitCode: outcome.exitCode,
      durationMs: outcome.durationMs,
      artifacts: availableArtifacts,
      missingOutputs: collected.missing,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
    }),
  });

  try {
    const pushed = await new GitHubRepoApi({ token, repo: spec.repository.fullName }).pushFiles({
      branch: spec.repository.branch,
      commitMessage: `opencode-gha-runner: ${runId} (${outcome.exitReason})`,
      files,
    });
    sessionLog.append(
      'stdout',
      `\npushed ${pushed.pushed.length} file(s) to ${pushed.fullName}@${pushed.branch} @ ${pushed.commit}\n`,
    );
    return {
      artifactRefs: availableArtifacts,
      repo: { fullName: pushed.fullName, branch: pushed.branch, commit: pushed.commit },
      note: null,
    };
  } catch (cause) {
    const safeSummary = redact(cause instanceof Error ? cause.message : String(cause), token);
    logLine(`artifact push failed: ${safeSummary}`);
    return { artifactRefs: [], repo: fallback, note: `artifact push failed: ${safeSummary}` };
  }
}

/**
 * Собирает `LaunchResult`. Чистая функция — поэтому её форма (ровно то, что валидирует
 * наш API) проверяется тестом, а не только боевым прогоном.
 */
export function buildLaunchResult(input: {
  runId: string;
  outcome: ExecOutcome;
  answer: { text?: string; source: AnswerSource };
  artifacts: ArtifactRef[];
  repo: RepoRef;
  logUrl: string;
  outputTruncated: boolean;
  failure?: Failure;
  outputs?: OutputSpec[];
  missingOutputs?: string[];
  publicationFailed?: boolean;
}): LaunchResult {
  const outputFailure = input.outcome.exitReason === 'completed' ? declaredOutputFailure(input.outputs, {
    missing: input.missingOutputs ?? [], artifacts: input.artifacts, commit: input.repo.commit, failed: input.publicationFailed ?? false,
  }) : undefined;
  const outcome = outputFailure ? { ...input.outcome, exitReason: 'nonzero_exit' as const } : input.outcome;
  return {
    runId: input.runId,
    // `started` — движок отработал (в том числе с ненулевым кодом или таймаутом).
    // `failed` зарезервирован за «воркер не смог запустить», и такие случаи уходят
    // через emptyResult() до этой точки.
    status: 'started',
    // pid процесса агента: агент живёт в GHA-джобе, на другой машине, поэтому здесь
    // честный null, а не pid процесса, который к нему отношения не имеет.
    pid: null,
    exitCode: outcome.exitCode,
    exitSignal: outcome.exitSignal,
    exitReason: outcome.exitReason,
    stdout: outcome.stdout,
    stderr: outcome.stderr,
    answer: input.answer.text,
    answerSource: input.answer.source,
    durationMs: outcome.durationMs,
    timedOut: outcome.timedOut,
    outputTruncated: input.outputTruncated,
    artifacts: input.artifacts,
    logUrl: input.logUrl,
    repo: input.repo,
    ...(input.failure ?? outputFailure ? { failure: input.failure ?? outputFailure } : {}),
  };
}

export async function main(env: RunnerEnv = process.env as unknown as RunnerEnv): Promise<number> {
  const gatewayUrl = env.GATEWAY_URL?.replace(/\/+$/, '');
  const { RUN_ID: runId, CLAIM_TOKEN: claimToken } = env;

  if (!gatewayUrl || !runId || !claimToken) {
    logLine('missing GATEWAY_URL / RUN_ID / CLAIM_TOKEN — nothing to claim');
    return RUNNER_EXIT.badEnv;
  }

  const sessionLog = new SessionLog();
  let claim: ClaimPayload | null = null;
  let identity: Identity | null = null;

  try {
    // ── 1. claim ──────────────────────────────────────────────────────────────
    const claimResponse = await fetch(`${gatewayUrl}/v1/claim`, {
      method: 'POST',
      headers: { authorization: `Bearer ${claimToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ runId }),
    });
    if (!claimResponse.ok) {
      const text = redact(await claimResponse.text(), claimToken).slice(0, 300);
      logLine(`claim failed (${claimResponse.status}): ${text}`);
      // Отчитаться нечем: report-токен выдаётся только после успешного claim'а.
      // Наш API увидит `dispatched` без результата и разберётся по таймауту опроса.
      return RUNNER_EXIT.claimFailed;
    }
    claim = (await claimResponse.json()) as ClaimPayload;
    const spec = claim.spec;
    const reportUrl = `${gatewayUrl}${REPORT_PATH(runId)}`;
    // Локальная копия: в замыкании narrowing по `claim` не работает.
    const reportToken = claim.reportToken;
    const mcpSecrets = spec.mcpSecrets ?? {};
    const secrets = [claim.llmKey, env.ARTIFACTS_TOKEN, ...Object.values(mcpSecrets)];

    logLine(`claimed job=${spec.jobId} timeout=${spec.limits.timeoutMs}ms outputs=${spec.outputs?.length ?? 0}`);

    /**
     * Отказ до старта агента: наш API получает `LaunchResult` с `failure`, а не тишину.
     * Одно место на все отказы — иначе каждая новая проверка повторяет этот ритуал,
     * и однажды его забудут.
     */
    const refuse = async (f: Failure, exit: number): Promise<number> => {
      await report(reportUrl, reportToken, emptyResult(runId, spec.repository, { failure: f }));
      return exit;
    };

    // ── 2. preflight: бинарь агента и изоляция ─────────────────────────────────
    if (!(await isBinaryAvailable(claim.agentBinary))) {
      return refuse(
        failure('AGENT_BINARY_MISSING', 'preflight', `agent binary "${claim.agentBinary}" not found`),
        RUNNER_EXIT.preflightRefused,
      );
    }

    const allowSudo = (env.ALLOW_SUDO ?? 'true') !== 'false';
    if (spec.isolation.mode === 'per_run_unix_identity' && !allowSudo) {
      return refuse(
        failure(
          'ISOLATION_UNSUPPORTED',
          'preflight',
          'run requested per_run_unix_identity but the runner was started with ALLOW_SUDO=false',
        ),
        RUNNER_EXIT.preflightRefused,
      );
    }

    // ── 3. workspace и идентичность рана ───────────────────────────────────────
    const prepared = await prepareWorkspace({ env, spec, runId, allowSudo });
    if (!prepared.ok) return refuse(prepared.failure, prepared.exit);
    identity = prepared.value.identity;
    const { workspace, artifactsToken, logFile } = prepared.value;
    // Алиас без `| null`: ниже identity используется в замыканиях, где narrowing не работает.
    const identityOfRun = prepared.value.identity;
    let agentConfigPath = '';

    await sessionLog.open(
      logFile,
      `# run ${runId} job ${spec.jobId} started ${startedAt.toISOString()}\nagent=${claim.agentBinary}\n`,
    );

    // Провайдер агента: без этого opencode ушёл бы в свой дефолтный и упал бы на
    // авторизации уже после старта — как `nonzero_exit`, а не как preflight-отказ.
    // Отказ здесь не фатален: без конфига агент упадёт с кодом, и это видно в ответе.
    if (env.AGENT_CONFIG !== 'skip') {
      try {
        agentConfigPath = await installAgentConfigUnderIdentity({
          identity: identityOfRun,
          llmKeyEnvName: claim.llmKeyEnvName,
          mcpServers: spec.mcp?.servers,
          stagingDir: path.dirname(logFile),
        });
        const mcpCount = Object.keys(spec.mcp?.servers ?? {}).length;
        logLine(`agent config installed: ${agentConfigPath}${mcpCount > 0 ? ` (mcp servers: ${mcpCount})` : ''}`);
      } catch (cause) {
        const safeSummary = redact(cause instanceof Error ? cause.message : String(cause));
        logLine(`agent config not installed: ${safeSummary}`);
      }
    }

    // ── 4. запуск агента ───────────────────────────────────────────────────────
    const processEnv = resolveAgentEnv({
      envAllowlist: spec.envAllowlist,
      env: spec.env,
      identityHome: identity.home,
      llmKeyEnvName: claim.llmKeyEnvName,
      llmKey: claim.llmKey,
      isolationEnforced: identity.enforced,
      injectedSecrets: mcpSecrets,
    });
    const extraArgs = (env.AGENT_ARGS ?? '').split(' ').filter(Boolean);
    const agentArgs = [...extraArgs, 'run', buildAgentPrompt(spec.input.inlinePrompt, spec.outputs)];
    // Промпт в лог не пишем: он может содержать секреты, а лог уезжает в GCS.
    sessionLog.append('stdout', `\n$ ${claim.agentBinary} ${extraArgs.join(' ')} run <prompt>\n`);

    const outcome = await runAgent({
      identity,
      binary: claim.agentBinary,
      argv: agentArgs,
      env: processEnv,
      timeoutMs: clampTimeout(spec.limits.timeoutMs),
      maxOutputBytes: spec.limits.maxOutputBytes,
      secrets,
      onChunk: (stream, text) => sessionLog.append(stream, text),
    });
    logLine(`agent exitReason=${outcome.exitReason} duration=${outcome.durationMs}ms truncated=${outcome.outputTruncated}`);

    // ── 5. артефакты в репозиторий юзера ───────────────────────────────────────
    const collected = await collectArtifacts(workspace, spec.outputs);
    const published = await publishArtifacts({
      spec,
      runId,
      workspace,
      token: artifactsToken,
      collected,
      outcome,
      startedAt,
      sessionLog,
    });
    if (published.note) outcome.stderr += `\n${published.note}\n`;

    // ── 6. лог сессии в GCS ───────────────────────────────────────────────────
    let logUrl = '';
    let logTruncated = false;
    try {
      const uploaded = await uploadSessionLog({
        mode: env.LOG_UPLOAD === 'local' ? 'local' : 'gcs',
        bucket: env.GCS_LOG_BUCKET,
        runId,
        localPath: logFile,
        maxLogBytes: spec.limits.maxLogBytes,
      });
      logUrl = uploaded.logUrl;
      logTruncated = uploaded.truncated;
      logLine(`log uploaded: ${logUrl}${uploaded.truncated ? ' (truncated)' : ''}`);
    } catch (cause) {
      const safeSummary = redact(cause instanceof Error ? cause.message : String(cause));
      logLine(`log upload failed: ${safeSummary}`);
      outcome.stderr += `\nlog upload failed: ${safeSummary}\n`;
    }

    // ── 7. ответ нашему API ────────────────────────────────────────────────────
    const answer = extractAnswer(workspace, outcome.stdout, agentOutputFormat(extraArgs));
    const engineFailure = failureForOutcome(outcome.exitReason, collected.missing);
    const result = buildLaunchResult({
      runId,
      outcome,
      answer,
      artifacts: published.artifactRefs,
      repo: published.repo,
      logUrl,
      outputTruncated: outcome.outputTruncated || logTruncated,
      failure: engineFailure,
      outputs: spec.outputs,
      missingOutputs: collected.missing,
      publicationFailed: published.note !== null,
    });
    await report(reportUrl, claim.reportToken, result);
    return result.exitReason === 'completed' ? RUNNER_EXIT.ok : RUNNER_EXIT.agentFailed;
  } catch (cause) {
    const safeSummary = redact(cause instanceof Error ? cause.message : String(cause), claim?.llmKey);
    logLine(`runner crashed: ${safeSummary}`);
    if (claim) {
      await report(
        `${gatewayUrl}${REPORT_PATH(runId)}`,
        claim.reportToken,
        emptyResult(runId, claim.spec.repository, {
          failure: failure('WORKER_INTERNAL', 'finalization', safeSummary),
          stderr: safeSummary,
        }),
      );
    }
    return RUNNER_EXIT.crashed;
  } finally {
    if (identity) await destroyRunIdentity(identity);
  }
}

function failureForOutcome(
  exitReason: string,
  missingOutputs: string[],
): LaunchResult['failure'] | undefined {
  if (exitReason === 'timeout') {
    return failure('AGENT_TIMEOUT', 'runtime', 'agent exceeded limits.timeoutMs');
  }
  if (exitReason === 'crash') {
    return failure('AGENT_CRASH', 'runtime', 'agent was killed by a signal');
  }
  if (exitReason === 'nonzero_exit') {
    return failure(
      'AGENT_NONZERO_EXIT',
      'engine',
      missingOutputs.length > 0 ? `agent exited non-zero; missing outputs: ${missingOutputs.join(', ')}` : 'agent exited non-zero',
    );
  }
  return undefined;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((cause) => {
      process.stderr.write(`[gha-runner] fatal: ${redact(String(cause))}\n`);
      process.exitCode = RUNNER_EXIT.crashed;
    });
}
