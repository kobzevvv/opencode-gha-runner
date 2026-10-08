import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { isSafeRelativePath, type LaunchRequest } from '../contracts.js';
import { runUnderIdentity, type Identity } from './identity.js';

const exec = promisify(execFile);
const MAX_SNAPSHOT_BYTES = 512 * 1024 * 1024;

export interface ProfileChangesManifest {
  files: Array<{ path: string; sha256: string; size: number }>;
  deletes: string[];
}

/** Put archive bytes where only this run identity can read them. */
export async function stageSnapshotArchive(source: string, workspace: string, identity: Identity): Promise<string> {
  const destination = path.join(workspace, `.profile-snapshot-${randomUUID()}.tar.gz`);
  try {
    if (identity.enforced) {
      await exec('sudo', ['install', '-m', '0600', '-o', String(identity.uid), '-g', String(identity.gid), source, destination]);
    } else {
      if (identity.uid !== (process.getuid?.() ?? identity.uid)) throw new Error('cannot securely stage snapshot for a different unenforced identity');
      await copyFile(source, destination);
      await chmod(destination, 0o600);
    }
    const stat = await lstat(destination);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error('profile snapshot archive permissions are not private');
    if (identity.enforced && stat.uid !== identity.uid) throw new Error('profile snapshot archive is not owned by the run identity');
    return destination;
  } catch (cause) {
    if (identity.enforced) await exec('sudo', ['rm', '-f', destination]).catch(() => undefined);
    else await rm(destination, { force: true });
    throw cause;
  }
}

/** Download, authenticate and safely materialize the API-owned snapshot for one run. */
export async function materializeProfileSnapshot(
  spec: LaunchRequest,
  workspace: string,
  identity: Identity,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const profile = spec.profileWorkspace;
  if (!profile) throw new Error('profile snapshot requested for a non-profile run');
  if (!/^https:\/\//.test(profile.snapshotUrl)) throw new Error('profile snapshot URL must use HTTPS');
  if (!/^[0-9a-f]{64}$/.test(profile.snapshotSha256) || !Number.isSafeInteger(profile.snapshotSize)
      || profile.snapshotSize < 0 || profile.snapshotSize > MAX_SNAPSHOT_BYTES) {
    throw new Error('profile snapshot digest or size is invalid');
  }
  if (!/^https:\/\//.test(profile.savebackUrl) || profile.savebackToken.length < 32) {
    throw new Error('profile saveback capability is invalid');
  }

  const response = await fetchImpl(profile.snapshotUrl, { redirect: 'error' });
  if (!response.ok) throw new Error(`profile snapshot download failed (${response.status})`);
  const declaredLength = Number(response.headers.get('content-length') ?? profile.snapshotSize);
  if (!Number.isSafeInteger(declaredLength) || declaredLength !== profile.snapshotSize || declaredLength > MAX_SNAPSHOT_BYTES) {
    throw new Error('profile snapshot response size is invalid');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('profile snapshot response has no body');
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > profile.snapshotSize || received > MAX_SNAPSHOT_BYTES) {
      await reader.cancel();
      throw new Error('profile snapshot exceeds declared size');
    }
    chunks.push(value);
  }
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  if (bytes.length !== profile.snapshotSize) throw new Error('profile snapshot size mismatch');
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== profile.snapshotSha256) throw new Error('profile snapshot checksum mismatch');

  await mkdir(workspace, { recursive: true, mode: 0o750 });
  const stagingDirectory = await mkdtemp(path.join(tmpdir(), 'profile-snapshot-'));
  const sourceArchive = path.join(stagingDirectory, 'snapshot.tar.gz');
  let privateArchive: string | undefined;
  try {
    await writeFile(sourceArchive, bytes, { mode: 0o600 });
    const archive = await stageSnapshotArchive(sourceArchive, workspace, identity);
    privateArchive = archive;
    // Validate names before extraction, then reject links/devices before tar can create them.
    const names = await runUnderIdentity(identity, 'tar', ['-tzf', archive], { PATH: process.env['PATH'] ?? '/usr/bin:/bin' });
    const entries = names.stdout.split('\n').filter(Boolean);
    if (entries.length > 100_000) throw new Error('profile snapshot has too many entries');
    for (const name of entries) {
      // GNU tar commonly prefixes entries from `tar -C <root> .` with `./` and
      // includes the root directory itself as `./`. Treat those as archive
      // notation, while still validating every path component after stripping it.
      let normalized = name.replace(/\/+$/, '');
      while (normalized.startsWith('./')) normalized = normalized.slice(2);
      if (normalized === '.') continue;
      if (!isSafeRelativePath(normalized)) throw new Error(`unsafe profile snapshot path: ${name}`);
      if (normalized === '.git' || normalized.startsWith('.git/')) throw new Error('profile snapshot may not contain a git metadata directory');
    }
    const verbose = await runUnderIdentity(identity, 'tar', ['-tvzf', archive], { PATH: process.env['PATH'] ?? '/usr/bin:/bin' });
    for (const line of verbose.stdout.split('\n').filter(Boolean)) {
      if (line[0] !== '-' && line[0] !== 'd') throw new Error('profile snapshot may contain only regular files and directories');
    }
    await mkdir(workspace, { recursive: true, mode: 0o750 });
    await runUnderIdentity(identity, 'tar', [
      '-xzf', archive, '-C', workspace, '--no-same-owner', '--no-same-permissions',
    ], { PATH: process.env['PATH'] ?? '/usr/bin:/bin' });
    // Archives made from a private temporary source directory can include a `./`
    // entry with mode 0700. Restore the host-created workspace mode before spawning
    // another helper with `cwd: workspace`; otherwise Node cannot start even sudo.
    if (identity.enforced) await exec('sudo', ['chmod', '0755', workspace]);
    else await chmod(workspace, 0o750);
    await runUnderIdentity(identity, 'rm', ['-f', archive], { PATH: process.env['PATH'] ?? '/usr/bin:/bin' });

    // Ensure the extracted tree contains only regular files/directories and no links escaped.
    const root = await realpath(workspace);
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        const stat = await lstat(absolute);
        if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error('profile snapshot contains a non-regular entry');
        const resolved = await realpath(absolute);
        if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error('profile snapshot entry escaped workspace');
        if (stat.isDirectory()) await walk(absolute);
        else if (stat.size > MAX_SNAPSHOT_BYTES) throw new Error('profile snapshot file exceeds size limit');
      }
    };
    await walk(root);
    // Repository snapshots preserve read-only Git modes (for example 0444). The
    // agent must be able to edit these files for read/append tasks and saveback.
    // Keep the imported tree private to the per-run identity while making it writable.
    const makeRunWritable = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        const stat = await lstat(absolute);
        if (stat.isDirectory()) {
          await chmod(absolute, 0o700);
          await makeRunWritable(absolute);
        } else {
          await chmod(absolute, 0o600);
        }
      }
    };
    // The host supervisor still traverses the workspace after the agent exits.
    // Preserve the host-accessible workspace root while keeping imported content private.
    await chmod(root, identity.enforced ? 0o755 : 0o750);
    await makeRunWritable(root);

    for (const artifact of profile.artifacts) {
      const absolute = path.resolve(workspace, artifact.path);
      if (!absolute.startsWith(`${root}${path.sep}`)) throw new Error(`profile artifact escaped workspace: ${artifact.path}`);
      const stat = await lstat(absolute);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== artifact.size) throw new Error(`profile artifact size mismatch: ${artifact.path}`);
      const actual = createHash('sha256').update(await readFile(absolute)).digest('hex');
      if (actual !== artifact.sha256) throw new Error(`profile artifact checksum mismatch: ${artifact.path}`);
    }

    // A synthetic local baseline lets the existing profile diff collector identify edits.
    await runUnderIdentity(identity, 'git', ['-C', workspace, 'init', '--quiet'], { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: identity.home });
    await runUnderIdentity(identity, 'git', ['-C', workspace, 'add', '-A'], { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: identity.home });
    await runUnderIdentity(identity, 'git', ['-C', workspace, '-c', 'user.name=Profile Snapshot', '-c', 'user.email=profile-snapshot@invalid', 'commit', '--quiet', '--allow-empty', '-m', 'API profile snapshot baseline'], { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: identity.home });
  } finally {
    if (privateArchive && identity.enforced) await exec('sudo', ['rm', '-f', privateArchive]).catch(() => undefined);
    else if (privateArchive) await rm(privateArchive, { force: true });
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}

export async function uploadProfileChanges(options: {
  spec: LaunchRequest;
  workspace: string;
  identity: Identity;
  files: Array<{ path: string; sha256: string; size: number }>;
  deletes: string[];
  fetchImpl?: typeof fetch;
}): Promise<ProfileChangesManifest> {
  const profile = options.spec.profileWorkspace;
  if (!profile) throw new Error('profile saveback requested for a non-profile run');
  const fetchImpl = options.fetchImpl ?? fetch;
  const declaredTotal = options.files.reduce((sum, file) => sum + file.size, 0);
  if (options.files.some((file) => !Number.isSafeInteger(file.size) || file.size < 0 || file.size > 50 * 1024 * 1024)
      || !Number.isSafeInteger(declaredTotal) || declaredTotal > 100 * 1024 * 1024) {
    throw new Error('profile saveback exceeds API upload limits');
  }
  const uploaded: Array<{ path: string; sha256: string; size: number }> = [];
  for (const file of options.files) {
    const relative = file.path.replace(/^artifacts\//, '');
    if (!isSafeRelativePath(relative)) throw new Error(`unsafe profile saveback path: ${relative}`);
    const absolute = path.resolve(options.workspace, relative);
    const bytes = await readFile(absolute);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== file.sha256 || bytes.length !== file.size) throw new Error(`profile saveback file changed after collection: ${relative}`);
    const url = new URL(profile.savebackUrl);
    url.searchParams.set('path', relative);
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${profile.savebackToken}`, 'content-type': 'application/octet-stream', 'x-content-sha256': file.sha256 },
      body: bytes,
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`profile saveback upload failed (${response.status}) for ${relative}`);
    uploaded.push({ path: relative, sha256: file.sha256, size: file.size });
  }
  return { files: uploaded, deletes: options.deletes };
}
