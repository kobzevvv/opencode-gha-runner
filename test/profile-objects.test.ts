import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { materializeProfileObjects, uploadProfileObject } from '../src/runner/profile-objects.js';
import type { LaunchRequest } from '../src/contracts.js';

test('private profile object survives into a new workspace with checksum verification', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-gcs-fixture-'));
  const oldPath = process.env['PATH'];
  const oldRoot = process.env['FAKE_GCS_ROOT'];
  try {
    const bin = path.join(root, 'bin');
    const bucket = path.join(root, 'bucket');
    const workspace = path.join(root, 'workspace');
    await mkdir(bin);
    await mkdir(bucket);
    await mkdir(workspace);
    const gcloud = path.join(bin, 'gcloud');
    await writeFile(gcloud, '#!/bin/sh\nset -eu\n[ "$1" = storage ] && [ "$2" = cp ]\nfrom="$3"\nto="$4"\ncase "$from" in gs://profile-bucket/*) from="$FAKE_GCS_ROOT/${from#gs://profile-bucket/}";; esac\ncase "$to" in gs://profile-bucket/*) to="$FAKE_GCS_ROOT/${to#gs://profile-bucket/}";; esac\nmkdir -p "$(dirname "$to")"\ncp "$from" "$to"\n');
    await chmod(gcloud, 0o755);
    process.env['PATH'] = `${bin}:${oldPath ?? ''}`;
    process.env['FAKE_GCS_ROOT'] = bucket;
    const bytes = Buffer.from('a heavy profile artifact');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const source = path.join(root, 'source.bin');
    await writeFile(source, bytes);
    const spec = { runId: 'run-profile-1', profileId: 'profile-a', profileWorkspace: { bindingId: 'binding-a', objectBucket: 'profile-bucket', artifacts: [], excludedPatterns: [] } } as unknown as LaunchRequest;
    const key = await uploadProfileObject(spec, 'profile-bucket', source, sha256);
    spec.profileWorkspace!.artifacts.push({ path: 'documents/large.bin', key, sha256, size: bytes.length });
    await materializeProfileObjects(spec, workspace, { name: 'fixture', uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0, home: root, workspace, enforced: false }, 'profile-bucket');
    assert.deepEqual(await readFile(path.join(workspace, 'documents/large.bin')), bytes);
    await writeFile(path.join(bucket, key), 'tampered');
    await assert.rejects(() => materializeProfileObjects(spec, workspace, { name: 'fixture', uid: 0, gid: 0, home: root, workspace, enforced: false }, 'profile-bucket'), /checksum mismatch/);
  } finally {
    process.env['PATH'] = oldPath;
    if (oldRoot === undefined) delete process.env['FAKE_GCS_ROOT']; else process.env['FAKE_GCS_ROOT'] = oldRoot;
    await rm(root, { recursive: true, force: true });
  }
});
