import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claimRequestHeaders, type ClaimPayload } from '../src/claim.js';
import type { LaunchRequest } from '../src/contracts.js';
import { createGateway } from '../src/gateway/app.js';
import { MemoryRunStore } from '../src/gateway/store.js';
import { resolveAgentEnv } from '../src/runner/exec.js';
import { main, RUNNER_EXIT } from '../src/runner/main.js';
import worker from '../src/worker.js';

const hostSecret = 'synthetic-host-claim-auth';
const publicToken = 'synthetic-public-claim-token';
const runId = 'synthetic-claim-run';

async function harness(required: boolean, secret?: string) {
  const store = new MemoryRunStore();
  const spec: LaunchRequest = {
    runId, jobId: 'job-1', userTaskId: 'task-1', profileId: 'profile-1', conversationId: 'conv-1', operationId: 'op-1', ownerGeneration: 1,
    engine: { name: 'dynamic-ip-azure-agent-run', adapterVersion: '1' }, input: { inlinePrompt: 'Original goal' }, cwd: '/workspace',
    envAllowlist: ['PATH'], env: {}, limits: { timeoutMs: 300000, maxOutputBytes: 1024, maxLogBytes: 1024 },
    repository: { fullName: 'owner/repo', branch: 'agent-run/result' }, resultUrl: 'https://example.test/result',
    isolation: { mode: 'per_run_unix_identity' }, credentials: { llmKey: 'synthetic-model-key' }, mcpSecrets: { MCP_KEY: 'synthetic-mcp-key' },
  };
  await store.create({ runId, operationId: spec.operationId, request: spec, phase: 'dispatched', createdAt: Date.now(), updatedAt: Date.now(), githubRunId: null,
    target: { repo: 'owner/repo', token: 'synthetic-host-pat' }, claimToken: publicToken, reportToken: 'synthetic-report-token', result: null });
  const logs: unknown[] = [];
  const app = createGateway({ config: { workerToken: 'synthetic-worker-token', repo: 'owner/repo', workflow: 'run-agent.yml', publicBaseUrl: 'https://example.test', agentBinary: 'opencode', githubToken: 'synthetic-host-pat', requireClaimAuth: required, claimAuthToken: secret }, store,
    log: (message, fields) => logs.push({ message, fields }) });
  return { store, app, logs };
}

function request(secret?: string, token = publicToken): Request {
  return new Request('https://example.test/v1/claim', { method: 'POST', headers: claimRequestHeaders(token, secret), body: JSON.stringify({ runId }) });
}

test('public token, anonymous caller and wrong host auth fail before claim lookup without consuming the token', async (context) => {
  const { store, app } = await harness(true, hostSecret);
  const lookup = context.mock.method(store, 'claim');
  for (const req of [request(), request('wrong-host-secret'), request(publicToken), new Request('https://example.test/v1/claim', { method: 'POST', body: 'malformed' })]) {
    assert.equal((await app.fetch(req)).status, 401);
  }
  assert.equal(lookup.mock.callCount(), 0);
  assert.equal((await store.get(runId))!.phase, 'dispatched');
  assert.equal((await app.fetch(request(hostSecret))).status, 200);
});

test('required host auth missing from config fails closed with 503 before claim lookup', async (context) => {
  for (const secret of [undefined, '', '   ']) {
    const { store, app } = await harness(true, secret);
    const lookup = context.mock.method(store, 'claim');
    const response = await app.fetch(request(hostSecret));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'claim_auth_unconfigured' });
    assert.equal(lookup.mock.callCount(), 0);
  }
});

test('correct host auth retains original claim wire and one-use behavior, without host credentials in payload or logs', async () => {
  const { app, logs } = await harness(true, hostSecret);
  const headers = claimRequestHeaders(publicToken, hostSecret);
  assert.equal(headers.authorization, `Bearer ${publicToken}`);
  assert.equal(headers['x-claim-host-auth'], `Bearer ${hostSecret}`);
  const response = await app.fetch(request(hostSecret));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const payload = await response.json() as ClaimPayload;
  assert.equal(payload.llmKey, 'synthetic-model-key');
  assert.equal(payload.spec.mcpSecrets!.MCP_KEY, 'synthetic-mcp-key');
  assert.ok(!JSON.stringify(payload).includes(hostSecret));
  assert.ok(!JSON.stringify(payload).includes('synthetic-host-pat'));
  assert.ok(!JSON.stringify(logs).includes(hostSecret));
  assert.equal((await app.fetch(request())).status, 401);
  assert.equal((await app.fetch(request(hostSecret))).status, 409);
});

test('disabled host guard retains legacy bearer-only claims', async () => {
  const { app } = await harness(false, hostSecret);
  assert.deepEqual(claimRequestHeaders(publicToken), { authorization: `Bearer ${publicToken}`, 'content-type': 'application/json' });
  assert.equal((await app.fetch(request())).status, 200);
  assert.equal((await app.fetch(request())).status, 409);
});

test('claim client adds only a host header and redacts reflected auth in failure logs', async (context) => {
  let calls = 0;
  let output = '';
  context.mock.method(process.stdout, 'write', (chunk: unknown) => { output += String(chunk); return true; });
  context.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    calls += 1;
    assert.deepEqual(init?.headers, claimRequestHeaders(publicToken, hostSecret));
    assert.deepEqual(JSON.parse(String(init?.body)), { runId });
    return new Response(`${hostSecret} ${publicToken}`, { status: 401 });
  });
  assert.equal(await main({ GATEWAY_URL: 'https://example.test', RUN_ID: runId, CLAIM_TOKEN: publicToken, REQUIRE_CLAIM_AUTH: 'true', CLAIM_AUTH_TOKEN: hostSecret }), RUNNER_EXIT.claimFailed);
  assert.equal(calls, 1);
  assert.ok(!output.includes(hostSecret));
  assert.ok(!output.includes(publicToken));
});

test('required claim client without host secret refuses before any network call', async (context) => {
  let calls = 0;
  context.mock.method(globalThis, 'fetch', async () => { calls += 1; throw new Error('No network allowed'); });
  assert.equal(await main({ GATEWAY_URL: 'https://example.test', RUN_ID: runId, CLAIM_TOKEN: publicToken, REQUIRE_CLAIM_AUTH: 'true' }), RUNNER_EXIT.badEnv);
  assert.equal(calls, 0);
});

test('host environment credential is never inherited into model env, even if its name is allowlisted without an explicit spec value', () => {
  const previous = process.env.CLAIM_AUTH_TOKEN;
  process.env.CLAIM_AUTH_TOKEN = hostSecret;
  try {
    const modelEnv = resolveAgentEnv({ envAllowlist: ['CLAIM_AUTH_TOKEN'], env: {}, identityHome: '/isolated/home', llmKeyEnvName: 'MODEL_KEY', llmKey: 'synthetic-model-key' });
    assert.ok(!('CLAIM_AUTH_TOKEN' in modelEnv));
    assert.ok(!JSON.stringify(modelEnv).includes(hostSecret));
  } finally {
    if (previous === undefined) delete process.env.CLAIM_AUTH_TOKEN;
    else process.env.CLAIM_AUTH_TOKEN = previous;
  }
});

test('Worker env enables fail-closed host guard before touching KV', async () => {
  const response = await worker.fetch(request(), { RUNS: { get: async () => { throw new Error('KV must not be accessed'); }, put: async () => {}, delete: async () => {}, list: async () => ({ keys: [], list_complete: true }) }, WORKER_TOKEN: 'synthetic-worker-token', GITHUB_TOKEN: 'synthetic-host-pat', GITHUB_REPO: 'owner/repo', PUBLIC_BASE_URL: 'https://example.test', REQUIRE_CLAIM_AUTH: 'true' });
  assert.equal(response.status, 503);
});
