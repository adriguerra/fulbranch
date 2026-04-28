/**
 * `issues` table repository.
 *
 * Single source of truth for all ticket state transitions. The webhook
 * handler and the dispatcher both go through this module — never ad-hoc
 * SQL in feature code.
 */

import { db } from "@/db/client";
import type {
  FailureKind,
  FailureStage,
  Issue,
  IssueStatus,
  PrStatus,
} from "@/types/pipeline";
import type { TokenUsage } from "@/integrations/claude/spawn";

interface IssueRow {
  id: string;
  linear_uuid: string | null;
  linear_url: string | null;
  title: string;
  description: string;
  depends_on: string;
  status: IssueStatus;
  review_cycle: number;
  pr_url: string | null;
  pr_number: number | null;
  pr_status: PrStatus | null;
  failure_reason: string | null;
  started_at: string | null;
  pr_opened_at: string | null;
  pr_merged_at: string | null;
  token_usage: number | null;
  retry_count: number;
  next_retry_at: string | null;
  last_failure_kind: FailureKind["type"] | null;
  last_failure_stage: FailureStage | null;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  input_tokens: number;
  output_tokens: number;
}

function rowToIssue(row: IssueRow): Issue {
  return {
    id: row.id,
    linearUuid: row.linear_uuid,
    linearUrl: row.linear_url,
    title: row.title,
    description: row.description,
    dependsOn: row.depends_on ? row.depends_on.split(",").map((s) => s.trim()).filter(Boolean) : [],
    status: row.status,
    reviewCycle: row.review_cycle,
    prUrl: row.pr_url,
    prNumber: row.pr_number,
    prStatus: row.pr_status,
    failureReason: row.failure_reason,
    startedAt: row.started_at,
    prOpenedAt: row.pr_opened_at,
    prMergedAt: row.pr_merged_at,
    tokenUsage: row.token_usage,
    retryCount: row.retry_count ?? 0,
    nextRetryAt: row.next_retry_at,
    lastFailureKind: row.last_failure_kind,
    lastFailureStage: row.last_failure_stage,
    cacheCreationTokens: row.cache_creation_tokens ?? 0,
    cacheReadTokens: row.cache_read_tokens ?? 0,
    inputTokens: row.input_tokens ?? 0,
    outputTokens: row.output_tokens ?? 0,
  };
}

export interface UpsertIssueInput {
  id: string;
  linearUuid?: string | null;
  linearUrl?: string | null;
  title: string;
  description: string;
  dependsOn: string[];
}

/**
 * Insert or update on id. New rows default to `status=pending`.
 * Existing rows get their title/description/dependsOn refreshed but
 * status is preserved (we never downgrade a running ticket from a webhook).
 * linear_uuid is updated only when a new non-null value is provided.
 */
export function upsertIssue(input: UpsertIssueInput): Issue {
  const depsStr = input.dependsOn.join(",");
  const stmt = db().prepare(`
    INSERT INTO issues (id, linear_uuid, linear_url, title, description, depends_on, status)
    VALUES ($id, $linear_uuid, $linear_url, $title, $description, $depends_on, 'pending')
    ON CONFLICT(id) DO UPDATE SET
      linear_uuid = COALESCE(excluded.linear_uuid, issues.linear_uuid),
      linear_url  = COALESCE(excluded.linear_url, issues.linear_url),
      title       = excluded.title,
      description = excluded.description,
      depends_on  = excluded.depends_on,
      updated_at  = CURRENT_TIMESTAMP
    RETURNING *
  `);
  const row = stmt.get({
    $id: input.id,
    $linear_uuid: input.linearUuid ?? null,
    $linear_url: input.linearUrl ?? null,
    $title: input.title,
    $description: input.description,
    $depends_on: depsStr,
  }) as IssueRow;
  return rowToIssue(row);
}

export function getIssue(id: string): Issue | null {
  const row = db().prepare("SELECT * FROM issues WHERE id = ?").get(id) as
    | IssueRow
    | undefined;
  return row ? rowToIssue(row) : null;
}

export function getByPrNumber(prNumber: number): Issue | null {
  const row = db().prepare("SELECT * FROM issues WHERE pr_number = ?").get(prNumber) as
    | IssueRow
    | undefined;
  return row ? rowToIssue(row) : null;
}

export function listAll(): Issue[] {
  const rows = db().prepare("SELECT * FROM issues").all() as IssueRow[];
  return rows.map(rowToIssue);
}

export function listByStatus(status: IssueStatus): Issue[] {
  const rows = db()
    .prepare("SELECT * FROM issues WHERE status = ?")
    .all(status) as IssueRow[];
  return rows.map(rowToIssue);
}

export function listByStatuses(statuses: IssueStatus[]): Issue[] {
  if (statuses.length === 0) return [];
  const placeholders = statuses.map(() => "?").join(",");
  const rows = db()
    .prepare(`SELECT * FROM issues WHERE status IN (${placeholders})`)
    .all(...statuses) as IssueRow[];
  return rows.map(rowToIssue);
}

export function updateStatus(id: string, status: IssueStatus): void {
  db()
    .prepare("UPDATE issues SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(status, id);
}

export function markStarted(id: string): void {
  db()
    .prepare(
      "UPDATE issues SET status = 'running', started_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    )
    .run(id);
}

export function incrementReviewCycle(id: string): number {
  const row = db()
    .prepare(
      "UPDATE issues SET review_cycle = review_cycle + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? RETURNING review_cycle",
    )
    .get(id) as { review_cycle: number };
  return row.review_cycle;
}

export interface PrOpenedInput {
  id: string;
  prUrl: string;
  prNumber: number;
  prStatus: PrStatus;
}

export function markPrOpened(input: PrOpenedInput): void {
  db()
    .prepare(
      `UPDATE issues
         SET status = 'pr_open',
             pr_url = ?,
             pr_number = ?,
             pr_status = ?,
             pr_opened_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    )
    .run(input.prUrl, input.prNumber, input.prStatus, input.id);
}

export function markMerged(id: string): void {
  db()
    .prepare(
      `UPDATE issues
         SET status = 'merged',
             pr_merged_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    )
    .run(id);
}

export function markFailed(id: string, reason: string): void {
  db()
    .prepare(
      `UPDATE issues
         SET status = 'failed',
             failure_reason = ?,
             updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    )
    .run(reason, id);
}

export function setTokenUsage(id: string, tokens: number): void {
  db()
    .prepare(
      "UPDATE issues SET token_usage = COALESCE(token_usage, 0) + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    )
    .run(tokens, id);
}

/**
 * Increment cumulative cache + token telemetry from a TokenUsage block.
 * Phase 0 — used for measuring cross-cycle prompt-cache effectiveness.
 */
export function recordTokenUsage(id: string, usage: TokenUsage): void {
  db()
    .prepare(
      `UPDATE issues
         SET cache_creation_tokens = cache_creation_tokens + ?,
             cache_read_tokens     = cache_read_tokens + ?,
             input_tokens          = input_tokens + ?,
             output_tokens         = output_tokens + ?,
             token_usage           = COALESCE(token_usage, 0) + ?,
             updated_at            = CURRENT_TIMESTAMP
       WHERE id = ?`,
    )
    .run(
      usage.cacheCreationInputTokens,
      usage.cacheReadInputTokens,
      usage.inputTokens,
      usage.outputTokens,
      usage.total,
      id,
    );
}

/**
 * Schedule a transient-failure retry. The dispatcher will skip
 * this issue until `nextRetryAt` has passed. Status flips back to `pending`
 * so the dispatcher knows to consider it again at the right time.
 *
 * Also records which step produced the failure so runPipeline
 * can decide whether to resume at the dev step or skip ahead to review.
 */
export function scheduleRetry(input: {
  id: string;
  kind: FailureKind["type"];
  stage: FailureStage;
  reason: string;
  nextRetryAt: Date;
}): void {
  db()
    .prepare(
      `UPDATE issues
         SET status             = 'pending',
             retry_count        = retry_count + 1,
             next_retry_at      = ?,
             last_failure_kind  = ?,
             last_failure_stage = ?,
             failure_reason     = ?,
             updated_at         = CURRENT_TIMESTAMP
       WHERE id = ?`,
    )
    .run(
      input.nextRetryAt.toISOString(),
      input.kind,
      input.stage,
      input.reason,
      input.id,
    );
}

/**
 * Reset retry state — call on successful run boundary (PR opened, merged).
 */
export function clearRetryState(id: string): void {
  db()
    .prepare(
      `UPDATE issues
         SET retry_count        = 0,
             next_retry_at      = NULL,
             last_failure_kind  = NULL,
             last_failure_stage = NULL,
             updated_at         = CURRENT_TIMESTAMP
       WHERE id = ?`,
    )
    .run(id);
}

/**
 * List pending issues that are eligible for dispatch right now —
 * either never-failed or whose `next_retry_at` has elapsed.
 *
 * The dispatcher previously filtered out non-pending statuses in JS;
 * we keep that pattern by returning all issues, but the SQL here
 * lets a future caller scope to ready-now if needed.
 */
export function listDispatchable(): Issue[] {
  const rows = db()
    .prepare(
      `SELECT * FROM issues
       WHERE status = 'pending'
         AND (next_retry_at IS NULL OR next_retry_at <= CURRENT_TIMESTAMP)`,
    )
    .all() as IssueRow[];
  return rows.map(rowToIssue);
}

/**
 * Earliest next_retry_at among pending issues, in epoch ms. Used by the
 * dispatcher to schedule a wakeup timer so a rate-limited issue gets
 * picked up at the right moment without waiting for the next reconcile tick.
 */
export function nextScheduledRetryMs(): number | null {
  const row = db()
    .prepare(
      `SELECT MIN(next_retry_at) AS next_retry_at
         FROM issues
        WHERE status = 'pending' AND next_retry_at IS NOT NULL`,
    )
    .get() as { next_retry_at: string | null } | undefined;
  if (!row?.next_retry_at) return null;
  const ms = Date.parse(row.next_retry_at);
  return Number.isFinite(ms) ? ms : null;
}
