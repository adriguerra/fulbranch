import type { Task } from "../types.js";
import {
  getTaskEventsByRunId,
  getTasksByRunId,
  insertTasksFromSpec,
} from "../db/db.js";
import { planSpec, parseSpecFile } from "../spec/parse.js";

function summarizeStatuses(tasks: Task[]): Record<string, number> {
  return tasks.reduce<Record<string, number>>((acc, task) => {
    acc[task.status] = (acc[task.status] ?? 0) + 1;
    return acc;
  }, {});
}

export function cliPlanSpec(specPath: string): void {
  const { spec } = parseSpecFile(specPath);
  const planned = planSpec(spec);
  console.log(`Execution plan for ${specPath}`);
  for (const [idx, taskId] of planned.order.entries()) {
    console.log(`${idx + 1}. ${taskId}`);
  }
  if (planned.conflicts.length > 0) {
    console.log("\nPotential file conflicts:");
    for (const c of planned.conflicts) {
      console.log(
        `- ${c.left} <-> ${c.right} on: ${c.shared.join(", ")}`
      );
    }
  } else {
    console.log("\nNo file ownership conflicts detected.");
  }
}

export function cliRunSpec(
  specPath: string,
  runMode: "resume" | "new-run" = "resume"
): void {
  const { spec, raw } = parseSpecFile(specPath);
  const result = insertTasksFromSpec(spec, raw, { runMode });
  console.log(`Run id: ${result.runId}`);
  console.log(`Inserted tasks: ${result.insertedTaskIds.length}`);
  if (result.insertedTaskIds.length > 0) {
    console.log(`- ${result.insertedTaskIds.join(", ")}`);
  }
  if (result.reusedTaskIds.length > 0) {
    console.log(`Reused (resume): ${result.reusedTaskIds.join(", ")}`);
  }
}

export function cliStatus(runId: string): void {
  const tasks = getTasksByRunId(runId);
  if (tasks.length === 0) {
    console.log(`No tasks found for run ${runId}`);
    return;
  }
  const counts = summarizeStatuses(tasks);
  console.log(`Run ${runId}`);
  console.log("Status counts:");
  for (const [status, count] of Object.entries(counts)) {
    console.log(`- ${status}: ${count}`);
  }

  const blocked = tasks.filter((t) => t.status === "blocked");
  if (blocked.length > 0) {
    console.log("\nBlocked tasks:");
    for (const task of blocked) {
      console.log(`- ${task.id}: ${task.blocked_reason ?? "no reason"}`);
    }
  }

  const mergeEligible = tasks.filter(
    (task) =>
      task.status === "done" &&
      tasks.every(
        (other) =>
          !other.depends_on.includes(task.id) ||
          other.status === "done" ||
          other.status === "skipped" ||
          other.status === "blocked" ||
          other.status === "failed"
      )
  );
  console.log(`\nMerge-eligible tasks: ${mergeEligible.length}`);
  for (const task of mergeEligible) {
    console.log(`- ${task.id} (${task.pr_url ?? "no pr"})`);
  }
}

export function cliLogs(runId: string): void {
  const events = getTaskEventsByRunId(runId);
  if (events.length === 0) {
    console.log(`No logs found for run ${runId}`);
    return;
  }
  for (const event of events) {
    console.log(
      `${event.created_at.toISOString()} [${event.task_id}] ${event.message}`
    );
  }
}
