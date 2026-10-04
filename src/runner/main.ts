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
import { readFileSync } from 'node:fs';
import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { RESULT_PATH, type ClaimPayload } from '../claim.js';
import {
  clampTimeout,
  failure,
  redact,
  type ArtifactRef,
  type LaunchRequest,
  type LaunchResult,
} from '../contracts.js';
import { GitHubRepoApi, artifactBranch, buildManifest, collectArtifacts } from './artifacts.js';
import { resolveAgentEnv, runAgent } from './exec.js';
import { createRunIdentity, destroyRunIdentity, isBinaryAvailable, runUnderIdentity, type Identity } from './identity.js';
import { installAgentConfig } from './agent-config.js';
import { uploadSessionLog, type LogUploadMode } from './logs.js';

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

function emptyResult(runId: string, repoFullName: string, partial: Partial<LaunchResult> = {}): LaunchResult {
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
    repo: { fullName: repoFullName, commit: null },
    ...partial,
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
    const reportUrl = `${gatewayUrl}${RESULT_PATH(runId)}`;
    const secrets = [claim.llmKey, env.ARTIFACTS_TOKEN];

    logLine(`claimed job=${spec.jobId} timeout=${spec.limits.timeoutMs}ms outputs=${spec.outputs?.length ?? 0}`);

    // ── 2. preflight: бинарь агента и изоляция ─────────────────────────────────
    if (!(await isBinaryAvailable(claim.agentBinary))) {
      await report(
        reportUrl,
        claim.reportToken,
        emptyResult(runId, spec.repository.fullName, {
          failure: failure('AGENT_BINARY_MISSING', 'preflight', `agent binary "${claim.agentBinary}" not found`),
        }),
      );
      return RUNNER_EXIT.preflightRefused;
    }

    const allowSudo = (env.ALLOW_SUDO ?? 'true') !== 'false';
    if (spec.isolation.mode === 'per_run_unix_identity' && !allowSudo) {
      await report(
        reportUrl,
        claim.reportToken,
        emptyResult(runId, spec.repository.fullName, {
          failure: failure(
            'ISOLATION_UNSUPPORTED',
            'preflight',
            'run requested per_run_unix_identity but the runner was started with ALLOW_SUDO=false',
          ),
        }),
      );
      return RUNNER_EXIT.preflightRefused;
    }

    // ── 3. workspace и идентичность рана ───────────────────────────────────────
    const workspaceRoot = env.WORKSPACE_ROOT ?? process.env['RUNNER_WORKSPACE'] ?? process.cwd();
    const workspace = path.resolve(workspaceRoot, path.basename(spec.cwd));
    // Через sudo: прошлый рана мог оставить каталог, принадлежащий своей идентичности,
    // и обычный `rm` его не удалит.
    await exec('sudo', ['rm', '-rf', workspace]);

    identity = await createRunIdentity({
      runId,
      workspace,
      allowSudo,
      sharedBinDir: process.env['RUNNER_TOOL_CACHE'] ?? undefined,
    });
    if (spec.isolation.mode === 'per_run_unix_identity' && !identity.enforced) {
      await report(
        reportUrl,
        claim.reportToken,
        emptyResult(runId, spec.repository.fullName, {
          failure: failure(
            'ISOLATION_UNSUPPORTED',
            'preflight',
            'passwordless sudo is unavailable on this runner, per_run_unix_identity cannot be enforced',
          ),
        }),
      );
      return RUNNER_EXIT.preflightRefused;
    }
    logLine(`identity=${identity.name} uid=${identity.uid} enforced=${identity.enforced}`);
    // Алиас без `| null`: ниже identity используется в замыканиях, где narrowing не работает.
    const identityOfRun = identity;

    const artifactsToken = env.ARTIFACTS_TOKEN ?? '';
    if (artifactsToken.length === 0) {
      await report(
        reportUrl,
        claim.reportToken,
        emptyResult(runId, spec.repository.fullName, {
          failure: failure(
            'WORKER_INTERNAL',
            'preflight',
            'ARTIFACTS_TOKEN is unset: the runner cannot clone repository.fullName nor push artifacts',
          ),
        }),
      );
      return RUNNER_EXIT.preflightRefused;
    }

    try {
      await cloneWorkspace(spec, workspace, artifactsToken, identity);
    } catch (cause) {
      const safeSummary = redact(cause instanceof Error ? cause.message : String(cause), artifactsToken);
      logLine(`clone failed: ${safeSummary}`);
      await report(
        reportUrl,
        claim.reportToken,
        emptyResult(runId, spec.repository.fullName, {
          failure: failure('WORKER_INTERNAL', 'engine', `clone of ${spec.repository.fullName} failed: ${safeSummary}`),
        }),
      );
      return RUNNER_EXIT.cloneFailed;
    }

    // Лог сессии живёт ВНЕ workspace. Workspace принадлежит идентичности рана
    // (755, owner — uid рана), и процесс раннера не может писать в него: `EACCES
    // ... mkdir .agent`. Кроме того, агент не должен видеть свой же лог в
    // собственной рабочей папке, а артефакты собираются из объявленных путей.
    const logFile = path.join(workspaceRoot, 'session-logs', runId, 'session.log');
    await sessionLog.open(
      logFile,
      `# run ${runId} job ${spec.jobId} started ${startedAt.toISOString()}\nagent=${claim.agentBinary}\n`,
    );

    // Провайдер агента: без этого opencode ушёл бы в свой дефолтный и упал бы на
    // авторизации уже после старта — как `nonzero_exit`, а не как preflight-отказ.
    // Пишем под идентичностью: `~/.config/opencode` принадлежит UID рана.
    let agentConfigPath = '';
    if (env.AGENT_CONFIG !== 'skip') {
      try {
        agentConfigPath = await installAgentConfig({
          identityHome: identityOfRun.home,
          llmKeyEnvName: claim.llmKeyEnvName,
          write: async (target, contents) => {
            // Конфиг готовим в каталоге раннера, куда есть доступ от обоих UID, и
            // переносим под идентичность: `~/.config/opencode` принадлежит UID рана,
            // и прямая запись из процесса раннера падает с EACCES.
            const staging = path.join(workspaceRoot, 'session-logs', runId, 'opencode.json');
            await mkdir(path.dirname(staging), { recursive: true });
            // 0644, а не 0600: файл читает идентичность рана, а пишет раннер. Секрета
            // в нём нет — `apiKey` это ссылка `{env:ИМЯ}`, значение приходит в
            // процесс агента из claim'а.
            await writeFile(staging, contents, { encoding: 'utf8', mode: 0o644 });
            // `cp` не создаёт промежуточные каталоги, а `~/.config/opencode` у
            // свежесозданного пользователя отсутствует.
            await runUnderIdentity(identityOfRun, 'mkdir', ['-p', path.dirname(target)], {
              PATH: process.env['PATH'] ?? '/usr/bin:/bin',
              HOME: identityOfRun.home,
            });
            await runUnderIdentity(identityOfRun, 'cp', [staging, target], {
              PATH: process.env['PATH'] ?? '/usr/bin:/bin',
              HOME: identityOfRun.home,
            });
            // chmod — тоже под идентичностью: файл теперь принадлежит UID рана, и
            // раннер на нём получает EPERM.
            await runUnderIdentity(identityOfRun, 'chmod', ['600', target], {
              PATH: process.env['PATH'] ?? '/usr/bin:/bin',
              HOME: identityOfRun.home,
            });
          },
        });
        logLine(`agent config installed: ${agentConfigPath}`);
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
    });
    const extraArgs = (env.AGENT_ARGS ?? '').split(' ').filter(Boolean);
    const agentArgs = [...extraArgs, 'run', spec.input.inlinePrompt];
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
    let artifactRefs: ArtifactRef[] = [];
    let repoResult: { fullName: string; commit: string | null } = { fullName: spec.repository.fullName, commit: null };
    const repoApi = new GitHubRepoApi({ token: artifactsToken, repo: spec.repository.fullName });

    try {
      const files: Array<{ path: string; content: Buffer }> = [];
      for (const artifact of collected.artifacts) {
        const source = path.resolve(workspace, artifact.path.replace(/^artifacts\//, ''));
        try {
          files.push({ path: artifact.path, content: readFileSync(source) });
        } catch {
          logLine(`declared output vanished before push: ${artifact.path}`);
        }
      }
      files.push({
        path: 'artifacts/run-manifest.json',
        content: buildManifest({
          runId,
          jobId: spec.jobId,
          exitReason: outcome.exitReason,
          exitCode: outcome.exitCode,
          durationMs: outcome.durationMs,
          artifacts: collected.artifacts,
          missingOutputs: collected.missing,
          startedAt: startedAt.toISOString(),
          finishedAt: new Date().toISOString(),
        }),
      });

      const pushed = await repoApi.pushFiles({
        branch: artifactBranch(runId),
        commitMessage: `opencode-gha-runner: ${runId} (${outcome.exitReason})`,
        files,
      });
      repoResult = { fullName: pushed.fullName, commit: pushed.commit };
      artifactRefs = collected.artifacts;
      sessionLog.append(
        'stdout',
        `\npushed ${pushed.pushed.length} file(s) to ${pushed.fullName}@${pushed.branch} @ ${pushed.commit ?? 'no-commit'}\n`,
      );
    } catch (cause) {
      const safeSummary = redact(cause instanceof Error ? cause.message : String(cause), artifactsToken);
      logLine(`artifact push failed: ${safeSummary}`);
      outcome.stderr += `\nartifact push failed: ${safeSummary}\n`;
    }

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
    const answer = extractAnswer(workspace, outcome.stdout);
    const failureFor = failureForOutcome(outcome.exitReason, collected.missing);

    const result: LaunchResult = {
      runId,
      status: outcome.exitReason === 'completed' ? 'succeeded' : 'failed',
      exitCode: outcome.exitCode,
      exitSignal: outcome.exitSignal,
      exitReason: outcome.exitReason,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      answer: answer.text,
      answerSource: answer.source,
      durationMs: outcome.durationMs,
      timedOut: outcome.timedOut,
      outputTruncated: outcome.outputTruncated || logTruncated,
      artifacts: artifactRefs,
      logUrl,
      repo: repoResult,
      ...(failureFor ? { failure: failureFor } : {}),
    };
    await report(reportUrl, claim.reportToken, result);
    return outcome.exitReason === 'completed' ? RUNNER_EXIT.ok : RUNNER_EXIT.agentFailed;
  } catch (cause) {
    const safeSummary = redact(cause instanceof Error ? cause.message : String(cause), claim?.llmKey);
    logLine(`runner crashed: ${safeSummary}`);
    if (claim) {
      await report(
        `${gatewayUrl}${RESULT_PATH(runId)}`,
        claim.reportToken,
        emptyResult(runId, claim.spec.repository.fullName, {
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

/**
 * Ответ агента: сначала файл (`.agent/answer.txt` или `answer.txt`), иначе хвост stdout.
 * Файл приоритетнее — stdout может быть перемешан логами установки пакетов.
 */
function extractAnswer(
  workspace: string,
  stdout: string,
): { text?: string; source: 'engine_stdout' | 'agent_file' | null } {
  for (const candidate of ['.agent/answer.txt', 'answer.txt']) {
    try {
      const buffer = readFileSync(path.resolve(workspace, candidate));
      if (buffer.length > 0) return { text: buffer.toString('utf8').trim(), source: 'agent_file' };
    } catch {
      // Нет файла — пробуем следующий кандидата.
    }
  }
  const trimmed = stdout.trim();
  return trimmed.length > 0 ? { text: trimmed, source: 'engine_stdout' } : { source: null };
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
