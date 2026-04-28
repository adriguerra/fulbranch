/**
 * Restart & recovery sweep.
 *
 * On container startup we look at:
 *   - Issues with status in ('running', 'reviewing') — interrupted mid-flight.
 *   - Issues with status='pending' AND next_retry_at IS NOT NULL — transient
 *     retries that may have been waiting on a wakeup timer that no longer
 *     exists. The dispatcher will arm a new timer, but if the scheduled
 *     time is already in the past we want to re-pick them ASAP.
 *
 * For interrupted runs:
 *   - worktree exists → flip back to `pending`, re-queue. The dispatcher
 *     will resume work in the existing worktree (Phase 2 worktree retention
 *     means partial progress is preserved across restarts too).
 *   - worktree missing → mark failed (worktree was the source of truth).
 *
 * We do NOT attempt to resume a partially-completed agent mid-task. Each
 * dispatch starts a fresh agent run; the worktree is what carries state.
 */

import { listByStatuses, markFailed, updateStatus } from "@/db/repositories/issues";
import { appendEvent } from "@/db/repositories/events";
import { worktreeExists } from "@/pipeline/worktree";
import { onFailed } from "@/integrations/linear/statusSync";
import { notifyPipelineFailed } from "@/integrations/slack/notifier";
import type { NotifyTarget } from "@/integrations/slack/notifier";
import { logger } from "@/utils/logger";

const log = logger.child({ component: "recovery" });

export async function recoverInterruptedRuns(): Promise<void> {
  const interrupted = listByStatuses(["running", "reviewing"]);
  if (interrupted.length === 0) {
    log.info("recovery: no interrupted runs");
    return;
  }

  log.info("recovery: interrupted runs found", {
    count: interrupted.length,
    ids: interrupted.map((i) => i.id),
  });

  for (const issue of interrupted) {
    const exists = worktreeExists(issue.id);
    if (exists) {
      // Phase 2c: leave retry state intact — the dispatcher will re-pick
      // this issue and resume work in the existing worktree. Don't reset
      // retry_count / last_failure_kind (those carry context for the next
      // run if it fails again under the same condition).
      updateStatus(issue.id, "pending");
      appendEvent({
        issueId: issue.id,
        eventType: "container_restart_recovery",
        detail: `worktree present, lastFailureKind=${issue.lastFailureKind ?? "none"} retryCount=${issue.retryCount}`,
      });
      log.info("recovery re-queued", {
        issueId: issue.id,
        lastFailureKind: issue.lastFailureKind,
        retryCount: issue.retryCount,
      });
    } else {
      const reason = "worktree missing after restart";
      markFailed(issue.id, reason);
      appendEvent({
        issueId: issue.id,
        eventType: "container_restart_recovery",
        detail: "worktree missing — marked failed",
      });
      if (issue.linearUuid) {
        await onFailed(issue.linearUuid, reason);
      }
      const target: NotifyTarget = { id: issue.id, title: issue.title, linearUrl: issue.linearUrl };
      await notifyPipelineFailed(target, reason).catch((err) =>
        log.warn("slack notify failed", {
          issueId: issue.id,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      log.warn("recovery marked failed", { issueId: issue.id });
    }
  }
}
