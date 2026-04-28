/**
 * Per-issue pipeline orchestrator.
 *
 * Steps:
 *   1. Worktree setup (git worktree + npm install).
 *   2. Developer agent (first pass).
 *   3. Linear IN REVIEW + Slack notify.
 *   4. Review loop (up to MAX_REVIEW_CYCLES).
 *   5. PR creation + Linear/Slack status update.
 *
 * Failures are routed through `failureRouter` which decides whether
 * to schedule a transient retry (worktree preserved) or escalate to a
 * permanent failure (worktree removed, Slack/Linear notified).
 */

import type { FailureKind, Issue } from "@/types/pipeline";
import { branchFor, createWorktree, removeWorktree } from "./worktree";
import { runDeveloperAgent } from "./developerAgent";
import { runReviewLoop, formatFeedback } from "./reviewLoop";
import { createPr } from "./prCreator";
import { mergePr } from "@/integrations/github/pr";
import { applyMergedPr } from "@/integrations/github/merge";
import {
  clearRetryState,
  markFailed,
  markPrOpened,
  markStarted,
  recordTokenUsage,
  updateStatus,
} from "@/db/repositories/issues";
import { appendEvent } from "@/db/repositories/events";
import {
  onFlagged,
  onPickedUp,
  onReadyToMerge,
} from "@/integrations/linear/statusSync";
import { addComment } from "@/integrations/linear/client";
import { extractAgentMessage } from "@/integrations/claude/spawn";
import {
  notifyAgentStarted,
  notifyAutoMerged,
  notifyPrCreationBlocked,
  notifyPrFlagged,
  notifyPrReady,
} from "@/integrations/slack/notifier";
import type { NotifyTarget } from "@/integrations/slack/notifier";
import { logger } from "@/utils/logger";
import { routeFailure } from "./failureRouter";
import { config } from "@/config";

const log = logger.child({ component: "pipeline" });

export async function runPipeline(issue: Issue): Promise<void> {
  const pipelineLog = log.child({ issueId: issue.id });

  const target: NotifyTarget = { id: issue.id, title: issue.title, linearUrl: issue.linearUrl };

  // When the previous run failed transiently inside the review loop, the dev
  // work is already committed to the worktree and Linear is in "In Review".
  // Skip the dev first pass and the In-Progress flip; re-enter the review loop
  // directly so the reviewer gets another shot without burning tokens or
  // jiggling Linear state.
  const resumingFromReview =
    issue.lastFailureKind !== null && issue.lastFailureStage === "review";

  pipelineLog.info("pipeline start", {
    retryCount: issue.retryCount,
    lastFailureKind: issue.lastFailureKind,
    lastFailureStage: issue.lastFailureStage,
    resumingFromReview,
  });

  markStarted(issue.id);
  if (issue.linearUuid && !resumingFromReview) {
    await onPickedUp(issue.linearUuid);
  }
  const isFreshStart = issue.retryCount === 0 && issue.lastFailureKind === null;
  if (isFreshStart) {
    notifyAgentStarted(target).catch(() => {});
  }

  let worktreePath: string | null = null;

  try {
    const wt = await createWorktree(issue.id);
    worktreePath = wt.path;
    appendEvent({
      issueId: issue.id,
      eventType: "worktree_created",
      detail: `path=${wt.path} branch=${wt.branch} created=${wt.created}`,
    });

    let initialDevSummary: string | undefined;

    if (!resumingFromReview) {
      updateStatus(issue.id, "running");
      appendEvent({
        issueId: issue.id,
        eventType: "dev_agent_started",
        detail: `cycle=1 retryCount=${issue.retryCount}`,
      });
      const firstRun = await runDeveloperAgent({
        issue,
        worktreePath: wt.path,
        reviewFeedback: null,
      });
      if (firstRun.tokenUsage) recordTokenUsage(issue.id, firstRun.tokenUsage);
      appendEvent({
        issueId: issue.id,
        eventType: "dev_agent_complete",
        detail: `ok=${firstRun.ok} timedOut=${firstRun.timedOut}`,
      });

      if (firstRun.ok && issue.linearUuid) {
        const summary = extractAgentMessage(firstRun.result);
        initialDevSummary = summary ?? undefined;
        if (summary) {
          addComment(issue.linearUuid, summary).catch((err) =>
            pipelineLog.warn("linear dev summary comment failed", { error: String(err) }),
          );
        }
      }

      if (!firstRun.ok) {
        const kind = firstRun.failure ?? {
          type: "agent_error" as const,
          message: `Exit ${firstRun.exitCode}: ${firstRun.stderr.slice(0, 500)}`,
        };
        const action = await routeFailure(issue, kind, { stage: "dev" });
        if (action.dropWorktree) {
          await removeWorktree(issue.id).catch(() => {});
        }
        return;
      }
    } else {
      pipelineLog.info("resuming inside review loop — dev first pass skipped", {
        priorReviewCycle: issue.reviewCycle,
        lastFailureKind: issue.lastFailureKind,
      });
      appendEvent({
        issueId: issue.id,
        eventType: "dev_agent_complete",
        detail: `resume_skip stage=review priorCycle=${issue.reviewCycle} lastFailureKind=${issue.lastFailureKind}`,
      });
    }

    const review = await runReviewLoop({
      issue,
      worktreePath: wt.path,
      linearUuid: issue.linearUuid,
      resumingFromReview,
      initialDevSummary,
    });

    if (review.transientFailure) {
      return;
    }

    // PR creation.
    const unresolved = review.flagged ? formatFeedback(review.finalVerdict) : null;
    let pr;
    try {
      pr = await createPr({
        issue,
        branch: branchFor(issue.id),
        worktreePath: wt.path,
        reviewCycles: review.cycles,
        flagged: review.flagged,
        unresolvedFeedback: unresolved,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      pipelineLog.error("pr creation blocked", { error: reason });
      markFailed(issue.id, `pr_creation_blocked: ${reason}`.slice(0, 1000));
      appendEvent({
        issueId: issue.id,
        eventType: "pr_creation_blocked",
        detail: reason.slice(0, 500),
      });
      notifyPrCreationBlocked(target, reason.slice(0, 300)).catch((slackErr) =>
        pipelineLog.warn("slack pr_blocked notify failed", { error: String(slackErr) }),
      );
      // Worktree retained — the validated commit must stay inspectable for
      // manual push. Linear status unchanged — keeps the issue in "In Review"
      // so the reconciler's Retry-via-Todo path doesn't auto-respawn the pipeline.
      return;
    }

    markPrOpened({
      id: issue.id,
      prUrl: pr.prUrl,
      prNumber: pr.prNumber,
      prStatus: pr.prStatus,
    });
    clearRetryState(issue.id);

    appendEvent({
      issueId: issue.id,
      eventType: "pr_opened",
      detail: `${pr.prUrl} status=${pr.prStatus} cycles=${review.cycles}`,
    });

    const cfg = config();

    if (review.flagged) {
      // Flagged PRs are never auto-merged — they need human attention.
      if (issue.linearUuid) {
        await onFlagged(issue.linearUuid, review.cycles, unresolved ?? "", pr.prUrl);
      }
      notifyPrFlagged(
        target,
        pr.prUrl,
        review.cycles,
        review.finalVerdict.summary,
        review.finalVerdict.issues,
      ).catch((err) => pipelineLog.warn("slack flagged notify failed", { error: String(err) }));
    } else if (cfg.autoMerge) {
      // Auto-merge: reviewer passed cleanly, merge immediately without
      // waiting for a human. The GitHub merge webhook will still fire and
      // call applyMergedPr, but that's idempotent — it's a no-op if the
      // issue is already marked merged.
      try {
        await mergePr({
          prNumber: pr.prNumber,
          worktreePath: wt.path,
          strategy: cfg.autoMergeStrategy,
          repoUrl: cfg.repoUrl,
        });
        await applyMergedPr({
          issue,
          prNumber: pr.prNumber,
          prUrl: pr.prUrl,
          mergedAt: new Date().toISOString(),
          source: "auto_merge",
        });
        notifyAutoMerged(target, pr.prUrl).catch((err) =>
          pipelineLog.warn("slack auto-merged notify failed", { error: String(err) }),
        );
      } catch (err) {
        // Merge attempt failed (e.g. branch protection, required checks not
        // passing). The PR is already open — fall back to the normal
        // "ready to merge" path and let a human merge it.
        const reason = err instanceof Error ? err.message : String(err);
        pipelineLog.warn("auto-merge failed, falling back to manual merge", { error: reason });
        if (issue.linearUuid) await onReadyToMerge(issue.linearUuid, pr.prUrl);
        notifyPrReady(target, pr.prUrl).catch((e) =>
          pipelineLog.warn("slack ready notify failed", { error: String(e) }),
        );
      }
    } else {
      if (issue.linearUuid) await onReadyToMerge(issue.linearUuid, pr.prUrl);
      notifyPrReady(target, pr.prUrl).catch((err) =>
        pipelineLog.warn("slack ready notify failed", { error: String(err) }),
      );
    }

    await removeWorktree(issue.id);

    pipelineLog.info("pipeline complete", {
      cycles: review.cycles,
      prStatus: pr.prStatus,
      prNumber: pr.prNumber,
      autoMerged: cfg.autoMerge && !review.flagged,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const kind: FailureKind = { type: "agent_error", message: reason };
    await routeFailure(issue, kind, { stage: "pipeline" });
    if (worktreePath) await removeWorktree(issue.id).catch(() => {});
    throw err;
  }
}
