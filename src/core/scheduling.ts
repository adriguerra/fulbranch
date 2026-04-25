import type { Task } from "../types.js";

function normalizePath(input: string): string {
  return input.trim().replaceAll("\\", "/").replaceAll(/\/+/g, "/");
}

function hasFileConflict(a: Task, b: Task): boolean {
  if (a.allow_parallel && b.allow_parallel) {
    return false;
  }
  const left = new Set(a.owned_files.map(normalizePath));
  return b.owned_files.map(normalizePath).some((p) => left.has(p));
}

export function resolveTaskState(task: Task, byId: Map<string, Task>): {
  status: Task["status"];
  blockedReason: string | null;
} {
  if (task.status !== "pending") {
    return { status: task.status, blockedReason: task.blocked_reason };
  }
  for (const depId of task.depends_on) {
    const dep = byId.get(depId);
    if (!dep) {
      return { status: "blocked", blockedReason: `dependency_missing:${depId}` };
    }
    if (dep.status === "failed") {
      return { status: "blocked", blockedReason: `dependency_failed:${depId}` };
    }
    if (dep.status === "blocked") {
      return { status: "blocked", blockedReason: `dependency_blocked:${depId}` };
    }
    if (dep.status === "skipped") {
      return { status: "skipped", blockedReason: `dependency_skipped:${depId}` };
    }
  }
  return { status: "pending", blockedReason: null };
}

export function pickReadyTasks(
  pendingTasks: Task[],
  allTasks: Task[],
  maxToPick: number
): { ready: Task[]; blocked: Array<{ task: Task; reason: string }> } {
  const running = allTasks.filter((t) =>
    ["running", "in_progress", "fixing", "review"].includes(t.status)
  );
  const byId = new Map(allTasks.map((t) => [t.id, t]));
  const ready: Task[] = [];
  const blocked: Array<{ task: Task; reason: string }> = [];

  for (const task of pendingTasks) {
    const depState = resolveTaskState(task, byId);
    if (depState.status === "blocked" || depState.status === "skipped") {
      blocked.push({ task, reason: depState.blockedReason ?? "dependency" });
      continue;
    }
    const waiting = task.depends_on.some((depId) => byId.get(depId)?.status !== "done");
    if (waiting) {
      blocked.push({ task, reason: "waiting_on_dependency" });
      continue;
    }
    const conflictsActive = running.find((active) => hasFileConflict(task, active));
    if (conflictsActive) {
      blocked.push({ task, reason: `file_conflict:${conflictsActive.id}` });
      continue;
    }
    const conflictsPicked = ready.find((picked) => hasFileConflict(task, picked));
    if (conflictsPicked) {
      blocked.push({ task, reason: `file_conflict:${conflictsPicked.id}` });
      continue;
    }
    ready.push(task);
    if (ready.length >= maxToPick) {
      break;
    }
  }

  return { ready, blocked };
}
