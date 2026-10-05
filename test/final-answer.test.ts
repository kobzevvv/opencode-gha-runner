import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { failure, type LaunchRequest } from '../src/contracts.js';
import { agentOutputFormat, extractAnswer, extractAssistantText } from '../src/runner/answer.js';
import { collectArtifacts, GitHubRepoApi, NULL_SHA } from '../src/runner/artifacts.js';
import { buildAgentPrompt, declaredOutputFailure } from '../src/runner/finalization.js';
import { buildLaunchResult, publishArtifacts } from '../src/runner/main.js';

const frame = (type: string, messageID: string, part: Record<string, unknown>) => JSON.stringify({ type, timestamp: 100, sessionID: 'session-main', part: { sessionID: 'session-main', messageID, ...part } });
const text = (messageID: string, value: string, id = 'part-text') => frame('text', messageID, { type: 'text', id, text: value, time: { start: 1, end: 2 } });
const finish = (messageID: string, reason = 'stop') => frame('step_finish', messageID, { type: 'step-finish', id: 'part-finish', reason });
const jsonOutput = [
  frame('step_start', 'message-tools', { type: 'step-start', id: 'part-start' }),
  text('message-tools', 'I will inspect the CSV.'),
  frame('tool_use', 'message-tools', { type: 'tool', id: 'part-tool', tool: 'read', state: { status: 'completed', output: 'private diagnostic, not an answer' } }),
  finish('message-tools', 'tool-calls'),
  frame('step_start', 'message-final', { type: 'step-start', id: 'part-start-final' }),
  text('message-final', 'CSV processed: 3 rows.'),
  finish('message-final'),
].join('\n');

test('OpenCode JSON selects the completed final assistant turn, excluding tool frames and earlier planning', () => {
  assert.equal(extractAssistantText(jsonOutput), 'CSV processed: 3 rows.');
  assert.equal(extractAssistantText(jsonOutput + '\n' + text('message-final', 'CSV processed: 3 rows.')), 'CSV processed: 3 rows.');
});

test('final text parts are joined once and updated parts replace prior contents', () => {
  assert.equal(extractAssistantText([text('final', 'draft'), text('final', 'First part'), text('final', 'Second part', 'part-second'), finish('final')].join('\n')), 'First part\nSecond part');
});

test('tools, reasoning, user text, incomplete turns and malformed tails never become answers', () => {
  for (const output of [
    frame('tool_use', 'tool', { type: 'tool', text: 'not an answer' }),
    frame('reasoning', 'reasoning', { type: 'reasoning', text: 'not an answer' }),
    text('final', 'not finished'),
    [text('final', 'tool preamble'), finish('final', 'tool-calls')].join('\n'),
    [text('final', 'truncated'), finish('final', 'length')].join('\n'),
    frame('text', 'user', { type: 'text', role: 'user', id: 'user-part', text: 'echoed prompt', time: { end: 2 } }) + '\n' + finish('user'),
    jsonOutput + '\n{"type":"text","part":',
    jsonOutput + '\n' + text('next-unfinished-turn', 'not a final answer'),
  ]) assert.equal(extractAssistantText(output), undefined);
});

test('other-session frames cannot replace the root-session answer', () => {
  const child = [text('child', 'Subagent tool summary'), finish('child')].join('\n').replaceAll('session-main', 'session-child');
  assert.equal(extractAssistantText(jsonOutput + '\n' + child), 'CSV processed: 3 rows.');
});

test('answer files take precedence; empty files and outside symlinks do not expose unrelated files', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'worker-answer-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  await mkdir(path.join(workspace, '.agent'), { recursive: true });
  await writeFile(path.join(workspace, '.agent/answer.txt'), '  File answer\n');
  assert.deepEqual(extractAnswer(workspace, jsonOutput, 'json'), { text: 'File answer', source: 'agent_file' });
  await writeFile(path.join(workspace, '.agent/answer.txt'), ' \n');
  await writeFile(path.join(root, 'outside.txt'), 'not an answer');
  await symlink(path.join(root, 'outside.txt'), path.join(workspace, 'answer.txt'));
  assert.deepEqual(extractAnswer(workspace, jsonOutput, 'json'), { text: 'CSV processed: 3 rows.', source: 'engine_stdout' });
});

test('plain legacy output is allowed only in plain mode; JSON frames never fall back to raw text', () => {
  assert.deepEqual(extractAnswer('/no-workspace', ' Legacy answer\n', 'plain'), { text: 'Legacy answer', source: 'engine_stdout' });
  assert.deepEqual(extractAnswer('/no-workspace', 'plain diagnostic', 'json'), { source: null });
  assert.deepEqual(extractAnswer('/no-workspace', frame('tool_use', 'tools', { type: 'tool', text: 'diagnostic' }), 'plain'), { source: null });
  assert.equal(agentOutputFormat(['--format', 'json']), 'json');
  assert.equal(agentOutputFormat(['--format=json']), 'json');
  assert.equal(agentOutputFormat(['--format', 'default']), 'plain');
});

const output = { path: 'result.csv', name: 'result.csv', mime: 'text/csv' };
const artifact = { path: 'artifacts/result.csv', name: 'result.csv', mime: 'text/csv', size: 12, sha256: 'b'.repeat(64) };
const successful = { runId: 'run-final', outcome: { exitCode: 0, exitSignal: null, exitReason: 'completed' as const, stdout: '', stderr: '', durationMs: 1, timedOut: false, outputTruncated: false }, answer: { text: 'done', source: 'agent_file' as const }, artifacts: [artifact], repo: { fullName: 'owner/repo', branch: 'agent-run/run-final', commit: 'a'.repeat(40) }, logUrl: '', outputTruncated: false, outputs: [output] };

test('declared missing outputs fail finalization even after an exit-0 agent', () => {
  const result = buildLaunchResult({ ...successful, missingOutputs: ['result.csv'], artifacts: [] });
  assert.equal(result.exitCode, 0);
  assert.equal(result.exitReason, 'nonzero_exit');
  assert.equal(result.failure?.code, 'ARTIFACTS_MISSING');
  assert.equal(result.failure?.failureClass, 'finalization');
  assert.equal(result.failure?.retryable, false);
});

test('the observed branch-creation failure is publication failure, not missing output or success', () => {
  const result = buildLaunchResult({ ...successful, artifacts: [], repo: { ...successful.repo, commit: NULL_SHA }, publicationFailed: true });
  assert.equal(result.exitCode, 0);
  assert.equal(result.exitReason, 'nonzero_exit');
  assert.equal(result.failure?.code, 'ARTIFACT_PUBLICATION_FAILED');
  assert.equal(result.failure?.retryable, false);
});

test('a valid commit and every declared artifact are required; engine failures retain precedence', () => {
  assert.equal(buildLaunchResult(successful).exitReason, 'completed');
  assert.equal(buildLaunchResult(successful).failure, undefined);
  assert.equal(buildLaunchResult({ ...successful, artifacts: [] }).failure?.code, 'ARTIFACTS_MISSING');
  const engineFailure = failure('AGENT_TIMEOUT', 'runtime', 'agent exceeded timeout');
  const result = buildLaunchResult({ ...successful, outcome: { ...successful.outcome, exitReason: 'timeout', timedOut: true }, failure: engineFailure, publicationFailed: true });
  assert.equal(result.exitReason, 'timeout');
  assert.deepEqual(result.failure, engineFailure);
  assert.equal(declaredOutputFailure([], { missing: [], artifacts: [], commit: NULL_SHA, failed: true }), undefined);
});

test('host output requirements augment, never replace or flatten, the original multiline goal', () => {
  const goal = 'Original goal\n  keep this indentation\n';
  const prompt = buildAgentPrompt(goal, [output]);
  assert.ok(prompt.startsWith(goal));
  assert.ok(prompt.includes('result.csv'));
  assert.ok(prompt.includes('.agent/answer.txt'));
  assert.equal(buildAgentPrompt(goal, []), goal);
});

test('GitHub branch failure exposes operation and HTTP status, never response body or auth', async () => {
  const api = new GitHubRepoApi({ token: 'test-token-do-not-print', repo: 'owner/repo', fetchImpl: (async (_url: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') return Response.json({ message: 'sensitive response body' }, { status: 403 });
    const url = String(_url);
    if (url.endsWith('/repos/owner/repo')) return Response.json({ default_branch: 'main' });
    if (url.endsWith('/heads/main')) return Response.json({ object: { sha: 'a'.repeat(40) } });
    return Response.json({}, { status: 404 });
  }) as typeof fetch });
  await assert.rejects(api.pushFiles({ branch: 'agent-run/run-final', commitMessage: 'result', files: [{ path: 'artifacts/result.csv', content: Buffer.from('result') }] }), { message: 'GitHub branch creation HTTP 403' });
});

for (const replacement of ['symlink', 'rewrite', 'delete'] as const) {
  test(`publication preserves collected bytes and manifest hash after output ${replacement}`, async (context) => {
    const root = await mkdtemp(path.join(tmpdir(), 'worker-publication-'));
    context.after(() => rm(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'workspace');
    await mkdir(workspace);
    const outputPath = path.join(workspace, output.path);
    const original = Buffer.from('category,total\nfood,150\ntravel,275\n');
    await writeFile(outputPath, original);
    const collected = await collectArtifacts(workspace, [output]);
    await rm(outputPath);
    if (replacement === 'symlink') {
      const outside = path.join(root, 'outside.txt');
      await writeFile(outside, 'outside-host-secret-must-not-publish');
      await symlink(outside, outputPath);
    } else if (replacement === 'rewrite') {
      await writeFile(outputPath, 'different bytes after collection');
    }
    let uploaded: Array<{ path: string; content: Buffer }> = [];
    context.mock.method(GitHubRepoApi.prototype, 'pushFiles', async (options: { branch: string; files: typeof uploaded }) => {
      uploaded = options.files;
      return { fullName: 'owner/repo', branch: options.branch, commit: 'a'.repeat(40), pushed: options.files.map((file) => file.path) };
    });
    const spec: LaunchRequest = {
      runId: 'run-snapshot', jobId: 'job-1', userTaskId: 'task-1', profileId: 'profile-1', conversationId: 'conv-1', operationId: 'op-1', ownerGeneration: 1,
      engine: { name: 'dynamic-ip-azure-agent-run', adapterVersion: '1' }, input: { inlinePrompt: 'Produce CSV' }, cwd: workspace,
      envAllowlist: [], env: {}, limits: { timeoutMs: 300000, maxOutputBytes: 1024, maxLogBytes: 1024 },
      repository: { fullName: 'owner/repo', branch: 'agent-run/run-snapshot' }, resultUrl: 'https://example.test/result',
      isolation: { mode: 'per_run_unix_identity' }, outputs: [output],
    };
    const published = await publishArtifacts({ spec, runId: spec.runId, workspace, token: 'fixture-token', collected, outcome: successful.outcome, startedAt: new Date(), sessionLog: { append() {} } });
    assert.equal(published.note, null);
    const content = uploaded.find((file) => file.path === 'artifacts/result.csv')!.content;
    assert.deepEqual(content, original);
    assert.equal(createHash('sha256').update(content).digest('hex'), published.artifactRefs[0]!.sha256);
    assert.equal(content.length, published.artifactRefs[0]!.size);
    const manifest = JSON.parse(uploaded.find((file) => file.path === 'artifacts/run-manifest.json')!.content.toString());
    assert.deepEqual(manifest.artifacts, published.artifactRefs);
    assert.deepEqual(manifest.missingOutputs, []);
  });
}
