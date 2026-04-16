import * as github from "../services/github.js";
import { reviewCode } from "../services/llm.js";
import { updateTask } from "../db/db.js";
import type { Task } from "../types.js";
import { taskLog } from "../logger.js";

export async function runReviewer(task: Task): Promise<void> {
  if (task.pr_number == null) {
    throw new Error(`Task ${task.id} has no pr_number`);
  }

  const diff = await github.getPRDiff(task.pr_number);
  const result = await reviewCode(diff);

  if (result.verdict === "pass") {
    taskLog(
      task.id,
      `review: pass — ${result.summary} (marking PR ready for humans)`
    );
    await github.markPRReady(task.pr_number);
    updateTask(task.id, { status: "done" });
    taskLog(task.id, "review → done (PR ready for review)");
    return;
  }

  taskLog(
    task.id,
    `review: needs_work — ${result.summary} (issues: ${result.issues.length})`
  );

  if (task.retries < 2) {
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
    taskLog(task.id, `review: needs_work (retry ${nextRetries}/2) — review → in_progress`);
    return;
  }

  taskLog(
    task.id,
    "review: needs_work but max retries reached — marking blocked"
  );
  updateTask(task.id, { status: "blocked" });
  taskLog(task.id, "review → blocked");
}
