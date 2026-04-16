import type { Task } from "../types.js";
import { updateTask } from "../db/db.js";
import { taskLog } from "../logger.js";

export function handleAgentError(task: Task, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  taskLog(task.id, `error: ${msg}`);
  updateTask(task.id, { status: "blocked" });
  taskLog(task.id, "→ blocked (unrecoverable error)");
}
