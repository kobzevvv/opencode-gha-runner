import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('integration deployment declares its own Worker and unprovisioned KV, never the shared namespace', () => {
  const sandbox = readFileSync('wrangler.integration-v1.toml', 'utf8');
  const shared = readFileSync('wrangler.toml', 'utf8');
  assert.ok(sandbox.includes('name = "trained-assist-native-worker-v1-sandbox"'));
  assert.ok(sandbox.includes('id = "REPLACE_WITH_OWN_KV_NAMESPACE_ID"'));
  const sharedKv = shared.match(/^id = "([^"]+)"/m)?.[1];
  assert.ok(sharedKv);
  assert.ok(!sandbox.includes(sharedKv));
  assert.ok(sandbox.includes('GITHUB_REF = "integration/final-answer-v1-20261005"'));
  assert.ok(!sandbox.includes('RING_TARGETS'));
});

test('branch workflow claim URL equals its owned config endpoint and checkout pins the admitted source SHA', () => {
  const sandbox = readFileSync('wrangler.integration-v1.toml', 'utf8');
  const workflow = readFileSync('.github/workflows/run-agent.yml', 'utf8');
  const endpoint = sandbox.match(/^PUBLIC_BASE_URL = "([^"]+)"/m)?.[1];
  const branch = sandbox.match(/^GITHUB_REF = "([^"]+)"/m)?.[1];
  assert.ok(endpoint && branch);
  assert.ok(workflow.includes(`GATEWAY_URL: \${{ github.ref_name == '${branch}' && '${endpoint}' || vars.GATEWAY_URL }}`));
  assert.ok(workflow.includes('ref: ${{ github.sha }}'));
  assert.ok(workflow.includes(`AGENT_OUTPUT_FORMAT: \${{ github.ref_name == '${branch}' && 'json' || '' }}`));
  assert.ok(workflow.includes('AGENT_ARGS: ${{ vars.AGENT_ARGS }}'));
});
