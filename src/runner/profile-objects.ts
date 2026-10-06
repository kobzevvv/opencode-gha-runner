import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { isSafeRelativePath, type LaunchRequest } from '../contracts.js';
import type { Identity } from './identity.js';

const exec = promisify(execFile);

function checkedBucket(spec: LaunchRequest, configuredBucket: string | undefined): string {
  const bucket = spec.profileWorkspace?.objectBucket;
  if (!bucket || bucket !== configuredBucket) throw new Error('profile object bucket is not configured for this worker');
  return bucket;
}

/** Materialize only refs verified by the API, then verify the downloaded bytes again. */
export async function materializeProfileObjects(spec: LaunchRequest, workspace: string, identity: Identity, configuredBucket: string | undefined): Promise<void> {
  const artifacts = spec.profileWorkspace?.artifacts ?? [];
  if (artifacts.length === 0) return;
  const bucket = checkedBucket(spec, configuredBucket);
  for (const artifact of artifacts) {
    if (!isSafeRelativePath(artifact.path) || !artifact.key.startsWith(`profiles/${spec.profileId}/workspace/`)) throw new Error('unsafe profile artifact ref');
    const target = path.resolve(workspace, artifact.path);
    if (!target.startsWith(`${path.resolve(workspace)}${path.sep}`)) throw new Error('profile artifact escapes workspace');
    const segments = artifact.path.split('/');
    let parent = workspace;
    for (const segment of segments.slice(0, -1)) {
      parent = path.join(parent, segment);
      const current = await lstat(parent).catch(() => null);
      if (current?.isSymbolicLink() || (current && !current.isDirectory())) throw new Error('profile artifact parent is not a directory');
      if (!current) await mkdir(parent);
    }
    const existing = await lstat(target).catch(() => null);
    if (existing?.isSymbolicLink() || (existing && !existing.isFile())) throw new Error('profile artifact target is not a regular file');
    const staging = await mkdtemp(path.join(tmpdir(), 'profile-object-'));
    try {
      const temporary = path.join(staging, 'object');
      await exec('gcloud', ['storage', 'cp', `gs://${bucket}/${artifact.key}`, temporary, '--quiet']);
      const bytes = await readFile(temporary);
      if (bytes.length !== artifact.size || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw new Error('profile artifact checksum mismatch');
      await writeFile(target, bytes, { mode: 0o600 });
      if (identity.enforced) await exec('sudo', ['chown', '-R', `${identity.uid}:${identity.gid}`, target]);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
}

export async function uploadProfileObject(spec: LaunchRequest, configuredBucket: string | undefined, source: string, sha256: string): Promise<string> {
  const bucket = checkedBucket(spec, configuredBucket);
  const key = `profiles/${spec.profileId}/workspace/${spec.runId}/${sha256}`;
  await exec('gcloud', ['storage', 'cp', source, `gs://${bucket}/${key}`, '--quiet']);
  return key;
}
