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

/**
 * Ошибка `workflow_dispatch`.
 *
 * `status === null` означает, что ответа не было вовсе (сеть, таймаут): диспатч мог
 * и пройти. Это принципиально отличается от явного 4xx, когда GitHub запрос отверг и
 * прогона заведомо не существует, — от этого различия зависит, можно ли забыть ран
 * и разрешить повтору диспатчить заново.
 */
export class DispatchError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = 'DispatchError';
    this.status = status;
  }

  /** GitHub отверг запрос: 4xx (нет workflow, нет прав, нет репо). Прогона нет. */
  get rejected(): boolean {
    return this.status !== null && this.status >= 400 && this.status < 500;
  }
}

/** Ран workflow_dispatch в списке прогонов. */
export interface WorkflowRunSummary {
  id: number;
  headSha: string;
  status: string;
  createdAtMs: number | null;
}

export interface WorkflowRunState {
  status: string;
  conclusion: string | null;
}

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
    // Привязка к globalThis обязательна: в Cloudflare Workers `fetch`, отвязанный от
    // `this` (например, положенный в поле объекта), падает с «Illegal invocation».
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
    this.userAgent = options.userAgent ?? 'opencode-gha-runner';
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
    const headers: Record<string, string> = {
      ...JSON_HEADERS,
      'x-github-api-version': '2022-11-28',
      'user-agent': this.userAgent,
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
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
    // Момент диспатча — единственная зацепка для корреляции: GitHub не отдаёт inputs
    // прогона списком, поэтому «наш» ран ищется как самый свежий, созданный после этого
    // времени. Так же восстанавливается ран, чей ответ на диспатч потерялся.
    const startedAt = Date.now();

    let status: number;
    let data: { message?: string };
    try {
      ({ status, data } = await this.request<{ message?: string }>(
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
      ));
    } catch (cause) {
      // Ответа не было: диспатч мог пройти, поэтому status null — «неизвестно», а не «нет».
      throw new DispatchError(`workflow_dispatch failed: ${cause instanceof Error ? cause.message : String(cause)}`, null);
    }
    if (status !== 204) {
      throw new DispatchError(`workflow_dispatch failed with ${status}: ${data?.message ?? 'unknown error'}`, status);
    }

    const runId = await this.waitForRunId(startedAt);
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
  private async listWorkflowRuns(perPage = 20): Promise<WorkflowRunSummary[]> {
    const params = new URLSearchParams({ per_page: String(perPage), event: 'workflow_dispatch' });
    const { data } = await this.request<{
      workflow_runs?: Array<{ id: number; head_sha: string; status: string; created_at?: string }>;
    }>('GET', `/repos/${this.repo}/actions/workflows/${this.workflow}/runs?${params}`);
    return (data.workflow_runs ?? []).map((run) => ({
      id: run.id,
      headSha: run.head_sha,
      status: run.status,
      createdAtMs: run.created_at ? Date.parse(run.created_at) : null,
    }));
  }

  /**
   * Прогон, появившийся после `sinceMs`, — чтобы понять, прошёл ли диспатч, чей ответ
   * потерялся.
   *
   * Точной корреляции по `operationId` у GitHub нет: inputs прогона не отдаются списком.
   * Поэтому опираемся на время создания плюс отсечку по `head_sha` ветки, а остаточный
   * риск (два диспатча в одном окне) гасит claim-токен: вторая джоба с тем же токеном
   * получает 409 и выходит, не запуская агента.
   */
  async findRunSince(sinceMs: number, options: { skewMs?: number } = {}): Promise<WorkflowRunSummary | null> {
    const skew = options.skewMs ?? 30_000;
    const floor = sinceMs - skew;
    const branch = await this.resolveRef();
    const head = await this.headSha(branch);
    const runs = await this.listWorkflowRuns();
    const candidates = runs
      .filter((run) => run.createdAtMs !== null && run.createdAtMs >= floor)
      .filter((run) => head.length === 0 || run.headSha === head)
      .sort((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0));
    return candidates[0] ?? null;
  }

  /** Current state of the exact workflow run previously adopted by this gateway. */
  async getWorkflowRunState(runId: number): Promise<WorkflowRunState | null> {
    const { status, data } = await this.request<{ status?: unknown; conclusion?: unknown }>(
      'GET',
      `/repos/${this.repo}/actions/runs/${runId}`,
    );
    if (status === 404) return null;
    if (status !== 200 || typeof data?.status !== 'string') {
      throw new Error(`could not read GitHub Actions run ${runId} (HTTP ${status})`);
    }
    return {
      status: data.status,
      conclusion: typeof data.conclusion === 'string' ? data.conclusion : null,
    };
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
   * Ищем по времени диспатча, а не «первый queued»: при параллельных запусках первый
   * queued может оказаться чужим прогоном, и тогда отмена погасила бы не тот ран.
   * GitHub событийно-консистентен, поэтому ждём появления с нарастающей паузой.
   */
  private async waitForRunId(sinceMs: number, attempts = 8): Promise<number> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const run = await this.findRunSince(sinceMs);
      if (run) return run.id;
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
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
