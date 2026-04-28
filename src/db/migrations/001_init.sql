CREATE TABLE IF NOT EXISTS issues (
  id                    TEXT PRIMARY KEY,
  linear_uuid           TEXT,
  linear_url            TEXT,
  title                 TEXT NOT NULL,
  description           TEXT NOT NULL,
  depends_on            TEXT NOT NULL DEFAULT '',
  status                TEXT NOT NULL DEFAULT 'pending',  -- pending | paused | running | reviewing | pr_open | merged | failed
  review_cycle          INTEGER NOT NULL DEFAULT 0,
  pr_url                TEXT,
  pr_number             INTEGER,
  pr_status             TEXT,                             -- ready | flagged
  failure_reason        TEXT,
  started_at            DATETIME,
  pr_opened_at          DATETIME,
  pr_merged_at          DATETIME,
  token_usage           INTEGER,
  retry_count           INTEGER NOT NULL DEFAULT 0,
  next_retry_at         DATETIME,
  last_failure_kind     TEXT,
  last_failure_stage    TEXT,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_issues_status        ON issues (status);
CREATE INDEX IF NOT EXISTS idx_issues_pr_number     ON issues (pr_number);
CREATE INDEX IF NOT EXISTS idx_issues_next_retry_at ON issues (next_retry_at);

CREATE TABLE IF NOT EXISTS review_cycles (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id         TEXT NOT NULL,
  cycle_number     INTEGER NOT NULL,
  reviewer_verdict TEXT NOT NULL,
  feedback         TEXT NOT NULL DEFAULT '',
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_review_cycles_issue_id ON review_cycles (issue_id);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id   TEXT,
  event_type TEXT NOT NULL,
  detail     TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_events_issue_id   ON events (issue_id);
CREATE INDEX IF NOT EXISTS idx_events_created_at ON events (created_at);
