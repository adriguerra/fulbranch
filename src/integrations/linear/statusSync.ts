/**
 * Linear issues status sync per pipeline stage.
 * 
 */

import { updateIssueState } from "./client";
import { logger } from "@/utils/logger";

const log = logger.child({ component: "linear_sync" });

async function safeSync(op: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    log.warn("linear sync failed", {
      op,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Issue picked up → IN PROGRESS. */
export function onPickedUp(issueUuid: string): Promise<void> {
  return safeSync("pickedUp", () => updateIssueState(issueUuid, "In Progress"));
}

/** Dev complete → IN REVIEW. */
export function onInReview(
  issueUuid: string,
  _cycle: number,
  _maxCycles: number,
  _summary: string,
): Promise<void> {
  return safeSync("inReview", () => updateIssueState(issueUuid, "In Review"));
}

/** Reviewer FAIL → back to IN PROGRESS. */
export function onReviewFailed(
  issueUuid: string,
  _cycle: number,
  _feedback: string,
): Promise<void> {
  return safeSync("reviewFailed", () => updateIssueState(issueUuid, "In Progress"));
}

/** Reviewer PASS → IN REVIEW (awaiting human merge). */
export function onReadyToMerge(issueUuid: string, _prUrl: string): Promise<void> {
  return safeSync("readyToMerge", () => updateIssueState(issueUuid, "In Review"));
}

/** 3/3 cycles exhausted → IN REVIEW (PR open, needs attention). */
export function onFlagged(
  issueUuid: string,
  _maxCycles: number,
  _unresolved: string,
  _prUrl: string,
): Promise<void> {
  return safeSync("flagged", () => updateIssueState(issueUuid, "In Review"));
}

/** PR merged → DONE. */
export function onMerged(issueUuid: string, _unblocked: string[]): Promise<void> {
  return safeSync("merged", () => updateIssueState(issueUuid, "Done"));
}

/**
 * Failure → back to Todo.
 * Moving to Todo signals the issue is ready to re-dispatch on next
 * reconciliation tick (reconciler resets SQLite status=failed → pending
 * when it sees a failed issue back in Todo state in Linear).
 */
export function onFailed(issueUuid: string, _reason: string): Promise<void> {
  return safeSync("failed", () => updateIssueState(issueUuid, "Todo"));
}
