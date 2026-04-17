import * as github from "../services/github.js";
import { mergeReviewFeedbackForImplementer } from "./feedback.js";
import { generateImplementation } from "../services/llm.js";
import { getTaskById, updateTask } from "../db/db.js";
import type { Task } from "../types.js";
import { parseLatestReviewJson } from "../review/structured.js";
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
  const base = getTaskById(task.id) ?? task;
  const paths = config.contextPaths();
  let branch = base.branch_name;

  if (!branch) {
    branch = branchNameForNewTask(base);
    taskLog(base.id, `creating branch: ${branch}`);
    await github.createBranch(branch);
    updateTask(base.id, { branch_name: branch });
    taskLog(base.id, `branch created: ${branch}`);
  } else {
    taskLog(base.id, `using existing branch: ${branch}`);
  }

  const fileContents = await github.getFileContents(paths);
  taskLog(base.id, `fetched ${fileContents.length} context file(s) for LLM`);

  let githubDiscussion = "";
  if (base.pr_number != null) {
    taskLog(
      base.id,
      `fetching GitHub PR #${base.pr_number} review thread for context`
    );
    githubDiscussion = await github.fetchAggregatedReviewFeedback(
      base.pr_number
    );
    if (githubDiscussion) {
      taskLog(
        base.id,
        `GitHub discussion: ${githubDiscussion.length} chars`
      );
    }
  }

  const stored = parseLatestReviewJson(base.latest_review_json);
  const structuredActive =
    stored?.status === "needs_work" && stored.issues.length > 0;

  let changes;
  if (structuredActive) {
    taskLog(
      base.id,
      "implementer: structured review issues (primary); GitHub thread supplementary"
    );
    changes = await generateImplementation(
      { ...base, branch_name: branch },
      fileContents,
      githubDiscussion.trim()
        ? { githubSupplement: githubDiscussion }
        : undefined
    );
  } else {
    const mergedFeedback = mergeReviewFeedbackForImplementer(
      base.review_feedback,
      githubDiscussion
    );
    changes = await generateImplementation(
      {
        ...base,
        branch_name: branch,
        review_feedback: mergedFeedback,
      },
      fileContents
    );
  }

  const message = `feat: ${base.title} [ful-${base.id}]`;
  await github.applyFileChanges(branch, changes, message);

  let prUrl = base.pr_url;
  let prNumber = base.pr_number;

  if (base.pr_number == null) {
    const title = `${base.title} [ful-${base.id}]`;
    const body = `Automated PR for Linear issue \`${base.id}\`.\n\n${base.description || ""}`;
    taskLog(base.id, "opening draft PR");
    const pr = await github.createDraftPR(branch, title, body);
    prUrl = pr.url;
    prNumber = pr.number;
    taskLog(base.id, `PR opened: ${prUrl}`);
  } else {
    taskLog(base.id, `commits pushed to existing PR #${base.pr_number}`);
  }

  updateTask(base.id, {
    status: "review",
    branch_name: branch,
    pr_url: prUrl,
    pr_number: prNumber,
    review_feedback: null,
  });
  taskLog(base.id, "implementer → review");
}
