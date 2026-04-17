CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  branch_name TEXT,
  pr_url TEXT,
  pr_number INTEGER,
  retries INTEGER NOT NULL DEFAULT 0,
  review_feedback TEXT,
  latest_review_json TEXT,
  review_issue_hashes TEXT,
  repeat_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
