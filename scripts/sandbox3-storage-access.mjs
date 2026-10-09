import { createHash } from 'node:crypto';

const { STORAGE_ACCESS_TOKEN: token, STORAGE_SERVICE_ACCOUNT: serviceAccount,
  STORAGE_BUCKET: bucket, STORAGE_WORKLOAD_PROVIDER: provider } = process.env;
if (!token || !/^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/.test(serviceAccount ?? '')
  || !/^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/.test(bucket ?? '')
  || !/^projects\/\d+\/locations\/global\/workloadIdentityPools\/[^/]+\/providers\/[^/]+$/.test(provider ?? '')) {
  throw Error('existing_storage_configuration_invalid');
}
async function query(url, body) {
  const response = await fetch(url, {
    method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(30000),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) return { readable: false, status: response.status, permissions: [] };
  const data = await response.json();
  return { readable: true, status: response.status, permissions: Array.isArray(data.permissions) ? data.permissions : [] };
}
const servicePermissions = ['iam.serviceAccountKeys.create', 'iam.serviceAccounts.signBlob'];
const bucketPermissions = ['storage.objects.create', 'storage.objects.get', 'storage.objects.delete', 'storage.objects.list'];
const service = await query(`https://iam.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(serviceAccount)}:testIamPermissions`, { permissions: servicePermissions });
const url = new URL(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/iam/testPermissions`);
for (const permission of bucketPermissions) url.searchParams.append('permissions', permission);
const storage = await query(url);
console.log(JSON.stringify({
  serviceAccountHash: createHash('sha256').update(serviceAccount).digest('hex'),
  bucketHash: createHash('sha256').update(bucket).digest('hex'),
  serviceQueryStatus: service.status, bucketQueryStatus: storage.status,
  servicePermissions: Object.fromEntries(servicePermissions.map(p => [p, service.permissions.includes(p)])),
  bucketPermissions: Object.fromEntries(bucketPermissions.map(p => [p, storage.permissions.includes(p)])),
  resourceCreated: false, credentialCreated: false, modelCalled: false,
}));
if (!service.readable || !storage.readable) throw Error('existing_storage_access_inspection_incomplete');
