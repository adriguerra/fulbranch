import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type { Task, TaskStatus } from "../types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function nowIso(): string {
  return new Date().toISOString();
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
    return path.join(process.cwd(), "fulbranch.db");
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

function rowToTask(row: Record<string, unknown>): Task {
  return {
    id: String(row.id),
    title: String(row.title),
    description: String(row.description ?? ""),
    status: row.status as TaskStatus,
    branch_name: row.branch_name == null ? null : String(row.branch_name),
    pr_url: row.pr_url == null ? null : String(row.pr_url),
    pr_number:
      row.pr_number == null ? null : Number(row.pr_number),
    retries: Number(row.retries ?? 0),
    review_feedback:
      row.review_feedback == null ? null : String(row.review_feedback),
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

export function getTaskById(id: string): Task | null {
  const row = db
    .prepare("SELECT * FROM tasks WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;
  return row ? rowToTask(row) : null;
}

export type TaskUpdate = Partial<
  Pick<
    Task,
    | "title"
    | "description"
    | "status"
    | "branch_name"
    | "pr_url"
    | "pr_number"
    | "retries"
    | "review_feedback"
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
      branch_name = @branch_name,
      pr_url = @pr_url,
      pr_number = @pr_number,
      retries = @retries,
      review_feedback = @review_feedback,
      updated_at = @updated_at
    WHERE id = @id`
  ).run({
    id: next.id,
    title: next.title,
    description: next.description,
    status: next.status,
    branch_name: next.branch_name,
    pr_url: next.pr_url,
    pr_number: next.pr_number,
    retries: next.retries,
    review_feedback: next.review_feedback,
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

export function getTasksAwaitingRetryImplementation(): Task[] {
  const rows = db
    .prepare(
      `SELECT * FROM tasks
       WHERE status = 'in_progress'
         AND review_feedback IS NOT NULL
         AND trim(review_feedback) != ''
         AND pr_number IS NOT NULL
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
      `SELECT COUNT(*) as c FROM tasks WHERE status IN ('in_progress', 'review')`
    )
    .get() as { c: number };
  return Number(row.c);
}

export function markInProgress(taskId: string): void {
  updateTask(taskId, { status: "in_progress" });
}
