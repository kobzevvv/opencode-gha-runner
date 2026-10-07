import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { LaunchRequest } from '../src/contracts.js';
import type { Identity } from '../src/runner/identity.js';
import { materializeProfileSnapshot, stageSnapshotArchive, uploadProfileChanges } from '../src/runner/profile-snapshot.js';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

test('staged profile archive is owned by the run identity and unreadable by other local users', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-snapshot-mode-'));
  try {
    const workspace = path.join(root, 'workspace');
    await mkdir(workspace, { mode: 0o750 });
    const source = path.join(root, 'source.tar.gz');
    await writeFile(source, 'private profile bytes', { mode: 0o600 });
    const identity: Identity = { name: 'test', uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0, home: root, workspace, enforced: false };
    const archive = await stageSnapshotArchive(source, workspace, identity);
    const archiveStat = await stat(archive);
    assert.equal(archiveStat.uid, identity.uid);
    assert.equal(archiveStat.mode & 0o777, 0o600, 'archive must be readable only by the run identity');
    assert.equal((archiveStat.mode & 0o044), 0, 'group/other users must not read profile snapshot bytes');
    assert.equal((await stat(workspace)).mode & 0o007, 0, 'workspace parent must not be accessible to other users');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('profile snapshot is checksum-verified, extracted as a git baseline, and uploaded via run capability', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-snapshot-'));
  try {
    const source = path.join(root, 'source');
    const workspace = path.join(root, 'workspace');
    await mkdir(path.join(source, 'notes'), { recursive: true });
    const before = Buffer.from('before');
    await writeFile(path.join(source, 'notes/state.txt'), before);
    const archive = path.join(root, 'snapshot.tar.gz');
    execFileSync('tar', ['-czf', archive, '-C', source, 'notes/state.txt']);
    const snapshot = await readFile(archive);
    const identity: Identity = { name: 'test', uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0, home: root, workspace, enforced: false };
    const spec = {
      runId: 'run-test', profileId: 'profile-test',
      profileWorkspace: {
        bindingId: 'binding-test', snapshotUrl: 'https://api.invalid/snapshot', snapshotSha256: hash(snapshot), snapshotSize: snapshot.length,
        savebackUrl: 'https://api.invalid/v1/worker/launches/run-test/profile-changes', savebackToken: 'x'.repeat(48),
        artifacts: [], excludedPatterns: [],
      },
    } as unknown as LaunchRequest;
    await materializeProfileSnapshot(spec, workspace, identity, async () => new Response(snapshot));
    assert.equal(await readFile(path.join(workspace, 'notes/state.txt'), 'utf8'), 'before');
    assert.equal((await readdir(workspace)).some((name) => name.startsWith('.profile-snapshot-')), false, 'private snapshot archive is removed before agent launch');
    execFileSync('git', ['-C', workspace, 'status', '--porcelain']);

    const after = Buffer.from('after');
    await writeFile(path.join(workspace, 'notes/state.txt'), after);
    const next = Buffer.from('next');
    await writeFile(path.join(workspace, 'notes/next.txt'), next);
    const requests: Array<{ url: string; authorization: string | null; body: Buffer }> = [];
    const manifest = await uploadProfileChanges({
      spec, workspace, identity,
      files: [
        { path: 'artifacts/notes/state.txt', sha256: hash(after), size: after.length },
        { path: 'artifacts/notes/next.txt', sha256: hash(next), size: next.length },
      ],
      deletes: ['notes/old.txt'],
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), authorization: new Headers(init?.headers).get('authorization'), body: Buffer.from(init?.body as Uint8Array) });
        return new Response(null, { status: 204 });
      },
    });
    assert.equal(requests.length, 2);
    assert.equal(requests[0]!.authorization, `Bearer ${'x'.repeat(48)}`);
    assert.equal(new URL(requests[0]!.url).searchParams.get('path'), 'notes/state.txt');
    assert.deepEqual(requests[0]!.body, after);
    assert.equal(new URL(requests[1]!.url).searchParams.get('path'), 'notes/next.txt', 'file uploads are serialized in manifest order');
    assert.deepEqual(manifest, {
      files: [
        { path: 'notes/state.txt', sha256: hash(after), size: after.length },
        { path: 'notes/next.txt', sha256: hash(next), size: next.length },
      ],
      deletes: ['notes/old.txt'],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('failed profile upload rejects without returning a complete changes manifest', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-saveback-fail-'));
  try {
    const workspace = path.join(root, 'workspace');
    await mkdir(path.join(workspace, 'notes'), { recursive: true });
    const first = Buffer.from('first');
    const second = Buffer.from('second');
    await writeFile(path.join(workspace, 'notes/first.txt'), first);
    await writeFile(path.join(workspace, 'notes/second.txt'), second);
    const identity: Identity = { name: 'test', uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0, home: root, workspace, enforced: false };
    const spec = { profileWorkspace: { bindingId: 'binding', snapshotUrl: 'https://api.invalid/snapshot', snapshotSha256: 'a'.repeat(64), snapshotSize: 1, savebackUrl: 'https://api.invalid/save', savebackToken: 'x'.repeat(48), artifacts: [], excludedPatterns: [] } } as unknown as LaunchRequest;
    const calls: string[] = [];
    await assert.rejects(() => uploadProfileChanges({
      spec, workspace, identity,
      files: [
        { path: 'artifacts/notes/first.txt', sha256: hash(first), size: first.length },
        { path: 'artifacts/notes/second.txt', sha256: hash(second), size: second.length },
      ],
      deletes: ['notes/deleted.txt'],
      fetchImpl: async (url) => {
        calls.push(new URL(String(url)).searchParams.get('path') ?? '');
        return calls.length === 1 ? new Response(null, { status: 204 }) : new Response('rejected', { status: 503 });
      },
    }), /upload failed/);
    assert.deepEqual(calls, ['notes/first.txt', 'notes/second.txt']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('profile saveback enforces per-file and per-run limits before making upload requests', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-saveback-limits-'));
  try {
    const workspace = path.join(root, 'workspace');
    await mkdir(workspace);
    const identity: Identity = { name: 'test', uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0, home: root, workspace, enforced: false };
    const spec = { profileWorkspace: { bindingId: 'binding', snapshotUrl: 'https://api.invalid/snapshot', snapshotSha256: 'a'.repeat(64), snapshotSize: 1, savebackUrl: 'https://api.invalid/save', savebackToken: 'x'.repeat(48), artifacts: [], excludedPatterns: [] } } as unknown as LaunchRequest;
    let calls = 0;
    const fetchImpl = async () => { calls += 1; return new Response(null, { status: 204 }); };
    await assert.rejects(() => uploadProfileChanges({
      spec, workspace, identity,
      files: [{ path: 'artifacts/large.bin', sha256: 'a'.repeat(64), size: 50 * 1024 * 1024 + 1 }],
      deletes: [], fetchImpl,
    }), /upload limits/);
    await assert.rejects(() => uploadProfileChanges({
      spec, workspace, identity,
      files: [34, 34, 34].map((size, index) => ({ path: `artifacts/file-${index}.bin`, sha256: 'a'.repeat(64), size: size * 1024 * 1024 })),
      deletes: [], fetchImpl,
    }), /upload limits/);
    assert.equal(calls, 0, 'oversized run must be rejected before sending any partial files');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('profile snapshot checksum mismatch is rejected before extraction', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-snapshot-bad-'));
  try {
    const workspace = path.join(root, 'workspace');
    const identity: Identity = { name: 'test', uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0, home: root, workspace, enforced: false };
    const spec = { profileWorkspace: { bindingId: 'binding', snapshotUrl: 'https://api.invalid/snapshot', snapshotSha256: '0'.repeat(64), snapshotSize: 3, savebackUrl: 'https://api.invalid/save', savebackToken: 'x'.repeat(48), artifacts: [], excludedPatterns: [] } } as unknown as LaunchRequest;
    await assert.rejects(() => materializeProfileSnapshot(spec, workspace, identity, async () => new Response('bad')), /checksum mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
