/**
 * Артефакты рана: объявленные выходы → коммит в репозиторий юзера.
 *
 * Issue #73, ключевое требование 1: «Артефакты — в GitHub-репозиторий юзера
 * (`repository.fullName`), НЕ в наш API». То есть воркер не отдаёт байты — он кладёт
 * их в репозиторий и возвращает `repo: { fullName, commit }`.
 *
 * Ветка детерминированная — `opencode-gha-runner/<runId>`. Так артефакты рана не
 * смешиваются с историей пользователя, но адрес ветки наш API может вычислить сам.
 */

import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import filesystem from 'node:fs/promises';
import { readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { ArtifactRef, OutputSpec } from '../contracts.js';
import { isSafeRelativePath } from '../contracts.js';



export interface CollectResult {
  artifacts: ArtifactRef[];
  files: Array<{ path: string; content: Buffer }>;
  /** Объявленные, но отсутствующие на диске — их absence не должна быть тихой. */
  missing: string[];
  /** Найденные, но не объявленные: попадают в манифест, но не считаются результатом. */
  undeclared: string[];
}

export async function sha256File(filePath: string): Promise<{ sha256: string; size: number }> {
  const buffer = await readFile(filePath);
  return { sha256: createHash('sha256').update(buffer).digest('hex'), size: buffer.length };
}

function guessMime(name: string, declared: string | undefined): string {
  if (declared && declared.length > 0) return declared;
  const ext = path.extname(name).toLowerCase();
  const table: Record<string, string> = {
    '.md': 'text/markdown',
    '.txt': 'text/plain',
    '.json': 'application/json',
    '.html': 'text/html',
    '.csv': 'text/csv',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.log': 'text/plain',
  };
  return table[ext] ?? 'application/octet-stream';
}

function sameInode(selected: Stats, current: Stats): boolean {
  return selected.dev === current.dev && selected.ino === current.ino;
}

export async function readConfinedArtifact(workspaceReal: string, absolute: string): Promise<Buffer> {
  if (!isInside(workspaceReal, absolute)) throw new Error('Unsafe artifact path');
  const parents: Array<{ path: string; selected: Stats }> = [];
  let parent = workspaceReal;
  for (const segment of ['', ...path.relative(workspaceReal, path.dirname(absolute)).split(path.sep).filter(Boolean)]) {
    if (segment) parent = path.join(parent, segment);
    const selected = await filesystem.lstat(parent);
    if (!selected.isDirectory()) throw new Error('Unsafe artifact parent');
    parents.push({ path: parent, selected });
  }
  const selected = await filesystem.lstat(absolute);
  if (!selected.isFile()) throw new Error('Artifact is not a regular file');
  const selectedReal = await filesystem.realpath(absolute);
  if (!isInside(workspaceReal, selectedReal)) throw new Error('Unsafe artifact target');
  const descriptor = await filesystem.open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await descriptor.stat();
    if (!opened.isFile() || !sameInode(selected, opened)) throw new Error('Artifact identity changed');
    if (await filesystem.realpath(absolute) !== selectedReal) throw new Error('Artifact target changed');
    for (const directory of parents) {
      const current = await filesystem.lstat(directory.path);
      if (!current.isDirectory() || !sameInode(directory.selected, current)) throw new Error('Artifact parent changed');
    }
    const current = await filesystem.lstat(absolute);
    if (!current.isFile() || !sameInode(selected, current) || !sameInode(opened, current)) throw new Error('Artifact identity changed');
    if (process.platform === 'linux') {
      const openedReal = await filesystem.realpath(`/proc/self/fd/${descriptor.fd}`);
      if (openedReal !== selectedReal || !isInside(workspaceReal, openedReal)) throw new Error('Unsafe opened artifact');
    }
    return await descriptor.readFile();
  } finally {
    await descriptor.close();
  }
}

/**
 * Читает только объявленные выходы, и только по относительным путям внутри workspace.
 * Каждый путь проходит проверку на выход из каталога ещё до `readFile` — иначе
 * `../../.ssh/id_rsa` из `outputs` уехал бы в публичный репозиторий.
 */
export async function collectArtifacts(
  workspace: string,
  outputs: OutputSpec[] | undefined,
  readOnlyDirs: string[] = [],
): Promise<CollectResult> {
  const artifacts: ArtifactRef[] = [];
  const files: CollectResult['files'] = [];
  const missing: string[] = [];
  const undeclared: string[] = [];
  const declared = outputs ?? [];

  const workspaceReal = await realpathOrSelf(workspace);

  for (const output of declared) {
    if (!isSafeRelativePath(output.path)) {
      missing.push(output.path);
      continue;
    }
    const absolute = path.resolve(workspaceReal, output.path);

    // `name`/`mime` в контракте опциональны: выводим имя из последнего сегмента пути,
    // а MIME — по расширению. Так артефакт всегда описывается полностью, даже если
    // наш API прислал только `path`.
    const name = output.name ?? path.posix.basename(output.path);
    let content: Buffer;
    try {
      content = await readConfinedArtifact(workspaceReal, absolute);
    } catch {
      missing.push(output.path);
      continue;
    }
    const sha256 = createHash('sha256').update(content).digest('hex');
    const size = content.length;
    files.push({ path: `artifacts/${output.path}`, content });
    artifacts.push({
      path: `artifacts/${output.path}`,
      name,
      mime: guessMime(name, output.mime),
      sha256,
      size,
    });
  }

  for (const dir of readOnlyDirs) {
    const absolute = path.resolve(workspace, dir);
    try {
      const real = await realpathOrSelf(absolute);
      if (!isInside(workspaceReal, real)) continue;
      const entries = await readdir(real, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const rel = path.posix.join(dir, entry.name);
        if (!declared.some((output) => output.path === rel)) undeclared.push(rel);
      }
    } catch {
      // Каталога нет — это не ошибка, а «агент ничего не положил рядом».
    }
  }

  return { artifacts, files, missing, undeclared };
}

async function realpathOrSelf(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch {
    return path.resolve(target);
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Null-SHA git: собственный маркер «коммита нет». Валидатор нашего API требует
 * непустую строку в `repo.commit`, поэтому в случае неудачного пуша отдаём именно его,
 * а не выдуманный хэш и не пустоту.
 */
export const NULL_SHA = '0'.repeat(40);

export interface PushResult {
  fullName: string;
  commit: string;
  branch: string;
  /** Ветка, от которой ответвлялся ран, — чтобы наш API знал базу для merge. */
  baseRef?: string;
  pushed: string[];
}

export interface GitHubRepoApiOptions {
  token: string;
  repo: string;
  fetchImpl?: typeof fetch;
}

interface ContentsResponse {
  content?: { sha: string };
  commit?: { sha: string };
  message?: string;
}

/**
 * Кладёт артефакты в репозиторий через Contents API, а не через `git push`:
 * один вызов на файл, без клона, без приватного ключа в argv и без `GIT_ASKPASS`.
 */
export class GitHubRepoApi {
  private readonly token: string;
  private readonly repo: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GitHubRepoApiOptions) {
    this.token = options.token;
    this.repo = options.repo;
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
  }

  private async request<T>(method: string, apiPath: string, body?: unknown): Promise<{ status: number; data: T }> {
    const response = await this.fetchImpl(`https://api.github.com${apiPath}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'opencode-gha-runner',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let data: unknown;
    try {
      data = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      data = { message: text.slice(0, 300) };
    }
    return { status: response.status, data: data as T };
  }

  private async defaultBranchSha(): Promise<{ branch: string; sha: string } | null> {
    const repo = await this.request<{ default_branch?: string }>('GET', `/repos/${this.repo}`);
    if (repo.status !== 200) throw new Error(`GitHub repository lookup HTTP ${repo.status}`);
    const branch = repo.data.default_branch;
    if (!branch) return null;
    const ref = await this.request<{ object?: { sha?: string } }>('GET', `/repos/${this.repo}/git/ref/heads/${branch}`);
    if (ref.status !== 200 && ref.status !== 404) throw new Error(`GitHub base ref lookup HTTP ${ref.status}`);
    const sha = ref.data.object?.sha;
    return sha ? { branch, sha } : null;
  }

  private async branchSha(branch: string): Promise<string | null> {
    const ref = await this.request<{ object?: { sha?: string } }>('GET', `/repos/${this.repo}/git/ref/heads/${branch}`);
    if (ref.status !== 200 && ref.status !== 404) throw new Error(`GitHub publication ref lookup HTTP ${ref.status}`);
    return ref.data.object?.sha ?? null;
  }

  private async createBranch(branch: string, sha: string): Promise<boolean> {
    const created = await this.request('POST', `/repos/${this.repo}/git/refs`, {
      ref: `refs/heads/${branch}`,
      sha,
    });
    if (created.status !== 201) throw new Error(`GitHub branch creation HTTP ${created.status}`);
    return true;
  }

  /** Публичная ссылка на файл в конкретной ветке. */
  fileUrl(branch: string, filePath: string): string {
    return `https://github.com/${this.repo}/blob/${branch}/${filePath}`;
  }

  async pushFiles(options: {
    branch: string;
    commitMessage: string;
    files: Array<{ path: string; content: Buffer }>;
  }): Promise<PushResult> {
    if (options.files.length === 0) {
      return { fullName: this.repo, commit: NULL_SHA, branch: options.branch, pushed: [] };
    }

    const base = await this.defaultBranchSha();
    let branch = options.branch;
    let useBranch: string | undefined = branch;

    if (base === null) {
      // Репозиторий без единого коммита: GitHub не даёт создать ветку от HEAD,
      // поэтому первый файл кладём прямо в ветку по умолчанию, а ветку создаём вторым.
      branch = baseBranchFallback;
      useBranch = undefined;
    } else if ((await this.branchSha(branch)) === null) {
      if (!(await this.createBranch(branch, base.sha))) {
        throw new Error(`could not create branch ${branch}`);
      }
    }

    const pushed: string[] = [];
    for (const file of options.files) {
      const response = await this.request<ContentsResponse>(
        'PUT',
        `/repos/${this.repo}/contents/${filePathToApi(file.path)}`,
        {
          message: options.commitMessage,
          content: file.content.toString('base64'),
          branch: useBranch,
        },
      );
      if (response.status !== 200 && response.status !== 201) {
        throw new Error(`GitHub artifact write HTTP ${response.status}`);
      }
      pushed.push(file.path);
    }

    if (base === null) {
      // Теперь, когда default branch существует, заводим ран-ветку от её головы.
      const head = await this.branchSha(baseBranchFallback);
      if (head && (await this.branchSha(options.branch)) === null) {
        await this.createBranch(options.branch, head);
      }
    }

    const head = await this.branchSha(options.branch);
    if (!head) throw new Error('GitHub publication commit could not be verified');
    return {
      fullName: this.repo,
      commit: head,
      branch: options.branch,
      ...(base ? { baseRef: base.branch } : {}),
      pushed,
    };
  }
}

/** Имя ветки для репозитория, в котором ещё не было ни одного коммита. */
const baseBranchFallback = 'main';

function filePathToApi(filePath: string): string {
  return filePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

/** Манифест рана: кладётся рядом с артефактами, чтобы результат был читаем без нашего API. */
export function buildManifest(options: {
  runId: string;
  jobId: string;
  exitReason: string;
  exitCode: number | null;
  durationMs: number;
  artifacts: ArtifactRef[];
  missingOutputs: string[];
  startedAt: string;
  finishedAt: string;
}): Buffer {
  return Buffer.from(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        runId: options.runId,
        jobId: options.jobId,
        exitReason: options.exitReason,
        exitCode: options.exitCode,
        durationMs: options.durationMs,
        artifacts: options.artifacts,
        missingOutputs: options.missingOutputs,
        startedAt: options.startedAt,
        finishedAt: options.finishedAt,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}
