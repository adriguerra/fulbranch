import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import type {
  MergeStrategy,
  SpecDefinition,
  Task,
  TaskEvent,
  TaskScope,
  TaskStatus,
} from "../types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function nowIso(): string {
  return new Date().toISOString();
}

function hashSha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function parseJsonArray(value: unknown): string[] {
  if (typeof value !== "string" || !value.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}

function parseDatabaseUrl(url: string): string {
  if (url.startsWith("file:")) {
    return url.replace(/^file:/, "");
  }
  return url;
}

function getDbPath(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    return path.join(process.cwd(), "mainark.db");
  }
  return parseDatabaseUrl(url);
}

const dbPath = getDbPath();
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(dbPath);

const schemaPath = path.join(__dirname, "schema.sql");
const schema = fs.readFileSync(schemaPath, "utf-8");
db.exec(schema);

migrateTasksTable(db);

function migrateTasksTable(
  database: InstanceType<typeof Database>
): void {
  const cols = database
    .prepare("PRAGMA table_info(tasks)")
    .all() as { name: string }[];
  const names = new Set(cols.map((c) => c.name));

  const addColumn = (name: string, ddl: string) => {
    if (!names.has(name)) {
      database.exec(`ALTER TABLE tasks ADD COLUMN ${ddl}`);
    }
  };

  addColumn("latest_review_json", "latest_review_json TEXT");
  addColumn("review_issue_hashes", "review_issue_hashes TEXT");
  addColumn("repeat_count", "repeat_count INTEGER NOT NULL DEFAULT 0");
  addColumn("run_id", "run_id TEXT");
  addColumn("logical_key", "logical_key TEXT");
  addColumn("spec_hash", "spec_hash TEXT");
  addColumn("task_ref", "task_ref TEXT");
  addColumn("depends_on", "depends_on TEXT NOT NULL DEFAULT '[]'");
  addColumn("owned_files", "owned_files TEXT NOT NULL DEFAULT '[]'");
  addColumn("scope", "scope TEXT NOT NULL DEFAULT 'file'");
  addColumn("target", "target TEXT");
  addColumn("allow_parallel", "allow_parallel INTEGER NOT NULL DEFAULT 0");
  addColumn("blocked_reason", "blocked_reason TEXT");
  addColumn("failure_reason", "failure_reason TEXT");
  addColumn("merge_strategy", "merge_strategy TEXT");
  addColumn("merge_order", "merge_order INTEGER");
  addColumn("agent_output_json", "agent_output_json TEXT");

  database.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_logical_key ON tasks(logical_key) WHERE logical_key IS NOT NULL"
  );
  database.exec("CREATE INDEX IF NOT EXISTS idx_tasks_run_id ON tasks(run_id)");
  database.exec("CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)");
  database.exec(`CREATE TABLE IF NOT EXISTS task_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    run_id TEXT,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  database.exec(
    "CREATE INDEX IF NOT EXISTS idx_task_events_run_id_created_at ON task_events(run_id, created_at)"
  );
}

function rowToTask(row: Record<string, unknown>): Task {
  return {
    id: String(row.id),
    title: String(row.title),
    description: String(row.description ?? ""),
    status: row.status as TaskStatus,
    run_id: row.run_id == null ? null : String(row.run_id),
    logical_key: row.logical_key == null ? null : String(row.logical_key),
    spec_hash: row.spec_hash == null ? null : String(row.spec_hash),
    task_ref: row.task_ref == null ? null : String(row.task_ref),
    depends_on: parseJsonArray(row.depends_on),
    owned_files: parseJsonArray(row.owned_files),
    scope: (row.scope == null ? "file" : String(row.scope)) as TaskScope,
    target: row.target == null ? null : String(row.target),
    allow_parallel: Number(row.allow_parallel ?? 0) === 1,
    blocked_reason:
      row.blocked_reason == null ? null : String(row.blocked_reason),
    failure_reason:
      row.failure_reason == null ? null : String(row.failure_reason),
    merge_strategy:
      row.merge_strategy == null
        ? null
        : (String(row.merge_strategy) as MergeStrategy),
    merge_order: row.merge_order == null ? null : Number(row.merge_order),
    branch_name: row.branch_name == null ? null : String(row.branch_name),
    pr_url: row.pr_url == null ? null : String(row.pr_url),
    pr_number:
      row.pr_number == null ? null : Number(row.pr_number),
    retries: Number(row.retries ?? 0),
    review_feedback:
      row.review_feedback == null ? null : String(row.review_feedback),
    latest_review_json:
      row.latest_review_json == null ? null : String(row.latest_review_json),
    review_issue_hashes:
      row.review_issue_hashes == null ? null : String(row.review_issue_hashes),
    repeat_count: Number(row.repeat_count ?? 0),
    agent_output_json:
      row.agent_output_json == null ? null : String(row.agent_output_json),
    created_at: new Date(String(row.created_at)),
    updated_at: new Date(String(row.updated_at)),
  };
}

export function insertTaskPending(task: {
  id: string;
  title: string;
  description: string;
}): { inserted: boolean } {
  const ts = nowIso();
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO tasks (id, title, description, status, created_at, updated_at)
       VALUES (@id, @title, @description, 'pending', @created_at, @updated_at)`
    )
    .run({
      id: task.id,
      title: task.title,
      description: task.description,
      created_at: ts,
      updated_at: ts,
    });
  return { inserted: result.changes > 0 };
}

export interface SpecInsertOptions {
  runMode: "resume" | "new-run";
}

export function insertTasksFromSpec(
  spec: SpecDefinition,
  rawSpec: string,
  options: SpecInsertOptions = { runMode: "resume" }
): { runId: string; insertedTaskIds: string[]; reusedTaskIds: string[] } {
  const specHash = hashSha256(rawSpec);
  const runId =
    options.runMode === "resume"
      ? `run-${specHash.slice(0, 12)}`
      : `run-${Date.now().toString(36)}-${specHash.slice(0, 8)}`;
  const insertedTaskIds: string[] = [];
  const reusedTaskIds: string[] = [];
  const ts = nowIso();

  for (let i = 0; i < spec.tasks.length; i += 1) {
    const task = spec.tasks[i];
    const logicalKey = `${specHash}:${task.id}`;
    const taskRef = `${runId}:${task.id}`;
    const title = `[${task.id}] ${task.prompt.slice(0, 80)}`;
    const existing =
      options.runMode === "resume"
        ? (db
            .prepare("SELECT id FROM tasks WHERE logical_key = ?")
            .get(logicalKey) as { id?: string } | undefined)
        : undefined;
    if (existing?.id) {
      reusedTaskIds.push(task.id);
      continue;
    }

    db.prepare(
      `INSERT OR IGNORE INTO tasks (
        id, title, description, status, run_id, logical_key, spec_hash, task_ref,
        depends_on, owned_files, scope, target, allow_parallel, merge_strategy, merge_order,
        created_at, updated_at
      )
      VALUES (
        @id, @title, @description, 'pending', @run_id, @logical_key, @spec_hash, @task_ref,
        @depends_on, @owned_files, @scope, @target, @allow_parallel, @merge_strategy, @merge_order,
        @created_at, @updated_at
      )`
    ).run({
      id: taskRef,
      title,
      description: task.prompt,
      run_id: runId,
      logical_key: logicalKey,
      spec_hash: specHash,
      task_ref: taskRef,
      depends_on: JSON.stringify(task.depends_on.map((d) => `${runId}:${d}`)),
      owned_files: JSON.stringify(task.owned_files),
      scope: task.scope,
      target: task.target,
      allow_parallel: task.allow_parallel ? 1 : 0,
      merge_strategy: spec.merge.strategy,
      merge_order:
        spec.merge.order.length > 0 ? spec.merge.order.indexOf(task.id) : i,
      created_at: ts,
      updated_at: ts,
    });
    insertedTaskIds.push(task.id);
  }

  return { runId, insertedTaskIds, reusedTaskIds };
}

export function getTaskById(id: string): Task | null {
  const row = db
    .prepare("SELECT * FROM tasks WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;
  return row ? rowToTask(row) : null;
}

export function getTaskByBranchName(branchName: string): Task | null {
  const row = db
    .prepare("SELECT * FROM tasks WHERE branch_name = ?")
    .get(branchName) as Record<string, unknown> | undefined;
  return row ? rowToTask(row) : null;
}

export function getTaskByPrNumber(prNumber: number): Task | null {
  const row = db
    .prepare("SELECT * FROM tasks WHERE pr_number = ?")
    .get(prNumber) as Record<string, unknown> | undefined;
  return row ? rowToTask(row) : null;
}

/** Prefer DB row with matching PR number, else branch on head ref. */
export function findTaskForPullRequest(
  prNumber: number,
  headBranchName: string | null | undefined,
  taskRef: string | null | undefined
): Task | null {
  const byPr = getTaskByPrNumber(prNumber);
  if (byPr) {
    return byPr;
  }
  if (taskRef) {
    const byRef = getTaskByTaskRef(taskRef);
    if (byRef) {
      return byRef;
    }
  }
  if (headBranchName) {
    return getTaskByBranchName(headBranchName);
  }
  return null;
}

export type TaskUpdate = Partial<
  Pick<
    Task,
    | "title"
    | "description"
    | "status"
    | "run_id"
    | "logical_key"
    | "spec_hash"
    | "task_ref"
    | "depends_on"
    | "owned_files"
    | "scope"
    | "target"
    | "allow_parallel"
    | "blocked_reason"
    | "failure_reason"
    | "merge_strategy"
    | "merge_order"
    | "branch_name"
    | "pr_url"
    | "pr_number"
    | "retries"
    | "review_feedback"
    | "latest_review_json"
    | "review_issue_hashes"
    | "repeat_count"
    | "agent_output_json"
  >
>;

export function updateTask(id: string, patch: TaskUpdate): void {
  const current = getTaskById(id);
  if (!current) {
    throw new Error(`Task not found: ${id}`);
  }
  const next: Task = {
    ...current,
    ...patch,
    updated_at: new Date(nowIso()),
  };
  db.prepare(
    `UPDATE tasks SET
      title = @title,
      description = @description,
      status = @status,
      run_id = @run_id,
      logical_key = @logical_key,
      spec_hash = @spec_hash,
      task_ref = @task_ref,
      depends_on = @depends_on,
      owned_files = @owned_files,
      scope = @scope,
      target = @target,
      allow_parallel = @allow_parallel,
      blocked_reason = @blocked_reason,
      failure_reason = @failure_reason,
      merge_strategy = @merge_strategy,
      merge_order = @merge_order,
      branch_name = @branch_name,
      pr_url = @pr_url,
      pr_number = @pr_number,
      retries = @retries,
      review_feedback = @review_feedback,
      latest_review_json = @latest_review_json,
      review_issue_hashes = @review_issue_hashes,
      repeat_count = @repeat_count,
      agent_output_json = @agent_output_json,
      updated_at = @updated_at
    WHERE id = @id`
  ).run({
    id: next.id,
    title: next.title,
    description: next.description,
    status: next.status,
    run_id: next.run_id,
    logical_key: next.logical_key,
    spec_hash: next.spec_hash,
    task_ref: next.task_ref,
    depends_on: JSON.stringify(next.depends_on),
    owned_files: JSON.stringify(next.owned_files),
    scope: next.scope,
    target: next.target,
    allow_parallel: next.allow_parallel ? 1 : 0,
    blocked_reason: next.blocked_reason,
    failure_reason: next.failure_reason,
    merge_strategy: next.merge_strategy,
    merge_order: next.merge_order,
    branch_name: next.branch_name,
    pr_url: next.pr_url,
    pr_number: next.pr_number,
    retries: next.retries,
    review_feedback: next.review_feedback,
    latest_review_json: next.latest_review_json,
    review_issue_hashes: next.review_issue_hashes,
    repeat_count: next.repeat_count,
    agent_output_json: next.agent_output_json,
    updated_at: next.updated_at.toISOString(),
  });
}

export function getNextPendingTask(): Task | null {
  const row = db
    .prepare(
      `SELECT * FROM tasks WHERE status = 'pending'
       ORDER BY datetime(created_at) ASC LIMIT 1`
    )
    .get() as Record<string, unknown> | undefined;
  return row ? rowToTask(row) : null;
}

export function getReadyPendingTasks(limit: number): Task[] {
  const rows = db
    .prepare(
      `SELECT * FROM tasks WHERE status = 'pending'
       ORDER BY datetime(created_at) ASC LIMIT ?`
    )
    .all(limit) as Record<string, unknown>[];
  return rows.map(rowToTask);
}

export function getTasksAwaitingRetryImplementation(): Task[] {
  const rows = db
    .prepare(
      `SELECT * FROM tasks
       WHERE pr_number IS NOT NULL
         AND (
           status = 'fixing'
          OR status = 'running'
          OR (
            status = 'in_progress'
            AND review_feedback IS NOT NULL
            AND trim(review_feedback) != ''
          )
         )
       ORDER BY datetime(updated_at) ASC`
    )
    .all() as Record<string, unknown>[];
  return rows.map(rowToTask);
}

export function getTasksInReview(): Task[] {
  const rows = db
    .prepare(
      `SELECT * FROM tasks WHERE status = 'review' ORDER BY datetime(updated_at) ASC`
    )
    .all() as Record<string, unknown>[];
  return rows.map(rowToTask);
}

export function countOpenPRs(): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) as c FROM tasks WHERE status IN ('running', 'in_progress', 'fixing', 'review')`
    )
    .get() as { c: number };
  return Number(row.c);
}

export function markInProgress(taskId: string): void {
  updateTask(taskId, { status: "running", blocked_reason: null });
}

export function getAllTasks(): Task[] {
  const rows = db
    .prepare("SELECT * FROM tasks ORDER BY datetime(updated_at) DESC")
    .all() as Record<string, unknown>[];
  return rows.map(rowToTask);
}

export function getTasksByRunId(runId: string): Task[] {
  const rows = db
    .prepare(
      "SELECT * FROM tasks WHERE run_id = ? ORDER BY datetime(updated_at) DESC"
    )
    .all(runId) as Record<string, unknown>[];
  return rows.map(rowToTask);
}

export function appendTaskEvent(
  taskId: string,
  runId: string | null,
  message: string
): void {
  db.prepare(
    `INSERT INTO task_events (task_id, run_id, message, created_at)
     VALUES (@task_id, @run_id, @message, @created_at)`
  ).run({
    task_id: taskId,
    run_id: runId,
    message,
    created_at: nowIso(),
  });
}

function rowToTaskEvent(row: Record<string, unknown>): TaskEvent {
  return {
    id: Number(row.id),
    task_id: String(row.task_id),
    run_id: row.run_id == null ? null : String(row.run_id),
    message: String(row.message),
    created_at: new Date(String(row.created_at)),
  };
}

export function getTaskEventsByRunId(runId: string): TaskEvent[] {
  const rows = db
    .prepare(
      `SELECT * FROM task_events WHERE run_id = ? ORDER BY datetime(created_at) ASC`
    )
    .all(runId) as Record<string, unknown>[];
  return rows.map(rowToTaskEvent);
}

export function getTaskByTaskRef(taskRef: string): Task | null {
  const row = db
    .prepare("SELECT * FROM tasks WHERE task_ref = ?")
    .get(taskRef) as Record<string, unknown> | undefined;
  return row ? rowToTask(row) : null;
}
