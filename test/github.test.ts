import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GitHubClient } from '../src/gateway/github.js';

test('reads status and conclusion for the exact Actions run', async () => {
  const requests: string[] = [];
  const client = new GitHubClient({
    token: 'token-for-test',
    repo: 'owner/repo',
    workflow: 'run-agent.yml',
    fetchImpl: (async (input: string | URL | Request) => {
      requests.push(String(input));
      return Response.json({ status: 'completed', conclusion: 'failure' });
    }) as typeof fetch,
  });

  assert.deepEqual(await client.getWorkflowRunState(4242), { status: 'completed', conclusion: 'failure' });
  assert.deepEqual(requests, ['https://api.github.com/repos/owner/repo/actions/runs/4242']);
});

test('public workflow status lookup omits Authorization when no token is configured', async () => {
  let authorization: string | null = 'not-called';
  const client = new GitHubClient({
    token: '',
    repo: 'kobzevvv/opencode-gha-runner',
    workflow: 'run-agent.yml',
    fetchImpl: (async (_input: string | URL, init?: RequestInit) => {
      authorization = new Headers(init?.headers).get('authorization');
      return Response.json({ status: 'completed', conclusion: 'failure' });
    }) as typeof fetch,
  });
  assert.deepEqual(await client.getWorkflowRunState(42), { status: 'completed', conclusion: 'failure' });
  assert.equal(authorization, null);
});

test('a missing workflow run stays unknown to the caller', async () => {
  const client = new GitHubClient({
    token: 'token-for-test',
    repo: 'owner/repo',
    workflow: 'run-agent.yml',
    fetchImpl: (async () => new Response(null, { status: 404 })) as typeof fetch,
  });

  assert.equal(await client.getWorkflowRunState(404), null);
});
