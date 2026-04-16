export function taskLog(taskId: string, message: string): void {
  console.log(`[TASK ${taskId}] ${message}`);
}
