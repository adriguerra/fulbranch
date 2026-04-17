import * as github from "../services/github.js";
import { mergeReviewFeedbackForImplementer } from "./feedback.js";
import { generateImplementation } from "../services/llm.js";
import { getTaskById, updateTask } from "../db/db.js";
import type { Task } from "../types.js";
import { config } from "../config.js";
import { taskLog } from "../logger.js";

/** Prevents overlapping implementer runs (webhooks + orchestrator). */
const implementerLocks = new Set<string>();

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function branchNameForNewTask(task: Task): string {
  const slug = slugify(task.title) || "task";
  const raw = `ful-${task.id}-${slug}`;
  return raw.length > 200 ? raw.slice(0, 200) : raw;
}

export async function runImplementer(task: Task): Promise<void> {
  if (implementerLocks.has(task.id)) {
    taskLog(task.id, "implementer skipped: already in progress");
    return;
  }

  implementerLocks.add(task.id);
  try {
    await runImplementerLocked(task);
  } finally {
    implementerLocks.delete(task.id);
  }
}

async function runImplementerLocked(task: Task): Promise<void> {
  const paths = config.contextPaths();
  let branch = task.branch_name;

  if (!branch) {
    branch = branchNameForNewTask(task);
    taskLog(task.id, `creating branch: ${branch}`);
    await github.createBranch(branch);
    updateTask(task.id, { branch_name: branch });
    taskLog(task.id, `branch created: ${branch}`);
  } else {
    taskLog(task.id, `using existing branch: ${branch}`);
  }

  const fileContents = await github.getFileContents(paths);
  taskLog(task.id, `fetched ${fileContents.length} context file(s) for LLM`);

  let githubDiscussion = "";
  if (task.pr_number != null) {
    taskLog(task.id, `fetching GitHub PR #${task.pr_number} review thread for context`);
    githubDiscussion = await github.fetchAggregatedReviewFeedback(task.pr_number);
    if (githubDiscussion) {
      taskLog(
        task.id,
        `GitHub discussion: ${githubDiscussion.length} chars for implementer prompt`
      );
    }
  }

  const fresh = getTaskById(task.id);
  const reviewFromDb = fresh?.review_feedback ?? task.review_feedback;
  const mergedFeedback = mergeReviewFeedbackForImplementer(
    reviewFromDb,
    githubDiscussion
  );

  const changes = await generateImplementation(
    {
      ...task,
      branch_name: branch,
      review_feedback: mergedFeedback,
    },
    fileContents
  );

  const message = `feat: ${task.title} [ful-${task.id}]`;
  await github.applyFileChanges(branch, changes, message);

  let prUrl = task.pr_url;
  let prNumber = task.pr_number;

  if (task.pr_number == null) {
    const title = `${task.title} [ful-${task.id}]`;
    const body = `Automated PR for Linear issue \`${task.id}\`.\n\n${task.description || ""}`;
    taskLog(task.id, "opening draft PR");
    const pr = await github.createDraftPR(branch, title, body);
    prUrl = pr.url;
    prNumber = pr.number;
    taskLog(task.id, `PR opened: ${prUrl}`);
  } else {
    taskLog(task.id, `commits pushed to existing PR #${task.pr_number}`);
  }

  updateTask(task.id, {
    status: "review",
    branch_name: branch,
    pr_url: prUrl,
    pr_number: prNumber,
    review_feedback: null,
  });
  taskLog(task.id, "in_progress → review");
}
