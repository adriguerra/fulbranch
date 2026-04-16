import * as github from "../services/github.js";
import { generateImplementation } from "../services/llm.js";
import { updateTask } from "../db/db.js";
import type { Task } from "../types.js";
import { config } from "../config.js";
import { taskLog } from "../logger.js";

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

  const changes = await generateImplementation(
    { ...task, branch_name: branch },
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
