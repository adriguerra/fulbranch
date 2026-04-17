import * as github from "../services/github.js";
import { reviewCode } from "../services/llm.js";
import { getTaskById, updateTask } from "../db/db.js";
import type { ReviewResult, Task } from "../types.js";
import { taskLog } from "../logger.js";
import { config } from "../config.js";

/** Prevents overlapping reviews for the same task (rapid pushes vs orchestrator). */
const reviewLocks = new Set<string>();

function formatReviewComment(
  result: ReviewResult,
  opts: { blockedAfterMax: boolean }
): string {
  const verdictLine =
    result.verdict === "pass"
      ? "**Verdict:** ✅ Pass"
      : "**Verdict:** ❌ Needs work";
  const issuesBody =
    result.issues.length > 0
      ? result.issues.map((i) => `- ${i}`).join("\n")
      : "- _(none)_";
  const blockedNote = opts.blockedAfterMax
    ? "\n\n_Max review retries reached — task marked blocked._\n"
    : "";
  return `## Fulbranch Review

${verdictLine}

### Issues
${issuesBody}

### Summary
${result.summary}${blockedNote}
---
*Fulbranch automated review — push a fix to re-trigger*`;
}

export async function runReviewer(task: Task): Promise<void> {
  if (reviewLocks.has(task.id)) {
    taskLog(task.id, "review skipped: already in progress");
    return;
  }

  reviewLocks.add(task.id);
  try {
    const fresh = getTaskById(task.id);
    if (!fresh) {
      return;
    }

    if (fresh.pr_number == null) {
      taskLog(fresh.id, "review skipped: no PR number");
      return;
    }

    if (fresh.status === "done" || fresh.status === "blocked") {
      return;
    }

    const prNumber = fresh.pr_number;
    task = fresh;

    const diff = await github.getPRDiff(prNumber);
    const result = await reviewCode(diff);

    const maxRetries = config.maxReviewRetries;
    let blockedAfterMax = false;
    if (result.verdict === "needs_work" && task.retries >= maxRetries) {
      blockedAfterMax = true;
    }

    const commentBody = formatReviewComment(result, { blockedAfterMax });
    await github.postPRComment(prNumber, commentBody);
    taskLog(task.id, `review posted to PR #${prNumber}`);

    if (result.verdict === "pass") {
      taskLog(
        task.id,
        `review: pass — ${result.summary} (marking PR ready for humans)`
      );
      await github.markPRReady(prNumber);
      updateTask(task.id, { status: "done" });
      taskLog(task.id, "review → done (PR ready for review)");
      return;
    }

    taskLog(
      task.id,
      `review: needs_work — ${result.summary} (issues: ${result.issues.length})`
    );

    if (task.retries < maxRetries) {
      const nextRetries = task.retries + 1;
      const feedback = [
        result.summary,
        ...result.issues.map((i) => `- ${i}`),
      ].join("\n");
      updateTask(task.id, {
        status: "in_progress",
        retries: nextRetries,
        review_feedback: feedback,
      });
      taskLog(
        task.id,
        `review: needs_work (retry ${nextRetries}/${maxRetries}) — review → in_progress`
      );
      return;
    }

    taskLog(
      task.id,
      "review: needs_work but max retries reached — marking blocked"
    );
    updateTask(task.id, { status: "blocked" });
    taskLog(task.id, "review → blocked");
  } finally {
    reviewLocks.delete(task.id);
  }
}
