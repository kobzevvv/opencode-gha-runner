import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import type { LaunchResult } from '../src/contracts.js';
import { installHostCancellation, singleReport } from '../src/runner/cancellation.js';
import { runAgent } from '../src/runner/exec.js';
import { validLaunchRequest } from './contracts.test.js';

const runId = 'run_0fdd061d-14c3-42ea-b182-9393ff3564fa';

for (const scenario of [
  { signal: 'SIGINT', mode: 'cooperate', dropAck: false, code: 23, observedSignal: null },
  { signal: 'SIGTERM', mode: 'ignore', dropAck: false, code: null, observedSignal: 'SIGKILL' },
  { signal: 'SIGINT', mode: 'descendants', dropAck: false, code: null, observedSignal: 'SIGKILL' },
  { signal: 'SIGINT', mode: 'cooperate', dropAck: true, code: 23, observedSignal: null },
] as const) {
  test(`real CLI ${scenario.signal}/${scenario.mode} awaits actual close and reports once${scenario.dropAck ? ' despite lost report ACK' : ''}`, { timeout: 15000 }, async context => {
    const root = await mkdtemp(path.join(tmpdir(), 'native-cli-cancel-'));
    const bin = path.join(root, 'bin');
    const eventsPath = path.join(root, 'agent-events.json');
    await mkdir(bin);
    const git = path.join(bin, 'git');
    const sudo = path.join(bin, 'sudo');
    const agent = path.join(bin, 'agent');
    await writeFile(git, '#!/bin/sh\nexit 0\n');
    await writeFile(sudo, '#!/bin/sh\n[ "$1" = "rm" ] || exit 98\nshift\nexec /bin/rm "$@"\n');
    await writeFile(agent, `#!${process.execPath}
const fs = require('node:fs');
const eventsPath = process.env.FIXTURE_EVENTS_PATH;
const events = { pid: process.pid, readyAt: Date.now(),
  hostSecretAbsent: process.env.HOST_ONLY_FIXTURE_SECRET === undefined,
  artifactsTokenAbsent: process.env.ARTIFACTS_TOKEN === undefined,
  claimTokenAbsent: process.env.CLAIM_TOKEN === undefined };
process.on('SIGTERM', () => {
  if (process.env.FIXTURE_MODE !== 'cooperate') return;
  setTimeout(() => { events.closingAt = Date.now(); fs.writeFileSync(eventsPath, JSON.stringify(events)); process.exit(23); }, 50);
});
if (process.env.FIXTURE_MODE === 'descendants') {
  const child = require('node:child_process').spawn(process.execPath,
    ['-e', "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 100);"],
    { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  child.on('message', () => fs.writeFileSync(eventsPath, JSON.stringify(events)));
} else fs.writeFileSync(eventsPath, JSON.stringify(events));
setInterval(() => {}, 100);
`);
    await Promise.all([git, sudo, agent].map(file => chmod(file, 0o700)));
    const reports: LaunchResult[] = [];
    let claims = 0;
    let reportAfterClose = false;
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      if (request.url === '/v1/claim') {
        claims++;
        assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), { runId });
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ runId, llmKey: '', llmKeyEnvName: 'LLM_API_KEY',
          reportToken: 'synthetic-report-token', agentBinary: agent,
          spec: validLaunchRequest({ isolation: { mode: 'none' }, cwd: path.join(root, 'workspace'),
            envAllowlist: ['HOME', 'FIXTURE_EVENTS_PATH', 'FIXTURE_MODE'],
            env: { HOME: root, FIXTURE_EVENTS_PATH: eventsPath, FIXTURE_MODE: scenario.mode }, outputs: [],
            limits: { timeoutMs: 20000, maxOutputBytes: 4096, maxLogBytes: 4096 } }),
        }));
        return;
      }
      assert.equal(request.url, `/v1/runs/${runId}/report`);
      assert.equal(request.headers.authorization, 'Bearer synthetic-report-token');
      reports.push(JSON.parse(Buffer.concat(chunks).toString()) as LaunchResult);
      const events = JSON.parse(await readFile(eventsPath, 'utf8')) as { pid: number };
      try { process.kill(events.pid, 0); } catch (cause) {
        reportAfterClose = (cause as NodeJS.ErrnoException).code === 'ESRCH';
      }
      if (scenario.dropAck) request.socket.destroy();
      else response.end('{}');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const child = spawn(process.execPath, ['dist/src/runner/main.js'], {
      env: { PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: root,
        GATEWAY_URL: `http://127.0.0.1:${address.port}`, RUN_ID: runId,
        CLAIM_TOKEN: 'synthetic-claim-token', ARTIFACTS_TOKEN: 'synthetic-host-artifacts-token',
        HOST_ONLY_FIXTURE_SECRET: 'synthetic-host-secret', WORKSPACE_ROOT: root,
        ALLOW_SUDO: 'false', AGENT_CONFIG: 'skip', LOG_UPLOAD: 'local' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += String(chunk); });
    child.stderr.on('data', chunk => { output += String(chunk); });
    const closed = once(child, 'close');
    context.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    });
    let events: { pid: number; hostSecretAbsent: boolean; artifactsTokenAbsent: boolean; claimTokenAbsent: boolean } | undefined;
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline && !events) {
      try { events = JSON.parse(await readFile(eventsPath, 'utf8')); } catch { await sleep(20); }
    }
    assert.ok(events, `offline agent failed to become ready: ${output}`);
    assert.equal(reports.length, 0);
    assert.ok(events.hostSecretAbsent && events.artifactsTokenAbsent && events.claimTokenAbsent);
    assert.ok(child.pid);
    process.kill(child.pid, scenario.signal);
    await sleep(10);
    process.kill(child.pid, 'SIGTERM');
    const [code, signal] = await closed;
    assert.equal(signal, null);
    assert.equal(code, scenario.dropAck ? 7 : 6);
    assert.equal(claims, 1);
    assert.equal(reports.length, 1);
    assert.equal(reportAfterClose, true);
    assert.equal(reports[0]!.runId, runId);
    assert.equal(reports[0]!.status, 'started');
    assert.equal(reports[0]!.exitReason, 'cancelled');
    assert.equal(reports[0]!.exitCode, scenario.code);
    assert.equal(reports[0]!.exitSignal, scenario.observedSignal);
    assert.deepEqual(reports[0]!.artifacts, []);
    assert.equal(reports[0]!.logUrl, '');
    for (const secret of ['synthetic-host-secret', 'synthetic-host-artifacts-token', 'synthetic-claim-token', 'synthetic-report-token']) {
      assert.ok(!output.includes(secret));
    }
  });
}

test('single report coalesces simultaneous invocations and never retries ambiguous ACK loss', async () => {
  let calls = 0;
  const report = singleReport(async () => { calls++; throw new Error('offline ACK lost'); });
  const result = {} as LaunchResult;
  const first = report(result);
  assert.equal(report(result), first);
  await assert.rejects(first, /ACK lost/);
  await assert.rejects(report(result), /ACK lost/);
  assert.equal(calls, 1);
});

test('host signal listeners are removed after lifecycle cleanup', () => {
  const initialInt = process.listenerCount('SIGINT');
  const initialTerm = process.listenerCount('SIGTERM');
  const cancellation = installHostCancellation();
  assert.equal(cancellation.signal.aborted, false);
  assert.equal(process.listenerCount('SIGINT'), initialInt + 1);
  assert.equal(process.listenerCount('SIGTERM'), initialTerm + 1);
  cancellation.dispose();
  assert.equal(process.listenerCount('SIGINT'), initialInt);
  assert.equal(process.listenerCount('SIGTERM'), initialTerm);
});

test('cancellation before spawn never fabricates cancelled or observed exit', async () => {
  const controller = new AbortController();
  controller.abort('SIGINT');
  let spawned = false;
  const outcome = await runAgent({
    identity: { name: 'offline-fixture', uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0,
      home: tmpdir(), workspace: process.cwd(), enforced: false },
    binary: process.execPath, argv: ['-e', 'throw new Error("must not spawn")'], env: {},
    timeoutMs: 1000, maxOutputBytes: 4096, secrets: [], signal: controller.signal,
    onSpawn: () => { spawned = true; },
  });
  assert.equal(spawned, false);
  assert.equal(outcome.exitReason, 'startup_failure');
  assert.equal(outcome.exitCode, null);
  assert.equal(outcome.exitSignal, null);
  assert.equal(outcome.timedOut, false);
});
