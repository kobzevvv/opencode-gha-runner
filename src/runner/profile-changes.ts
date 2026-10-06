import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { isSafeRelativePath, type ArtifactRef, type LaunchRequest } from '../contracts.js';
import { runUnderIdentity, type Identity } from './identity.js';

export interface ProfileChangeSet {
  artifacts: ArtifactRef[];
  deletes: string[];
}

function excluded(relative: string, rules: RegExp[]): boolean {
  const segments = relative.split('/');
  for (let index = 1; index <= segments.length; index += 1) {
    const candidate = segments.slice(0, index).join('/');
    if (rules.some((rule) => rule.test(candidate))) return true;
  }
  return false;
}

function mimeFor(relative: string): string {
  const ext = path.extname(relative).toLowerCase();
  return ({ '.md': 'text/markdown', '.txt': 'text/plain', '.json': 'application/json', '.csv': 'text/csv', '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg' } as Record<string, string>)[ext] ?? 'application/octet-stream';
}

/** Changed tracked files, deletions and new untracked files after the agent exits. */
export async function collectProfileChanges(spec: LaunchRequest, workspace: string, identity: Identity): Promise<ProfileChangeSet> {
  if (!spec.profileWorkspace) return { artifacts: [], deletes: [] };
  const rules = spec.profileWorkspace.excludedPatterns.map((source) => new RegExp(source));
  // The profile metadata belongs to the host even if the agent modified it.
  rules.push(/^\.trained-assist(?:\/|$)/);
  const gitEnv = { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: identity.home, GIT_TERMINAL_PROMPT: '0' };
  const modified = await runUnderIdentity(identity, 'git', ['-C', workspace, 'diff', 'HEAD', '--name-only', '-z'], gitEnv);
  const untracked = await runUnderIdentity(identity, 'git', ['-C', workspace, 'ls-files', '--others', '--exclude-standard', '-z'], gitEnv);
  const paths = new Set(`${modified.stdout}\0${untracked.stdout}`.split('\0').filter(Boolean));
  for (const artifact of spec.profileWorkspace.artifacts) {
    if (!(await lstat(path.resolve(workspace, artifact.path)).catch(() => null))) paths.add(artifact.path);
  }
  const root = await realpath(workspace);
  const inputArtifacts = new Map(spec.profileWorkspace.artifacts.map((entry) => [entry.path, entry]));
  const artifacts: ArtifactRef[] = [];
  const deletes: string[] = [];
  let totalBytes = 0;
  for (const relative of [...paths].sort()) {
    if (!isSafeRelativePath(relative) || excluded(relative, rules)) continue;
    const absolute = path.resolve(workspace, relative);
    const stat = await lstat(absolute).catch(() => null);
    if (!stat) { deletes.push(relative); continue; }
    if (stat.isSymbolicLink()) throw new Error(`profile change is a symlink: ${relative}`);
    if (!stat.isFile()) { deletes.push(relative); continue; }
    const real = await realpath(absolute);
    if (!real.startsWith(`${root}${path.sep}`)) throw new Error(`profile change escaped workspace: ${relative}`);
    const bytes = await readFile(real);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const prior = inputArtifacts.get(relative);
    if (prior && prior.sha256 === sha256 && prior.size === bytes.length) continue;
    totalBytes += bytes.length;
    if (artifacts.length >= 5000 || totalBytes > 128 * 1024 * 1024) throw new Error('profile changes exceed export policy limits');
    artifacts.push({ path: `artifacts/${relative}`, name: path.posix.basename(relative), mime: mimeFor(relative), sha256, size: bytes.length });
  }
  return { artifacts, deletes };
}
