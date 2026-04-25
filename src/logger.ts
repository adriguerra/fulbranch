import { getTaskById, appendTaskEvent } from "./db/db.js";

export function taskLog(taskId: string, message: string): void {
  console.log(`[TASK ${taskId}] ${message}`);
  const task = getTaskById(taskId);
  appendTaskEvent(taskId, task?.run_id ?? null, message);
}
