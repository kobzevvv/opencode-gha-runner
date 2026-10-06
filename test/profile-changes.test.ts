import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { LaunchRequest } from '../src/contracts.js';
import { collectProfileChanges } from '../src/runner/profile-changes.js';

test('profile changes include edits, new files and object deletions but exclude secrets', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-changes-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    await mkdir(path.join(root, 'notes'));
    await writeFile(path.join(root, 'notes/old.txt'), 'before');
    await writeFile(path.join(root, 'removed.txt'), 'remove me');
    execFileSync('git', ['-C', root, 'add', '.']);
    execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base']);
    await writeFile(path.join(root, 'notes/old.txt'), 'after');
    await writeFile(path.join(root, 'notes/new.txt'), 'new');
    await writeFile(path.join(root, '.gitignore'), 'notes/new.txt\n');
    await writeFile(path.join(root, '.env'), 'SECRET=value');
    await unlink(path.join(root, 'removed.txt'));
    const retained = Buffer.from('already stored');
    await writeFile(path.join(root, 'heavy.bin'), retained);
    const sha256 = createHash('sha256').update(retained).digest('hex');
    const spec = {
      profileWorkspace: {
        bindingId: 'binding-a', excludedPatterns: ['(^|/)\\.env$', '(^|/)\\.gitignore$'],
        artifacts: [
          { path: 'heavy.bin', key: 'profiles/profile-a/workspace/old/hash', sha256, size: retained.length },
          { path: 'gone.bin', key: 'profiles/profile-a/workspace/old/gone', sha256, size: retained.length },
        ],
      },
    } as unknown as LaunchRequest;
    const identity = { name: 'test', uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0, home: root, workspace: root, enforced: false };
    const changes = await collectProfileChanges(spec, root, identity);
    assert.deepEqual(changes.artifacts.map((item) => item.path), ['artifacts/notes/new.txt', 'artifacts/notes/old.txt']);
    assert.deepEqual(changes.deletes, ['gone.bin', 'removed.txt']);
    assert.equal((await readFile(path.join(root, '.env'), 'utf8')), 'SECRET=value');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('unreadable profile object is never reported as deleted', { skip: process.getuid?.() === 0 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-unreadable-'));
  const data = path.join(root, 'data');
  try {
    execFileSync('git', ['init', '-q', root]);
    await writeFile(path.join(root, 'tracked.txt'), 'base');
    execFileSync('git', ['-C', root, 'add', '.']);
    execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base']);
    await mkdir(data);
    const bytes = Buffer.from('private object');
    await writeFile(path.join(data, 'heavy.bin'), bytes);
    await chmod(data, 0o000);
    const spec = { profileWorkspace: { excludedPatterns: [], artifacts: [{
      path: 'data/heavy.bin', key: 'profiles/profile-a/workspace/old/hash',
      sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length,
    }] } } as unknown as LaunchRequest;
    const identity = { name: 'test', uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0, home: root, workspace: root, enforced: false };
    await assert.rejects(() => collectProfileChanges(spec, root, identity), { code: 'EACCES' });
  } finally {
    await chmod(data, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
