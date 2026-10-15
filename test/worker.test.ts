import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker, { clientTokensFromEnv } from '../src/worker.js';

test('Cloudflare named token bindings become lower-case stable client IDs', () => {
  const tokens = clientTokensFromEnv({
    RUNS: {} as never,
    WORKER_CLIENT_TOKEN_SANDBOX3_AGENT_API: 'a'.repeat(32),
    WORKER_CLIENT_TOKEN_SANDBOX4_AGENT_API: 'b'.repeat(32),
    WORKER_TOKEN: 'primary',
    GITHUB_TOKEN: 'github',
    GITHUB_REPO: 'owner/repo',
    PUBLIC_BASE_URL: 'https://gateway.example',
  });
  assert.deepEqual(tokens, {
    sandbox3_agent_api: 'a'.repeat(32),
    sandbox4_agent_api: 'b'.repeat(32),
  });
});

test('gateway reports the exact deployed source SHA', async () => {
  const response = await worker.fetch(new Request('https://gateway.example/version'), {
    BUILD_SHA: 'a'.repeat(40),
  } as never);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), {
    service: 'opencode-gha-runner-gateway',
    buildSha: 'a'.repeat(40),
  });
});
