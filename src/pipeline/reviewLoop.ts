/**
 * Review loop.
 *
 *   - Runs the reviewer agent.
 *   - On PASS  → returns { passed: true, ... }.
 *   - On FAIL  → re-invokes the dev agent with feedback, loops.
 *   - On reviewer/dev transient failure → routes via failureRouter and
 *     returns transientFailure: true so the pipeline bails (worktree is
 *     preserved by the router for the next dispatch to resume in).
 *   - After MAX_REVIEW_CYCLES unresolved fails → returns { passed: false,
 *     flagged: true, ... }.
 *
 * The outer runPipeline() owns status transitions; this module only reports
 * the verdict + accumulated feedback (or transient bail).
 */

import { config } from "@/config";
import type { Issue, ReviewerVerdict } from "@/types/pipeline";
import { runDeveloperAgent } from "./developerAgent";
import { runReviewerAgent } from "./reviewerAgent";
import { appendCycle } from "@/db/repositories/reviewCycles";
import { appendEvent } from "@/db/repositories/events";
import {
  incrementReviewCycle,
  recordTokenUsage,
  updateStatus,
} from "@/db/repositories/issues";
import { onInReview, onReviewFailed } from "@/integrations/linear/statusSync";
import { addComment } from "@/integrations/linear/client";
import { extractAgentMessage } from "@/integrations/claude/spawn";
import { notifyInReview, notifyReviewFailed } from "@/integrations/slack/notifier";
import type { NotifyTarget } from "@/integrations/slack/notifier";
import { logger } from "@/utils/logger";
import { routeFailure } from "./failureRouter";

const log = logger.child({ component: "review_loop" });

export interface ReviewLoopResult {
  passed: boolean;
  flagged: boolean;
  cycles: number;
  finalVerdict: ReviewerVerdict;
  summary: string;
  /**
   * True when the loop bailed due to a transient agent failure that the
   * router scheduled a retry for. The pipeline must NOT open a PR.
   */
  transientFailure: boolean;
}

export interface ReviewLoopInput {
  issue: Issue;
  worktreePath: string;
  linearUuid: string | null;
  /**
   * Dev agent concluding message from the first pass (before the loop).
   * Forwarded to the first `notifyInReview` call so the Slack message
   * shows what was built.
   */
  initialDevSummary?: string;
  /**
   * True when re-entering after a transient review-stage failure. The first
   * iteration reuses the prior cycle number instead of bumping it, and
   * skips the Linear/Slack re-announce since the ticket is already in "In Review".
   */
  resumingFromReview?: boolean;
}

const EMPTY_VERDICT: ReviewerVerdict = { verdict: "fail", summary: "", issues: [] };

export async function runReviewLoop(input: ReviewLoopInput): Promise<ReviewLoopResult> {
  const cfg = config();
  const { issue, worktreePath, linearUuid } = input;
  const target: NotifyTarget = { id: issue.id, title: issue.title, linearUrl: issue.linearUrl };

  let cycle = input.resumingFromReview ? issue.reviewCycle : 0;
  let resumeFirstIteration = input.resumingFromReview === true;
  let lastVerdict: ReviewerVerdict = EMPTY_VERDICT;
  // Tracks the dev agent's concluding message for the current cycle so it
  // can be included in the Slack "In review" notification.
  let currentDevSummary: string | undefined = input.initialDevSummary;

  while (cycle < cfg.maxReviewCycles) {
    const isResumeIteration = resumeFirstIteration;
    if (resumeFirstIteration) {
      resumeFirstIteration = false;
    } else {
      cycle = incrementReviewCycle(issue.id);
    }

    updateStatus(issue.id, "reviewing");
    appendEvent({
      issueId: issue.id,
      eventType: "review_started",
      detail: isResumeIteration
        ? `cycle=${cycle}/${cfg.maxReviewCycles} resumed`
        : `cycle=${cycle}/${cfg.maxReviewCycles}`,
    });

    if (!isResumeIteration) {
      const summaryForLinear = lastVerdict.summary || "(implementation in progress)";
      if (linearUuid) {
        await onInReview(linearUuid, cycle, cfg.maxReviewCycles, summaryForLinear);
      }
      try {
        await notifyInReview(target, cycle, cfg.maxReviewCycles, currentDevSummary);
      } catch (err) {
        log.warn("slack notify inReview failed", {
          issueId: issue.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const reviewer = await runReviewerAgent({ issue, worktreePath });
    if (reviewer.tokenUsage) recordTokenUsage(issue.id, reviewer.tokenUsage);

    if (reviewer.failure) {
      await routeFailure(issue, reviewer.failure, { stage: "review" });
      return {
        passed: false,
        flagged: false,
        cycles: cycle,
        finalVerdict: lastVerdict,
        summary: lastVerdict.summary,
        transientFailure: true,
      };
    }

    const verdict = reviewer.verdict!;
    lastVerdict = verdict;

    const feedback = formatFeedback(verdict);

    appendCycle({
      issueId: issue.id,
      cycleNumber: cycle,
      verdict: verdict.verdict,
      feedback,
    });

    if (linearUuid) {
      const verdictComment = buildReviewerComment(verdict, cycle);
      addComment(linearUuid, verdictComment).catch((err) =>
        log.warn("linear reviewer comment failed", { issueId: issue.id, error: String(err) }),
      );
    }

    if (verdict.verdict === "pass") {
      appendEvent({ issueId: issue.id, eventType: "review_pass", detail: `cycle=${cycle}` });
      return {
        passed: true,
        flagged: false,
        cycles: cycle,
        finalVerdict: verdict,
        summary: verdict.summary,
        transientFailure: false,
      };
    }

    appendEvent({
      issueId: issue.id,
      eventType: "review_fail",
      detail: `cycle=${cycle} issues=${verdict.issues.length}`,
    });

    if (cycle >= cfg.maxReviewCycles) break;

    // FAIL with cycles remaining — notify, then re-run the developer agent.
    notifyReviewFailed(target, cycle, cfg.maxReviewCycles, verdict.summary, verdict.issues).catch(
      (err) => log.warn("slack reviewFailed notify failed", { issueId: issue.id, error: String(err) }),
    );

    if (linearUuid) await onReviewFailed(linearUuid, cycle, feedback);
    updateStatus(issue.id, "running");

    const devRun = await runDeveloperAgent({ issue, worktreePath, reviewFeedback: feedback });
    if (devRun.tokenUsage) recordTokenUsage(issue.id, devRun.tokenUsage);
    appendEvent({
      issueId: issue.id,
      eventType: "dev_agent_complete",
      detail: `retry cycle=${cycle} ok=${devRun.ok}`,
    });

    if (devRun.ok) {
      const devSummary = extractAgentMessage(devRun.result);
      currentDevSummary = devSummary ?? undefined;
      if (devSummary && linearUuid) {
        addComment(linearUuid, devSummary).catch((err) =>
          log.warn("linear dev retry comment failed", { issueId: issue.id, error: String(err) }),
        );
      }
    }

    if (!devRun.ok) {
      const kind = devRun.failure ?? {
        type: "agent_error" as const,
        message: `Developer exit ${devRun.exitCode}: ${devRun.stderr.slice(0, 500)}`,
      };
      await routeFailure(issue, kind, { stage: "dev" });
      return {
        passed: false,
        flagged: false,
        cycles: cycle,
        finalVerdict: verdict,
        summary: verdict.summary,
        transientFailure: true,
      };
    }
  }

  return {
    passed: false,
    flagged: true,
    cycles: cycle,
    finalVerdict: lastVerdict,
    summary: lastVerdict.summary,
    transientFailure: false,
  };
}

export function formatFeedback(verdict: ReviewerVerdict): string {
  if (verdict.issues.length === 0) return verdict.summary;
  return [
    verdict.summary,
    "",
    "Issues to fix:",
    ...verdict.issues.map((line, i) => `${i + 1}. ${line}`),
  ].join("\n");
}

function buildReviewerComment(verdict: ReviewerVerdict, cycle: number): string {
  const header = verdict.verdict === "pass"
    ? `Review cycle ${cycle}: passed`
    : `Review cycle ${cycle}: failed`;
  return verdict.issues.length > 0
    ? [header, "", verdict.summary, "", ...verdict.issues.map((line, i) => `${i + 1}. ${line}`)].join("\n")
    : [header, "", verdict.summary].join("\n");
}
