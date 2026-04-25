import * as github from "../services/github.js";
import { reviewCode } from "../services/llm.js";
import { getTaskById, updateTask } from "../db/db.js";
import type { ReviewResult, StructuredReviewRecord, Task } from "../types.js";
import {
  issueFingerprint,
  parseIssueHashList,
  serializeIssueHashList,
} from "../review/structured.js";
import { taskLog } from "../logger.js";
import { config } from "../config.js";

/** Prevents overlapping reviews for the same task (rapid pushes vs orchestrator). */
const reviewLocks = new Set<string>();

function toStoredRecord(result: ReviewResult): StructuredReviewRecord {
  return {
    status: result.verdict === "pass" ? "pass" : "needs_work",
    summary: result.summary,
    issues: result.structuredIssues,
  };
}

function formatReviewComment(
  result: ReviewResult,
  opts: { blockedAfterMax: boolean; blockedRepeat?: boolean }
): string {
  const verdictLine =
    result.verdict === "pass"
      ? "**Verdict:** ✅ Pass"
      : "**Verdict:** ❌ Needs work";

  const issuesBody =
    result.structuredIssues.length > 0
      ? result.structuredIssues
          .map(
            (i) =>
              `- **${i.file}** (${i.severity}/${i.type}) — ${i.instruction}`
          )
          .join("\n")
      : "- _(none)_";

  let extra = "";
  if (opts.blockedRepeat) {
    extra +=
      "\n\n_Same issue fingerprint reappeared across reviews — task marked **blocked** (needs human)._";
  }
  if (opts.blockedAfterMax) {
    extra +=
      "\n\n_Max automated review retries reached — task marked **blocked**._";
  }

  return `## Mainark Review

${verdictLine}

### Issues
${issuesBody}

### Summary
${result.summary}${extra}
---
*Mainark automated review — push a fix to re-trigger*`;
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

    const storedRecord = toStoredRecord(result);
    const latestJson = JSON.stringify(storedRecord);

    const currFingerprints = result.structuredIssues.map((i) =>
      issueFingerprint(i.file, i.instruction)
    );
    const prevFingerprints = parseIssueHashList(task.review_issue_hashes);
    const overlap = currFingerprints.filter((h) =>
      prevFingerprints.includes(h)
    );

    let nextRepeat = task.repeat_count;
    if (result.verdict === "needs_work" && overlap.length > 0) {
      nextRepeat = task.repeat_count + 1;
    } else if (result.verdict === "needs_work" && overlap.length === 0) {
      nextRepeat = 0;
    }

    const maxRetries = config.maxReviewRetries;
    const blockedRepeat =
      result.verdict === "needs_work" && nextRepeat >= 2;
    const blockedAfterMax =
      result.verdict === "needs_work" &&
      task.retries >= maxRetries &&
      !blockedRepeat;

    const commentBody = formatReviewComment(result, {
      blockedAfterMax,
      blockedRepeat,
    });
    await github.postPRComment(prNumber, commentBody);
    taskLog(task.id, `review posted to PR #${prNumber}`);

    if (result.verdict === "pass") {
      taskLog(
        task.id,
        `review: pass — ${result.summary} (marking PR ready for humans)`
      );
      await github.markPRReady(prNumber);
      updateTask(task.id, {
        status: "done",
        latest_review_json: latestJson,
        review_issue_hashes: serializeIssueHashList([]),
        repeat_count: 0,
        blocked_reason: null,
        failure_reason: null,
        review_feedback: null,
      });
      taskLog(task.id, "review → done (PR ready for review)");
      return;
    }

    taskLog(
      task.id,
      `review: needs_work — ${result.summary} (issues: ${result.structuredIssues.length})`
    );

    const feedbackLines = [
      result.summary,
      ...result.structuredIssues.map(
        (i) => `- ${i.file}: ${i.instruction}`
      ),
    ].join("\n");

    if (blockedRepeat) {
      taskLog(
        task.id,
        "review: repeated issue fingerprints — marking blocked"
      );
      updateTask(task.id, {
        status: "blocked",
        blocked_reason: "repeat_detection",
        latest_review_json: latestJson,
        review_issue_hashes: serializeIssueHashList(currFingerprints),
        repeat_count: nextRepeat,
        review_feedback: feedbackLines,
      });
      taskLog(task.id, "review → blocked (repeat detection)");
      return;
    }

    if (blockedAfterMax) {
      taskLog(
        task.id,
        "review: needs_work but max retries reached — marking blocked"
      );
      updateTask(task.id, {
        status: "blocked",
        blocked_reason: "max_review_retries",
        latest_review_json: latestJson,
        review_issue_hashes: serializeIssueHashList(currFingerprints),
        repeat_count: nextRepeat,
        review_feedback: feedbackLines,
      });
      taskLog(task.id, "review → blocked");
      return;
    }

    const nextRetries = task.retries + 1;
    updateTask(task.id, {
      status: "fixing",
      blocked_reason: null,
      retries: nextRetries,
      review_feedback: feedbackLines,
      latest_review_json: latestJson,
      review_issue_hashes: serializeIssueHashList(currFingerprints),
      repeat_count: nextRepeat,
    });
    taskLog(
      task.id,
      `review: needs_work (retry ${nextRetries}/${maxRetries}) — review → fixing`
    );
  } finally {
    reviewLocks.delete(task.id);
  }
}
