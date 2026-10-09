const sha = process.argv[2];
if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw Error('invalid_source_sha');
const base = 'https://trained-assist-native-worker-sandbox3.skillset-apply.workers.dev';
let verified = false;
for (let attempt = 0; attempt < 8; attempt++) {
  try {
    const response = await fetch(base + '/healthz', { signal: AbortSignal.timeout(10000) });
    const health = await response.json();
    verified = response.status === 200 && health.ok === true && health.configured === true
      && health.buildSha === sha && health.sandboxPolicy === 'free-only-v1'
      && health.repo === 'kobzevvv/opencode-gha-runner' && health.workflow === 'run-agent-sandbox3.yml';
  } catch { /* bounded read-only propagation checks */ }
  if (verified) break;
  await new Promise(resolve => setTimeout(resolve, 2000));
}
if (!verified) throw Error('sandbox3_source_or_policy_not_verified');
const anonymous = await fetch(base + '/v1/launch', { method: 'POST', body: '{}', signal: AbortSignal.timeout(10000) });
if (anonymous.status !== 401) throw Error('sandbox3_anonymous_launch_not_rejected');
console.log(JSON.stringify({ ok: true, buildSha: sha, sandboxPolicy: 'free-only-v1', anonymousLaunchStatus: 401, agentStarted: false, modelCalled: false }));
