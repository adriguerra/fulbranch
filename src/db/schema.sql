CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  run_id TEXT,
  logical_key TEXT,
  spec_hash TEXT,
  task_ref TEXT,
  depends_on TEXT NOT NULL DEFAULT '[]',
  owned_files TEXT NOT NULL DEFAULT '[]',
  scope TEXT NOT NULL DEFAULT 'file',
  target TEXT,
  allow_parallel INTEGER NOT NULL DEFAULT 0,
  blocked_reason TEXT,
  failure_reason TEXT,
  merge_strategy TEXT,
  merge_order INTEGER,
  branch_name TEXT,
  pr_url TEXT,
  pr_number INTEGER,
  retries INTEGER NOT NULL DEFAULT 0,
  review_feedback TEXT,
  latest_review_json TEXT,
  review_issue_hashes TEXT,
  repeat_count INTEGER NOT NULL DEFAULT 0,
  agent_output_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_logical_key
  ON tasks(logical_key)
  WHERE logical_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_run_id ON tasks(run_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

CREATE TABLE IF NOT EXISTS task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  run_id TEXT,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_task_events_run_id_created_at
  ON task_events(run_id, created_at);
