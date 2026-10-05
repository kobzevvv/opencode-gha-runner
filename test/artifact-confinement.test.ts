import assert from 'node:assert/strict';
import filesystem from 'node:fs/promises';
import { mkdtemp, mkdir, writeFile, rename, symlink, link, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { collectArtifacts } from '../src/runner/artifacts.js';

for (const attack of ['file-symlink', 'file-replacement', 'parent-symlink', 'parent-inode-swap', 'post-open-parent-swap'] as const) {
  test(`collector rejects ${attack} before descriptor read and closes any opened descriptor`, async (context) => {
    const root = await mkdtemp(path.join(tmpdir(), 'artifact-race-'));
    context.after(() => rm(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'workspace');
    const directory = path.join(workspace, 'output');
    const outside = path.join(root, 'outside');
    await mkdir(directory, { recursive: true });
    await mkdir(outside);
    const selected = path.join(directory, 'result.txt');
    await writeFile(selected, 'selected safe bytes');
    await writeFile(path.join(outside, 'result.txt'), 'outside host secret');
    const workspaceReal = await realpath(workspace);
    const selectedReal = path.join(workspaceReal, 'output/result.txt');
    const originalOpen = filesystem.open.bind(filesystem);
    let reads = 0;
    let opened = 0;
    let closed = 0;
    const swapParent = async () => {
      await rename(directory, path.join(workspace, 'parked'));
      if (attack === 'parent-inode-swap') {
        await mkdir(directory);
        await link(path.join(workspace, 'parked/result.txt'), selected);
      } else {
        await symlink(outside, directory);
      }
    };
    context.mock.method(filesystem, 'open', async (...args: Parameters<typeof filesystem.open>) => {
      assert.equal(String(args[0]), selectedReal);
      if (attack === 'file-symlink' || attack === 'file-replacement') {
        await rename(selected, path.join(directory, 'parked.txt'));
        if (attack === 'file-symlink') await symlink(path.join(outside, 'result.txt'), selected);
        else await writeFile(selected, 'replacement secret');
      } else if (attack !== 'post-open-parent-swap') {
        await swapParent();
      }
      const descriptor = await originalOpen(...args);
      opened += 1;
      context.mock.method(descriptor, 'readFile', async () => {
        reads += 1;
        throw new Error('No descriptor bytes may be read before guards pass');
      });
      const close = descriptor.close.bind(descriptor);
      context.mock.method(descriptor, 'close', async () => { closed += 1; await close(); });
      if (attack === 'post-open-parent-swap') await swapParent();
      return descriptor;
    });
    const collected = await collectArtifacts(workspace, [{ path: 'output/result.txt' }]);
    assert.deepEqual(collected.artifacts, []);
    assert.deepEqual(collected.files, []);
    assert.deepEqual(collected.missing, ['output/result.txt']);
    assert.equal(reads, 0);
    assert.equal(closed, opened);
  });
}

test('collector reads a regular nested output from the validated descriptor', async (context) => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'artifact-regular-'));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  await mkdir(path.join(workspace, 'output'));
  await writeFile(path.join(workspace, 'output/result.txt'), 'regular file');
  const collected = await collectArtifacts(workspace, [{ path: 'output/result.txt' }]);
  assert.deepEqual(collected.missing, []);
  assert.equal(collected.files[0]!.content.toString(), 'regular file');
  assert.equal(collected.artifacts[0]!.size, Buffer.byteLength('regular file'));
});
