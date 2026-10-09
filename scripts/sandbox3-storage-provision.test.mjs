import test from 'node:test';
import assert from 'node:assert/strict';
import { TARGET, addStorageGrant, validateCreatedKey, provisionSandbox3Storage } from './sandbox3-storage-provision.mjs';

const projectPermissions = ['iam.serviceAccounts.create', 'iam.serviceAccounts.get', 'iam.serviceAccountKeys.list', 'iam.serviceAccountKeys.create'];
const bucketPermissions = ['storage.buckets.getIamPolicy', 'storage.buckets.setIamPolicy'];
const identity = { email: TARGET.email, projectId: TARGET.project, displayName: TARGET.displayName };
const policy = () => ({ version: 3, etag: 'existing-etag', bindings: [
  { role: 'roles/storage.objectViewer', members: ['user:other@example.test'], condition: { title: 'keep', expression: 'true' } },
] });
const credentials = { type: 'service_account', project_id: TARGET.project, client_email: TARGET.email,
  private_key_id: 'a'.repeat(40), token_uri: 'https://oauth2.googleapis.com/token',
  private_key: '-----BEGIN PRIVATE KEY-----\nsynthetic-private-key\n-----END PRIVATE KEY-----\n' };
const key = () => ({ name: `projects/${TARGET.project}/serviceAccounts/${TARGET.email}/keys/${'a'.repeat(40)}`,
  privateKeyData: Buffer.from(JSON.stringify(credentials)).toString('base64') });
const response = (body, status = 200) => ({ status, body });
const permits = () => [response({ permissions: projectPermissions }), response({ permissions: bucketPermissions })];
function fixture(replies, secretPresent = false) {
  const calls = [], saved = [], evidence = {};
  return { calls, saved, evidence, options: {
    mode: 'apply', evidence, secretExists: async () => secretPresent,
    request: async (method, url, body) => {
      calls.push({ method, url, body });
      const next = replies.shift();
      assert.ok(next, 'unexpected request');
      if (next instanceof Error) throw next;
      return next;
    },
    saveSecret: async value => { saved.push(value); },
  } };
}

test('inspection reports missing capabilities without creating resources or keys', async () => {
  const f = fixture([response({ permissions: [] }), response({ permissions: bucketPermissions })]);
  f.options.mode = 'inspect';
  const proof = await provisionSandbox3Storage(f.options);
  assert.equal(proof.provisioningAllowed, false);
  assert.equal(proof.accountOutcome, 'not_attempted');
  assert.equal(proof.keyOutcome, 'not_attempted');
  assert.equal(f.calls.length, 2);
  assert.equal(f.saved.length, 0);
});
test('apply refuses missing IAM rights before account, policy or key mutation', async () => {
  const f = fixture([response({ permissions: [] }), response({ permissions: bucketPermissions })]);
  await assert.rejects(provisionSandbox3Storage(f.options), /permissions_missing/);
  assert.equal(f.calls.length, 2);
});
test('bucket grant preserves etag, conditional roles and other members without editing the input', () => {
  const input = policy();
  const before = JSON.stringify(input);
  const grant = addStorageGrant(input);
  assert.equal(JSON.stringify(input), before);
  assert.equal(grant.policy.etag, 'existing-etag');
  assert.deepEqual(grant.policy.bindings[0], input.bindings[0]);
  assert.deepEqual(grant.policy.bindings[1], { role: TARGET.role, members: [`serviceAccount:${TARGET.email}`] });
  assert.equal(addStorageGrant(grant.policy).changed, false);
  assert.throws(() => addStorageGrant({ ...input, etag: '' }), /policy_invalid/);
});
test('created credential reaches only the protected destination and never the proof', async () => {
  const input = policy();
  const granted = addStorageGrant(input).policy;
  const f = fixture([...permits(), response({}, 404), response(identity), response({ keys: [] }),
    response(input), response(granted), response(granted), response(key())]);
  const proof = await provisionSandbox3Storage(f.options);
  assert.equal(proof.credentialSaved, true);
  assert.equal(proof.credentialVerified, false);
  assert.equal(proof.keyOutcome, 'created');
  assert.equal(f.saved.length, 1);
  assert.deepEqual(JSON.parse(f.saved[0]), credentials);
  assert.equal(JSON.stringify(proof).includes('synthetic-private-key'), false);
  const write = f.calls.find(call => call.method === 'PUT');
  assert.deepEqual(write.body, granted);
});
test('existing destination never rotates credentials or mutates Google resources', async () => {
  const f = fixture(permits(), true);
  const proof = await provisionSandbox3Storage(f.options);
  assert.equal(proof.provisioningSkipped, 'destination_secret_exists');
  assert.equal(f.calls.length, 2);
  assert.equal(f.saved.length, 0);
});
test('an existing user-owned account is not adopted based only on its email', async () => {
  const f = fixture([...permits(), response({ ...identity, displayName: 'unrelated owner' })]);
  await assert.rejects(provisionSandbox3Storage(f.options), /owner_mismatch/);
  assert.equal(f.calls.length, 3);
});
test('lost key creation response is never retried or repaired by deleting other keys', async () => {
  const input = addStorageGrant(policy()).policy;
  const f = fixture([...permits(), response(identity), response({ keys: [] }), response(input), response(input), new Error('lost response')]);
  await assert.rejects(provisionSandbox3Storage(f.options), /lost response/);
  assert.equal(f.evidence.keyOutcome, 'unknown');
  assert.equal(f.calls.filter(call => call.method === 'POST' && call.url.endsWith('/keys')).length, 1);
  const retry = fixture([...permits(), response(identity), response({ keys: [{ name: key().name }] })]);
  await assert.rejects(provisionSandbox3Storage(retry.options), /requires_reconciliation/);
  assert.equal(retry.calls.some(call => call.method === 'DELETE'), false);
  assert.equal(retry.saved.length, 0);
});
test('lost secret write preserves the created key for explicit reconciliation', async () => {
  const input = addStorageGrant(policy()).policy;
  const f = fixture([...permits(), response(identity), response({ keys: [] }), response(input), response(input), response(key())]);
  f.options.saveSecret = async () => { throw new Error('client observation lost'); };
  await assert.rejects(provisionSandbox3Storage(f.options), /secret_write_unconfirmed/);
  assert.equal(f.evidence.keyOutcome, 'created');
  assert.equal(f.evidence.credentialSaved, false);
  assert.equal(f.calls.some(call => call.method === 'DELETE'), false);
});
test('wrong service-account private material cannot be delivered to the sandbox', () => {
  const wrong = key();
  wrong.privateKeyData = Buffer.from(JSON.stringify({ ...credentials, client_email: 'other@example.test' })).toString('base64');
  assert.throws(() => validateCreatedKey(wrong), /created_key_invalid/);
});
