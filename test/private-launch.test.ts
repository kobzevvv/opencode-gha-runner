import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runAgent } from '../src/runner/exec.js';
import { buildLaunchCommand, runUnderIdentity, type Identity } from '../src/runner/identity.js';

const identity: Identity = { name: 'ocrun-offline', uid: 1234, gid: 1234,
  home: '/tmp/offline-home', workspace: process.cwd(), enforced: false };
const secret = 'offline-private-launch-credential';
const helper = fileURLToPath(new URL('../src/runner/private-launch.js', import.meta.url));

test('sudo and helper argv never contain environment or serialized payload', () => {
  const launch = buildLaunchCommand({ identity: { ...identity, enforced: true }, binary: '/usr/bin/git',
    argv: ['clone', 'offline-repository'], env: { LLM_LADDER_TOKEN: secret, GIT_CONFIG_VALUE_0: secret } });
  assert.equal(launch.command, 'sudo');
  assert.deepEqual(launch.argv, ['-u', identity.name, '--', 'env', '-i', process.execPath, helper]);
  assert.equal(launch.argv.join(' ').includes(secret), false);
  assert.equal(launch.argv.join(' ').includes('GIT_CONFIG_VALUE_0'), false);
  assert.equal(JSON.parse(launch.stdin).env.LLM_LADDER_TOKEN, secret);
  assert.equal(JSON.parse(launch.stdin).env.GIT_CONFIG_VALUE_0, secret);
});

test('agent receives private env through stdin without inherited host keys or argv credentials', async () => {
  let observed = false;
  const outcome = await runAgent({ identity, binary: process.execPath,
    argv: ['-e', 'process.stdout.write(process.env.LLM_LADDER_TOKEN && !process.env.GITHUB_TOKEN ? "ok" : "bad")'],
    env: { LLM_LADDER_TOKEN: secret }, secrets: [secret], timeoutMs: 20000, maxOutputBytes: 1024,
    onSpawn: child => {
      observed = true;
      assert.equal(child.spawnargs.join(' ').includes(secret), false);
      assert.equal(child.spawnargs.join(' ').includes('LLM_LADDER_TOKEN'), false);
    } });
  assert.equal(observed, true);
  assert.equal(outcome.exitReason, 'completed');
  assert.equal(outcome.stdout, 'ok');
});

test('workspace command receives Git authentication through private stdin only', async () => {
  const result = await runUnderIdentity(identity, process.execPath,
    ['-e', 'process.stdout.write(process.env.GIT_CONFIG_VALUE_0 && !process.env.GITHUB_TOKEN ? "ok" : "bad")'],
    { GIT_CONFIG_VALUE_0: secret });
  assert.equal(result.stdout, 'ok');
  assert.equal(result.stderr, '');
});

test('private helper refuses invalid payload without echoing credentials', () => {
  const result = spawnSync(process.execPath, [helper], { encoding: 'utf8',
    input: JSON.stringify({ binary: process.execPath, argv: [], env: { INVALID: secret + '\0' } }), env: {} });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'private launcher refused payload\n');
  assert.equal(result.stderr.includes(secret), false);
});

test('private launcher bounds payload before spawn', () => {
  assert.throws(() => buildLaunchCommand({ identity, binary: process.execPath, argv: [],
    env: { LARGE: 'x'.repeat(1048576) } }), /payload exceeds limit/);
});

test('private helper preserves signal termination', async () => {
  const result = await runAgent({ identity, binary: process.execPath,
    argv: ['-e', 'process.kill(process.pid,"SIGTERM")'], env: {}, secrets: [],
    timeoutMs: 20000, maxOutputBytes: 1024 });
  assert.equal(result.exitSignal, 'SIGTERM');
  assert.equal(result.exitReason, 'crash');
});

test('private helper forwards actual SIGINT and preserves child exit signal', async () => {
  const launch = buildLaunchCommand({ identity, binary: process.execPath,
    argv: ['-e', 'process.stdout.write("ready");setInterval(()=>{},1000)'], env: {} });
  const child = spawn(launch.command, launch.argv, { env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end(launch.stdin);
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject);
      child.stdout.once('data', chunk => {
        assert.equal(chunk.toString(), 'ready');
        child.kill('SIGINT');
      });
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    assert.equal(result.code, null);
    assert.equal(result.signal, 'SIGINT');
  } finally { clearTimeout(timer); }
});

test('engine stdin does not inherit the consumed private payload pipe', async () => {
  const result = await runUnderIdentity(identity, process.execPath,
    ['-e', 'process.stdout.write(require("node:fs").readFileSync(0).length===0?"empty":"leaked")'],
    { LLM_LADDER_TOKEN: secret });
  assert.equal(result.stdout, 'empty');
});
