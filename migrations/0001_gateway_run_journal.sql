-- Mutable projection for fast reads and secret erasure, paired with a sanitized
-- append-only lifecycle journal. Journal rows intentionally have no FK to the
-- projection so rejected runs can be removed and retried without losing evidence.
CREATE TABLE IF NOT EXISTS gateway_runs (
  run_id TEXT PRIMARY KEY,
  user_task_id TEXT NOT NULL,
  operation_id TEXT NOT NULL UNIQUE,
  job_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  owner_generation INTEGER NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('queued', 'dispatched', 'claimed', 'running', 'done')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  github_run_id INTEGER,
  claim_token TEXT NOT NULL,
  report_token TEXT NOT NULL,
  run_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS gateway_runs_task_idx ON gateway_runs(user_task_id, created_at);
CREATE INDEX IF NOT EXISTS gateway_runs_phase_idx ON gateway_runs(phase, updated_at);

CREATE TABLE IF NOT EXISTS gateway_run_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  event_key TEXT NOT NULL,
  user_task_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  owner_generation INTEGER NOT NULL,
  github_run_id INTEGER,
  event_type TEXT NOT NULL,
  phase TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  UNIQUE(run_id, event_key)
);

CREATE INDEX IF NOT EXISTS gateway_run_events_task_idx ON gateway_run_events(user_task_id, occurred_at);
CREATE INDEX IF NOT EXISTS gateway_run_events_run_idx ON gateway_run_events(run_id, event_id);
