/**
 * Минимальный клиент GitHub: ровно три вызова, которые нужны воркеру.
 *
 * Отдельный файл, а не `gh` в shell, потому что (а) токен не должен оказываться в
 * argv процесса, (б) нужен `run_id` ответа диспатча — без него нечем отменять рана,
 * и (в) тесты должны подменяться без сети.
 */

export interface DispatchInput {
  runId: string;
  claimToken: string;
}

export interface DispatchResult {
  runId: number;
  htmlUrl: string;
}

export interface CancelResult {
  cancelled: boolean;
  reason: 'cancelled' | 'already_finished' | 'not_found' | 'not_dispatchable';
}

export interface GitHubClientOptions {
  token: string;
  /** `owner/name` — репозиторий с workflow. */
  repo: string;
  /** Файл workflow, например `run-agent.yml`. */
  workflow: string;
  ref?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  userAgent?: string;
}

const JSON_HEADERS = { 'content-type': 'application/json', accept: 'application/vnd.github+json' };

export class GitHubClient {
  private readonly token: string;
  private readonly repo: string;
  private readonly workflow: string;
  private readonly ref: string | undefined;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;

  constructor(options: GitHubClientOptions) {
    this.token = options.token;
    this.repo = options.repo;
    this.workflow = options.workflow;
    this.ref = options.ref;
    this.baseUrl = options.baseUrl ?? 'https://api.github.com';
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.userAgent = options.userAgent ?? 'opencode-gha-runner';
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        ...JSON_HEADERS,
        authorization: `Bearer ${this.token}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': this.userAgent,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await response.text();
    let data: unknown = undefined;
    if (text.length > 0) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { message: text.slice(0, 300) };
      }
    }
    return { status: response.status, data: data as T };
  }

  /**
   * Запускает workflow. GitHub на `workflow_dispatch` отвечает `204` без тела,
   * поэтому `run_id` берётся вторым вызовом — по нему потом работает отмена.
   */
  async dispatchWorkflow(input: DispatchInput): Promise<DispatchResult> {
    const branch = await this.resolveRef();
    const before = await this.headSha(branch);

    const { status, data } = await this.request<{ message?: string }>(
      'POST',
      `/repos/${this.repo}/actions/workflows/${this.workflow}/dispatches`,
      {
        // `ref` обязателен в REST API, хотя в UI выбирается неявно. Без него GitHub
        // отвечает 422 «"ref" wasn't supplied», поэтому ветка резолвится всегда —
        // либо из конфига, либо из default branch репозитория.
        ref: branch,
        inputs: {
          run_id: input.runId,
          claim_token: input.claimToken,
        },
      },
    );
    if (status !== 204) {
      throw new Error(`workflow_dispatch failed with ${status}: ${data?.message ?? 'unknown error'}`);
    }

    const runId = await this.waitForRunId(branch, before);
    return { runId, htmlUrl: `https://github.com/${this.repo}/actions/runs/${runId}` };
  }

  private cachedRef: string | null = null;

  /** Ветка для диспатча: из конфига, иначе default branch репозитория. */
  private async resolveRef(): Promise<string> {
    if (this.ref !== undefined && this.ref.length > 0) return this.ref;
    if (this.cachedRef !== null) return this.cachedRef;
    const repo = await this.request<{ default_branch?: string }>('GET', `/repos/${this.repo}`);
    const branch = repo.data.default_branch;
    if (!branch) throw new Error(`could not resolve the default branch of ${this.repo}`);
    this.cachedRef = branch;
    return branch;
  }

  /** Список прогонов этого workflow, от свежих к старым. */
  private async listWorkflowRuns(perPage = 10): Promise<Array<{ id: number; head_sha: string; status: string }>> {
    const params = new URLSearchParams({ per_page: String(perPage), event: 'workflow_dispatch' });
    const { data } = await this.request<{ workflow_runs?: Array<{ id: number; head_sha: string; status: string }> }>(
      'GET',
      `/repos/${this.repo}/actions/workflows/${this.workflow}/runs?${params}`,
    );
    return data.workflow_runs ?? [];
  }

  private async headSha(branch: string): Promise<string> {
    const ref = await this.request<{ object?: { sha?: string } }>(
      'GET',
      `/repos/${this.repo}/git/ref/heads/${branch}`,
    );
    return ref.data.object?.sha ?? '';
  }

  /**
   * `workflow_dispatch` отвечает `204` без тела, поэтому `run_id` приходится искать
   * вторым вызовом — без него нечем отменять рана.
   *
   * Берём первый прогон со статусом `queued`/`in_progress`: только что запущенный рана
   * всегда в этих статусах, а завершённые — `completed`. Если таких нет (диспатч был
   * секунду назад и статус уже сменился), сходим во второй раз и берём самый свежий.
   */
  private async waitForRunId(branch: string, beforeSha: string, attempts = 8): Promise<number> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const runs = await this.listWorkflowRuns();
      const fresh = runs.find((run) => run.status === 'queued' || run.status === 'in_progress');
      if (fresh) return fresh.id;
      const sameCommit = runs.find((run) => run.head_sha === beforeSha);
      if (sameCommit && attempt >= 2) return sameCommit.id;
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
    const runs = await this.listWorkflowRuns();
    if (runs.length > 0) return runs[0]!.id;
    throw new Error('workflow_dispatch accepted but no run appeared in the workflow run list');
  }

  /**
   * Отмена рана. Пробуем сначала `POST /cancel` — он работает и для выполняющегося
   * прогона; `rerun` не нужен, потому что повторный запуск рана — это новый `runId`
   * на стороне нашего API, а не тот же самый.
   */
  async cancelWorkflowRun(runId: number): Promise<CancelResult> {
    const detail = await this.request<{ status?: string; conclusion?: string }>(
      'GET',
      `/repos/${this.repo}/actions/runs/${runId}`,
    );
    if (detail.status === 404) return { cancelled: false, reason: 'not_found' };
    if (detail.status !== 200) return { cancelled: false, reason: 'not_dispatchable' };
    if (detail.data.status === 'completed') return { cancelled: false, reason: 'already_finished' };

    const cancel = await this.request<{ message?: string }>(
      'POST',
      `/repos/${this.repo}/actions/runs/${runId}/cancel`,
    );
    if (cancel.status === 202 || cancel.status === 200) return { cancelled: true, reason: 'cancelled' };
    if (cancel.status === 409) return { cancelled: false, reason: 'already_finished' };
    if (cancel.status === 404) return { cancelled: false, reason: 'not_found' };
    return { cancelled: false, reason: 'not_dispatchable' };
  }
}
