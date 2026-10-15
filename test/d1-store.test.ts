import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { D1RunStore, type D1Like, type D1StatementLike, type StoredRun } from '../src/gateway/store.js';

let DatabaseSyncCtor: typeof import('node:sqlite').DatabaseSync | undefined;
try { DatabaseSyncCtor = (await import('node:sqlite')).DatabaseSync; } catch { /* Node 20 remains supported; D1 race tests run on Node 22+. */ }

class LocalStatement implements D1StatementLike {
  values: unknown[] = [];
  constructor(private readonly db: InstanceType<NonNullable<typeof DatabaseSyncCtor>>, readonly sql: string) {}
  bind(...values: unknown[]): this { this.values = values; return this; }
  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.sql).get(...this.values as never[]) as T | undefined) ?? null;
  }
  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.sql).all(...this.values as never[]) as T[] };
  }
  async run(): Promise<unknown> { return this.db.prepare(this.sql).run(...this.values as never[]); }
}

class LocalD1 implements D1Like {
  constructor(private readonly db: InstanceType<NonNullable<typeof DatabaseSyncCtor>>) {}
  prepare(sql: string): D1StatementLike { return new LocalStatement(this.db, sql); }
  async batch(statements: D1StatementLike[]): Promise<{ meta: { changes: number } }[]> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map((statement) => {
        const item = statement as LocalStatement;
        const result = this.db.prepare(item.sql).run(...item.values as never[]);
        return { meta: { changes: Number(result.changes) } };
      });
      this.db.exec('COMMIT');
      return results;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

function fixture(): StoredRun {
  const request = {
    runId: 'run_test_123', jobId: 'job-42', userTaskId: 'task-42', profileId: 'profile-7',
    conversationId: 'conversation-9', operationId: 'operation-42', ownerGeneration: 3,
    engine: { name: 'test' }, input: { inlinePrompt: 'synthetic' }, cwd: '/tmp/work', envAllowlist: [],
    env: { LLM_API_KEY: 'secret-should-be-erased' }, limits: { timeoutMs: 1000 },
    repository: { fullName: 'owner/repo', branch: 'run/test' }, resultUrl: 'https://api.example/result',
    isolation: { mode: 'workspace' as const }, publicationToken: 'publication-secret',
  } as unknown as StoredRun['request'];
  return {
    runId: request.runId, operationId: request.operationId, request, phase: 'queued',
    createdAt: 100, updatedAt: 100, githubRunId: null, target: { repo: 'owner/runner', token: 'target-secret' },
    claimToken: 'claim-secret', reportToken: 'report-secret', result: null,
  };
}

function openStore(): { db: InstanceType<NonNullable<typeof DatabaseSyncCtor>>; store: D1RunStore } {
  if (!DatabaseSyncCtor) throw new Error('node:sqlite is unavailable');
  const db = new DatabaseSyncCtor(':memory:');
  db.exec(readFileSync(new URL('../../migrations/0001_gateway_run_journal.sql', import.meta.url), 'utf8'));
  return { db, store: new D1RunStore(new LocalD1(db)) };
}

test('D1 store atomically claims once, keeps identity history, and prevents phase regression', { skip: !DatabaseSyncCtor }, async () => {
  const { db, store } = openStore();
  try {
    const run = fixture();
    run.updatedAt += 1;
    await store.create(run);
    const claims = await Promise.all(Array.from({ length: 12 }, () => store.claim(run.runId, run.claimToken)));
    assert.equal(claims.filter(Boolean).length, 1);

    await store.patch(run.runId, { phase: 'dispatched', githubRunId: 481516 });
    const claimed = await store.get(run.runId);
    assert.equal(claimed?.phase, 'claimed');
    assert.equal(claimed?.githubRunId, 481516);

    const beforeRead = claimed?.updatedAt;
    await store.get(run.runId);
    assert.equal((await store.get(run.runId))?.updatedAt, beforeRead, 'status reads do not write state');

    const result = { runId: run.runId, status: 'started', exitReason: 'completed' } as unknown as NonNullable<StoredRun['result']>;
    const reports = await Promise.all(Array.from({ length: 8 }, () => store.complete(run.runId, run.reportToken, result)));
    assert.ok(reports.every(Boolean));
    const completed = await store.get(run.runId);
    assert.equal(completed?.phase, 'done');
    assert.deepEqual(completed?.request.env, {});
    assert.equal(completed?.request.input.inlinePrompt, '');
    assert.equal(completed?.request.mcp, undefined);
    assert.equal(completed?.target.token, '');
    assert.equal(completed?.claimToken, '');

    const rows = db.prepare(`SELECT run_id, user_task_id, operation_id, job_id, profile_id,
      conversation_id, owner_generation, github_run_id, event_type FROM gateway_run_events ORDER BY event_id`).all();
    assert.deepEqual(rows.map((row) => (row as { event_type: string }).event_type), ['created', 'claimed', 'transition', 'completed']);
    for (const row of rows as Array<Record<string, unknown>>) {
      assert.equal(row.run_id, run.runId);
      assert.equal(row.user_task_id, 'task-42');
      assert.equal(row.operation_id, 'operation-42');
      assert.equal(row.job_id, 'job-42');
      assert.equal(row.profile_id, 'profile-7');
      assert.equal(row.conversation_id, 'conversation-9');
      assert.equal(row.owner_generation, 3);
    }
    const eventColumns = db.prepare('PRAGMA table_info(gateway_run_events)').all() as Array<{ name: string }>;
    assert.ok(!eventColumns.some(({ name }) => /token|secret|payload|prompt|result/i.test(name)));
  } finally {
    db.close();
  }
});

test('D1 unique operation id backs concurrent launch deduplication', { skip: !DatabaseSyncCtor }, async () => {
  const { db, store } = openStore();
  try {
    const run = fixture();
    const outcomes = await Promise.allSettled([store.create(run), store.create({ ...run, runId: 'run_duplicate' })]);
    assert.equal(outcomes.filter(({ status }) => status === 'fulfilled').length, 1);
    assert.equal(await store.findByOperationId(run.operationId).then((saved) => saved?.runId), run.runId);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM gateway_run_events').get() as { count: number }).count, 1);
  } finally {
    db.close();
  }
});

test('retention removes only terminal projections and keeps their identity journal', { skip: !DatabaseSyncCtor }, async () => {
  const { db, store } = openStore();
  try {
    const completed = fixture();
    const ambiguous = fixture();
    ambiguous.runId = 'run_ambiguous';
    ambiguous.operationId = 'operation-ambiguous';
    ambiguous.request = { ...ambiguous.request, runId: ambiguous.runId, operationId: ambiguous.operationId };
    ambiguous.phase = 'dispatched';
    ambiguous.githubRunId = 9901;
    await store.create(completed);
    await store.create(ambiguous);
    await store.complete(completed.runId, completed.reportToken, {
      runId: completed.runId, status: 'started', exitReason: 'completed',
    } as unknown as NonNullable<StoredRun['result']>);
    await store.pruneTerminalBefore(Date.now() + 1);
    assert.equal(await store.get(completed.runId), null);
    assert.equal((await store.get(ambiguous.runId))?.phase, 'dispatched');
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM gateway_run_events').get() as { count: number }).count, 3);
  } finally {
    db.close();
  }
});
