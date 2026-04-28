/**
 * Shared internal pipeline + DB types.
 *
 * Mirrors the SQLite schema.
 */

/**
 * Canonical pipeline state machine.
 *
 *   pending   — written to SQLite from webhook, not yet dispatched
 *   paused    — ticket moved to Backlog in Linear; dispatcher skips it until
 *               the developer moves it to an active state (Todo / In Progress)
 *   running   — worktree created, developer agent active
 *   reviewing — reviewer agent evaluating the diff
 *   pr_open   — PR opened on GitHub, awaiting human merge
 *   merged    — PR merged into main; unblocks dependents
 *   failed    — agent timeout, missing worktree on recovery, cycle, etc.
 */
export type IssueStatus =
  | "pending"
  | "paused"
  | "running"
  | "reviewing"
  | "pr_open"
  | "merged"
  | "failed";

/**
 * PR review/merge-readiness.
 *
 *   ready    — passed review, clean push
 *   flagged  — review cycles exhausted, NEEDS ATTENTION
 */
export type PrStatus = "ready" | "flagged";

export interface Issue {
  id: string;                 // real Linear identifier (e.g. ENG-144)
  linearUuid: string | null;  // Linear UUID (required for mutation API calls)
  linearUrl: string | null;   // Linear issue URL (used in Slack notifications)
  title: string;
  description: string;        // full Markdown body (passed verbatim to dev agent)
  dependsOn: string[];        // parsed real Linear IDs
  status: IssueStatus;
  reviewCycle: number;
  prUrl: string | null;
  prNumber: number | null;
  prStatus: PrStatus | null;
  failureReason: string | null;
  startedAt: string | null;
  prOpenedAt: string | null;
  prMergedAt: string | null;
  tokenUsage: number | null;

  // Retry state — populated by the failure router.
  retryCount: number;
  nextRetryAt: string | null;
  lastFailureKind: FailureKind["type"] | null;
  /**
   * Which pipeline stage produced the last failure. Used by runPipeline to
   * decide whether a resume should skip the developer first pass and re-enter
   * the review loop directly.
   */
  lastFailureStage: FailureStage | null;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  inputTokens: number;
  outputTokens: number;
}

export interface ReviewCycle {
  id: number;
  issueId: string;
  cycleNumber: number;
  verdict: "pass" | "fail";
  feedback: string;
  createdAt: string;
}

/**
 * event types
 */
export type EventType =
  | "worktree_created"
  | "dev_agent_started"
  | "dev_agent_complete"
  | "review_started"
  | "review_pass"
  | "review_fail"
  | "pr_opened"
  | "pr_creation_blocked"
  | "pr_merged"
  | "dependent_unblocked"
  | "agent_timeout"
  | "container_restart_recovery"
  | "webhook_received"
  | "webhook_ignored_unlabelled"
  | "dispatch_skipped_blocked"
  | "cycle_detected";

export interface Event {
  id: number;
  issueId: string | null;
  eventType: EventType;
  detail: string | null;
  createdAt: string;
}

/**
 * Reviewer verdict — must match the JSON schema in
 * pipeline/schemas/reviewerVerdict.ts.
 */
export interface ReviewerVerdict {
  verdict: "pass" | "fail";
  summary: string;
  issues: string[];
}

/**
 * Classified failure reason for a Claude agent run.
 *
 * The pipeline's failure router branches on `type` to decide what to do:
 *   - rate_limit  → schedule retry at resetsAt, keep worktree, suppress Slack
 *   - auth        → halt dispatcher, page humans
 *   - schema_invalid → reviewer JSON malformed, retry up to 2x same worktree
 *   - timeout     → exponential backoff retry, keep worktree
 *   - network     → exponential backoff retry, keep worktree
 *   - agent_error → genuine non-zero exit, mark failed, notify Slack
 */
export type FailureKind =
  | { type: "rate_limit"; message: string; resetsAt: Date | null }
  | { type: "auth"; message: string }
  | { type: "schema_invalid"; message: string; raw: unknown }
  | { type: "timeout"; message: string }
  | { type: "network"; message: string }
  | { type: "agent_error"; message: string };

/**
 * Pipeline stages a failure can be attributed to. Mirrors `context.stage` in
 * the failure router and feeds runPipeline's resume branching.
 */
export type FailureStage = "dev" | "review" | "pipeline";

/**
 * Helper: which failure kinds are "transient" — the orchestrator should
 * retry rather than mark the issue permanently failed, and should keep
 * the worktree alive so progress isn't thrown away.
 */
export function isTransient(kind: FailureKind): boolean {
  return (
    kind.type === "rate_limit" ||
    kind.type === "schema_invalid" ||
    kind.type === "timeout" ||
    kind.type === "network"
  );
}
