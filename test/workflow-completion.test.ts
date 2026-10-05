import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GitHubClient } from '../src/gateway/github.js';

const runId = 37365787100;
const repo = 'owner/native-worker';
const workflow = 'run-agent.yml';
const ref = 'integration-test';
const runDetail = {
  id: runId, repository: { full_name: repo }, path: `.github/workflows/${workflow}@refs/heads/${ref}`,
  event: 'workflow_dispatch', head_branch: ref, run_attempt: 1, status: 'completed', conclusion: 'cancelled',
};
const jobDetail = {
  id: 111950479789, run_id: runId, name: 'run', status: 'completed', conclusion: 'cancelled',
  completed_at: '2026-10-05T20:00:00Z', steps: [],
};

function fixture(options: {
  run?: unknown; jobs?: unknown; runStatus?: number; jobsStatus?: number; cancelStatus?: number;
} = {}) {
  const requests: Array<{ url: string; method: string }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    requests.push({ url, method });
    if (url.endsWith('/cancel')) return new Response('{}', { status: options.cancelStatus ?? 202 });
    if (url.endsWith('/attempts/1/jobs?per_page=100')) return new Response(JSON.stringify(
      options.jobs === undefined ? { total_count: 1, jobs: [jobDetail] } : options.jobs,
    ), { status: options.jobsStatus ?? 200 });
    assert.equal(url, `https://api.github.com/repos/${repo}/actions/runs/${runId}`);
    return new Response(JSON.stringify(options.run === undefined ? runDetail : options.run), {
      status: options.runStatus ?? 200,
    });
  }) as typeof fetch;
  return { requests, client: new GitHubClient({ token: 'offline-test', repo, workflow, ref, fetchImpl }) };
}

test('observes the pinned workflow attempt and single completed job, including the real zero-step response shape', async () => {
  const { client, requests } = fixture();
  const observation = await client.observeWorkflowCompletion(runId);
  assert.ok(observation);
  assert.equal(observation.repo, repo);
  assert.equal(observation.workflow, workflow);
  assert.equal(observation.githubRunId, runId);
  assert.equal(observation.runAttempt, 1);
  assert.equal(observation.jobId, jobDetail.id);
  assert.equal(observation.conclusion, 'cancelled');
  assert.equal(observation.completedAt, jobDetail.completed_at);
  assert.equal(observation.agentStepStarted, false);
  assert.equal(Number.isFinite(Date.parse(observation.observedAt)), true);
  assert.equal(requests.length, 2);
  assert.ok(requests.every(request => request.method === 'GET'));
  assert.equal(Object.hasOwn(observation, 'exitSignal'), false);
  assert.equal(Object.hasOwn(observation, 'exitObserved'), false);
});

test('records a started Run agent step as workflow metadata, not a process-exit proof', async () => {
  const { client } = fixture({ jobs: { total_count: 1, jobs: [{ ...jobDetail,
    steps: [{ name: 'Run agent', status: 'completed', started_at: '2026-10-05T19:59:00Z' }],
  }] } });
  const observation = await client.observeWorkflowCompletion(runId);
  assert.equal(observation?.agentStepStarted, true);
  assert.equal(Object.hasOwn(observation!, 'exitObserved'), false);
});

for (const patch of [
  { id: runId + 1 }, { repository: { full_name: 'other/repo' } },
  { path: '.github/workflows/foreign.yml' }, { event: 'push' }, { head_branch: 'other' },
  { run_attempt: 2 }, { run_attempt: undefined }, { status: 'in_progress' }, { status: 'queued' },
  { conclusion: null }, { conclusion: 'unknown' },
]) {
  test(`refuses foreign, in-progress, or unknown workflow provenance ${JSON.stringify(patch)}`, async () => {
    const { client, requests } = fixture({ run: { ...runDetail, ...patch } });
    assert.equal(await client.observeWorkflowCompletion(runId), null);
    assert.equal(requests.length, 1);
    assert.ok(requests.every(request => request.method === 'GET'));
  });
}

for (const patch of [
  { id: null }, { run_id: runId + 1 }, { run_attempt: 2 }, { name: 'other' },
  { status: 'in_progress' }, { status: 'queued' }, { conclusion: null },
  { completed_at: null }, { completed_at: 'not-a-time' },
]) {
  test(`refuses incomplete or foreign job provenance ${JSON.stringify(patch)}`, async () => {
    const { client } = fixture({ jobs: { total_count: 1, jobs: [{ ...jobDetail, ...patch }] } });
    assert.equal(await client.observeWorkflowCompletion(runId), null);
  });
}

for (const jobs of [null, {}, { total_count: 0, jobs: [] },
  { total_count: 2, jobs: [jobDetail] }, { total_count: 2, jobs: [jobDetail, jobDetail] },
]) {
  test(`refuses absent, partial, or ambiguous job lists ${JSON.stringify(jobs)}`, async () => {
    assert.equal(await fixture({ jobs }).client.observeWorkflowCompletion(runId), null);
  });
}

for (const status of [403, 404, 429, 500]) {
  test(`GitHub HTTP${status} is not completion evidence`, async () => {
    assert.equal(await fixture({ runStatus: status }).client.observeWorkflowCompletion(runId), null);
    assert.equal(await fixture({ jobsStatus: status }).client.observeWorkflowCompletion(runId), null);
  });
}

for (const cancelStatus of [200, 202]) {
  test(`GitHub cancel HTTP${cancelStatus} is only an acknowledgement`, async () => {
    const { client } = fixture({ run: { ...runDetail, status: 'in_progress', conclusion: null }, cancelStatus });
    assert.deepEqual(await client.cancelWorkflowRun(runId), { acknowledged: true, reason: 'cancel_requested' });
    assert.equal(await client.observeWorkflowCompletion(runId), null);
  });
}
