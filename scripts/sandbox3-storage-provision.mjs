import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const TARGET = Object.freeze({
  project: 'trained-assist-gdrive-sa', account: 'ta-runner-sandbox3',
  email: 'ta-runner-sandbox3@trained-assist-gdrive-sa.iam.gserviceaccount.com',
  displayName: 'Trained Assist sandbox3 Runner storage',
  bucket: 'trained-assist-profile-acceptance-eu-731388616698',
  role: 'roles/storage.objectUser', repository: 'trained-assist/trained-assist-control-plane',
  environment: 'sandbox', secret: 'SANDBOX3_GCS_CREDENTIALS',
});
const PROJECT_PERMISSIONS = ['iam.serviceAccounts.create', 'iam.serviceAccounts.get',
  'iam.serviceAccountKeys.list', 'iam.serviceAccountKeys.create'];
const BUCKET_PERMISSIONS = ['storage.buckets.getIamPolicy', 'storage.buckets.setIamPolicy'];
const saUrl = `https://iam.googleapis.com/v1/projects/${TARGET.project}/serviceAccounts/${TARGET.email}`;
const bucketUrl = `https://storage.googleapis.com/storage/v1/b/${TARGET.bucket}`;

export function addStorageGrant(policy) {
  if (!policy || typeof policy.etag !== 'string' || !policy.etag
    || !Array.isArray(policy.bindings) || ![1, 3].includes(policy.version)) {
    throw Error('sandbox3_storage_policy_invalid');
  }
  const copy = structuredClone(policy);
  const member = `serviceAccount:${TARGET.email}`;
  let binding = copy.bindings.find(item => item.role === TARGET.role && !item.condition);
  if (binding && (!Array.isArray(binding.members) || binding.members.some(x => typeof x !== 'string'))) {
    throw Error('sandbox3_storage_policy_invalid');
  }
  if (binding?.members.includes(member)) return { policy: copy, changed: false };
  if (!binding) { binding = { role: TARGET.role, members: [] }; copy.bindings.push(binding); }
  binding.members.push(member);
  return { policy: copy, changed: true };
}

export function validateCreatedKey(value) {
  const prefix = `projects/${TARGET.project}/serviceAccounts/${TARGET.email}/keys/`;
  if (!value || typeof value.name !== 'string' || !value.name.startsWith(prefix)
    || !/^[a-f0-9]{40}$/.test(value.name.slice(prefix.length))
    || typeof value.privateKeyData !== 'string' || value.privateKeyData.length > 90_000) {
    throw Error('sandbox3_storage_created_key_invalid');
  }
  let credentials;
  try { credentials = JSON.parse(Buffer.from(value.privateKeyData, 'base64').toString('utf8')); }
  catch { throw Error('sandbox3_storage_created_key_invalid'); }
  if (credentials.type !== 'service_account' || credentials.project_id !== TARGET.project
    || credentials.client_email !== TARGET.email || credentials.token_uri !== 'https://oauth2.googleapis.com/token'
    || credentials.private_key_id !== value.name.slice(prefix.length)
    || typeof credentials.private_key !== 'string'
    || !credentials.private_key.startsWith('-----BEGIN PRIVATE KEY-----\n')) {
    throw Error('sandbox3_storage_created_key_invalid');
  }
  return JSON.stringify(credentials);
}

export async function provisionSandbox3Storage({ mode, request, secretExists, saveSecret, evidence = {} }) {
  if (!['inspect', 'apply'].includes(mode)) throw Error('sandbox3_storage_mode_invalid');
  Object.assign(evidence, { project: TARGET.project, account: TARGET.email, bucket: TARGET.bucket,
    accountOutcome: 'not_attempted', keyOutcome: 'not_attempted', bucketGrantOutcome: 'not_attempted',
    credentialSaved: false, credentialVerified: false, modelCalled: false });
  const secretPresent = await secretExists();
  evidence.destinationSecretPresent = secretPresent;
  const project = await request('POST', `https://cloudresourcemanager.googleapis.com/v1/projects/${TARGET.project}:testIamPermissions`,
    { permissions: PROJECT_PERMISSIONS });
  const permissionUrl = new URL(`${bucketUrl}/iam/testPermissions`);
  for (const name of BUCKET_PERMISSIONS) permissionUrl.searchParams.append('permissions', name);
  const bucket = await request('GET', permissionUrl.href);
  const permissions = (result, names) => Object.fromEntries(names.map(name =>
    [name, result.status === 200 && Array.isArray(result.body?.permissions) && result.body.permissions.includes(name)]));
  evidence.projectQueryStatus = project.status;
  evidence.bucketQueryStatus = bucket.status;
  evidence.projectPermissions = permissions(project, PROJECT_PERMISSIONS);
  evidence.bucketPermissions = permissions(bucket, BUCKET_PERMISSIONS);
  evidence.provisioningAllowed = [...Object.values(evidence.projectPermissions), ...Object.values(evidence.bucketPermissions)].every(Boolean);
  if (mode === 'inspect') return evidence;
  if (secretPresent) { evidence.provisioningSkipped = 'destination_secret_exists'; return evidence; }
  if (!evidence.provisioningAllowed) throw Error('sandbox3_storage_provisioning_permissions_missing');

  let account = await request('GET', saUrl);
  if (account.status === 404) {
    evidence.accountOutcome = 'unknown';
    account = await request('POST', `https://iam.googleapis.com/v1/projects/${TARGET.project}/serviceAccounts`,
      { accountId: TARGET.account, serviceAccount: { displayName: TARGET.displayName } });
    if (account.status !== 200) throw Error('sandbox3_storage_account_creation_unconfirmed');
    evidence.accountOutcome = 'created';
  } else evidence.accountOutcome = account.status === 200 ? 'existing' : 'unknown';
  if (account.status !== 200 || account.body?.email !== TARGET.email
    || account.body?.projectId !== TARGET.project || account.body?.displayName !== TARGET.displayName
    || account.body?.disabled === true) throw Error('sandbox3_storage_account_owner_mismatch');

  const keys = await request('GET', `${saUrl}/keys?keyTypes=USER_MANAGED`);
  if (keys.status !== 200 || (keys.body.keys !== undefined && !Array.isArray(keys.body.keys))) {
    throw Error('sandbox3_storage_key_inventory_unavailable');
  }
  if ((keys.body.keys ?? []).length) throw Error('sandbox3_storage_existing_key_requires_reconciliation');
  const policy = await request('GET', `${bucketUrl}/iam?optionsRequestedPolicyVersion=3`);
  if (policy.status !== 200) throw Error('sandbox3_storage_policy_unavailable');
  const grant = addStorageGrant(policy.body);
  if (grant.changed) {
    evidence.bucketGrantOutcome = 'unknown';
    const saved = await request('PUT', `${bucketUrl}/iam`, grant.policy);
    if (saved.status !== 200) throw Error('sandbox3_storage_policy_write_unconfirmed');
    evidence.bucketGrantOutcome = 'added';
  } else evidence.bucketGrantOutcome = 'existing';
  const current = await request('GET', `${bucketUrl}/iam?optionsRequestedPolicyVersion=3`);
  if (current.status !== 200 || addStorageGrant(current.body).changed) throw Error('sandbox3_storage_grant_unconfirmed');

  // Key creation has no automatic retry. A lost response leaves an unknown
  // outcome which the next invocation discovers through the key inventory.
  evidence.keyOutcome = 'unknown';
  const key = await request('POST', `${saUrl}/keys`, { privateKeyType: 'TYPE_GOOGLE_CREDENTIALS_FILE' });
  if (key.status !== 200) throw Error('sandbox3_storage_key_creation_unconfirmed');
  const privateJson = validateCreatedKey(key.body);
  evidence.keyOutcome = 'created';
  try { await saveSecret(privateJson); }
  catch {
    // Reconcile the secret destination before deleting or regenerating a key:
    // an unsuccessful client observation can still mean the write succeeded.
    throw Error('sandbox3_storage_secret_write_unconfirmed');
  }
  evidence.credentialSaved = true;
  return evidence;
}

async function main() {
  const token = process.env.STORAGE_ACCESS_TOKEN;
  if (!token || !process.env.GH_TOKEN || process.env.GITHUB_REPOSITORY !== 'kobzevvv/opencode-gha-runner'
    || process.env.GITHUB_REF !== 'refs/heads/main') throw Error('sandbox3_storage_operator_context_invalid');
  const gh = (args, input) => {
    const result = spawnSync('gh', args, { input, encoding: 'utf8', maxBuffer: 65_536, timeout: 30_000 });
    if (result.error || result.status !== 0) throw Error('sandbox3_storage_secret_operation_failed');
    return result.stdout;
  };
  const request = async (method, url, body) => {
    try {
      const response = await fetch(url, { method, redirect: 'error', signal: AbortSignal.timeout(20_000),
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, body: await response.json() };
    } catch { throw Error('sandbox3_storage_request_outcome_unknown'); }
  };
  const evidence = {};
  try {
    await provisionSandbox3Storage({ mode: process.env.STORAGE_PROVISION_MODE, request, evidence,
      secretExists: async () => {
        let values;
        try { values = JSON.parse(gh(['secret', 'list', '--repo', TARGET.repository, '--env', TARGET.environment, '--json', 'name'])); }
        catch { throw Error('sandbox3_storage_secret_inventory_unavailable'); }
        if (!Array.isArray(values)) throw Error('sandbox3_storage_secret_inventory_unavailable');
        return values.some(value => value.name === TARGET.secret);
      },
      saveSecret: async input => {
        gh(['secret', 'set', TARGET.secret, '--repo', TARGET.repository, '--env', TARGET.environment], input);
      },
    });
  } catch (error) {
    evidence.reasonCode = /^sandbox3_storage_[a-z_]+$/.test(error?.message ?? '') ? error.message : 'sandbox3_storage_provision_failed';
    process.exitCode = 1;
  }
  await writeFile('sandbox3-storage-provision-evidence.json', `${JSON.stringify(evidence)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(evidence));
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(() => { console.error('sandbox3_storage_operator_failed'); process.exitCode = 1; });
}
