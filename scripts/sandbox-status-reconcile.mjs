import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const githubRunId = Number(process.argv[2]);
if (!Number.isSafeInteger(githubRunId) || githubRunId <= 0) {
  throw new Error('Usage: npm run smoke:sandbox-status -- <completed-public-github-actions-run-id>');
}

const apiBase = 'https://api.github.com/repos/kobzevvv/opencode-gha-runner/actions/runs';
const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
const githubResponse = await fetch(`${apiBase}/${githubRunId}`, { headers });
if (!githubResponse.ok) throw new Error(`GitHub Actions run lookup failed: HTTP ${githubResponse.status}`);
const githubRun = await githubResponse.json();
if (githubRun.status !== 'completed' || !githubRun.conclusion || githubRun.conclusion === 'success') {
  throw new Error(`Expected a completed failed/cancelled run; got ${githubRun.status}/${githubRun.conclusion}`);
}

const tempDir = mkdtempSync(join(tmpdir(), 'gha-gateway-sandbox-probe-'));
const runId = `sandbox_probe_${githubRunId}_${Date.now()}`;
const key = `run:${runId}`;
const config = join(process.cwd(), 'wrangler.toml');
const workerToken = process.env.SANDBOX_WORKER_TOKEN;
const oldEnough = Date.now() - 120_000;

function secretFromKeychain() {
  try {
    return execFileSync('security', ['find-generic-password', '-s', 'opencode-gha-runner-gateway-sandbox', '-a', 'WORKER_TOKEN', '-w'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

const token = workerToken || secretFromKeychain();
if (!token) throw new Error('Set SANDBOX_WORKER_TOKEN or store it in macOS Keychain (service opencode-gha-runner-gateway-sandbox, account WORKER_TOKEN)');

function wrangler(args, input) {
  execFileSync('npx', ['wrangler', ...args, '--config', config, '--env', 'sandbox'], {
    cwd: process.cwd(),
    input,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
}

function listSandboxKeys() {
  const listed = execFileSync('npx', ['wrangler', 'kv', 'key', 'list', '--binding', 'RUNS', '--config', config, '--env', 'sandbox'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return JSON.parse(listed);
}

async function cleanupProbeKey() {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      wrangler(['kv', 'key', 'delete', key, '--binding', 'RUNS'], undefined);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
  throw lastError;
}

let seeded = false;
try {
  const record = {
    credentialId: 'primary',
    runId,
    operationId: `op_${runId}`,
    request: {
      runId,
      jobId: 'sandbox-probe',
      userTaskId: 'sandbox-probe',
      profileId: 'sandbox-probe',
      conversationId: 'sandbox-probe',
      operationId: `op_${runId}`,
      ownerGeneration: 1,
      engine: { name: 'opencode', adapterVersion: 'sandbox-probe' },
      input: { inlinePrompt: 'synthetic gateway status probe' },
      cwd: '/tmp/sandbox-probe',
      envAllowlist: [],
      env: {},
      limits: { timeoutMs: 1000, maxOutputBytes: 1024, maxLogBytes: 1024 },
      repository: { fullName: 'kobzevvv/opencode-gha-runner', branch: 'sandbox-probe' },
      resultUrl: 'https://callback.example.invalid/sandbox-probe',
      isolation: { mode: 'none' },
    },
    phase: 'dispatched',
    createdAt: oldEnough,
    updatedAt: oldEnough,
    githubRunId,
    target: { repo: 'kobzevvv/opencode-gha-runner', workflow: 'run-agent.yml', ref: 'fix/profile-snapshot-write-permissions-20261008', token: '' },
    claimToken: 'synthetic-claim-token',
    reportToken: 'synthetic-report-token',
    result: null,
  };
  const file = join(tempDir, 'run.json');
  writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
  wrangler(['kv', 'key', 'put', key, '--binding', 'RUNS', '--path', file, '--ttl', '600'], undefined);
  seeded = true;

  // KV is eventually consistent. Poll until this exact record is visible and the
  // Worker reconciles the terminal GitHub failure.
  let status = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const poll = await fetch(`https://opencode-gha-runner-gateway-sandbox.skillset-apply.workers.dev/v1/runs/${runId}/status`, {
      headers: { authorization: `Bearer ${token}` },
    });
    status = await poll.json();
    if (poll.ok && status.status === 'failed') break;
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 31_000));
  }
  if (status?.status !== 'failed') {
    throw new Error(`Expected gateway status failed; got ${JSON.stringify(status)}`);
  }

  const resultResponse = await fetch(`https://opencode-gha-runner-gateway-sandbox.skillset-apply.workers.dev/v1/runs/${runId}/result`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const result = await resultResponse.json();
  if (!resultResponse.ok || result.exitReason !== (githubRun.conclusion === 'cancelled' ? 'cancelled' : 'startup_failure')) {
    throw new Error(`Unexpected gateway result: HTTP ${resultResponse.status}, ${JSON.stringify(result)}`);
  }
  if (result.runId !== runId || result.failure?.code !== (githubRun.conclusion === 'cancelled' ? undefined : 'WORKER_INTERNAL')) {
    throw new Error(`Unexpected result fields: ${JSON.stringify(result)}`);
  }
  console.log(JSON.stringify({ githubRunId, conclusion: githubRun.conclusion, gatewayStatus: status.status, exitReason: result.exitReason, resultRunId: result.runId }, null, 2));
} finally {
  if (seeded) {
    try { await cleanupProbeKey(); }
    catch (error) { console.error(`WARNING: remove sandbox KV key ${key} manually; cleanup failed: ${error.message}`); }
  }
  rmSync(tempDir, { recursive: true, force: true });
}

if (seeded) {
  const keys = listSandboxKeys();
  if (keys.some((entry) => entry.name === key)) throw new Error(`Sandbox KV cleanup did not remove ${key}`);
}
