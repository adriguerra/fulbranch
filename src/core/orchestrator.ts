import { runImplementer } from "../agents/implementer.js";
import { runReviewer } from "../agents/reviewer.js";
import {
  getAllTasks,
  countOpenPRs,
  getReadyPendingTasks,
  getTasksAwaitingRetryImplementation,
  getTasksInReview,
  markInProgress,
  updateTask,
} from "./queue.js";
import { handleAgentError } from "./worker.js";
import { config } from "../config.js";
import { taskLog } from "../logger.js";
import { pickReadyTasks, resolveTaskState } from "./scheduling.js";

const INTERVAL_MS = 10_000;

/** Prevents concurrent ticks when a run exceeds INTERVAL_MS (setInterval does not await). */
let isRunning = false;

export function startOrchestrator(): NodeJS.Timeout {
  const tick = async (): Promise<void> => {
    if (isRunning) {
      console.warn(
        "[orchestrator] tick skipped: previous tick still in progress"
      );
      return;
    }
    isRunning = true;
    try {
      const retryTasks = getTasksAwaitingRetryImplementation();
      for (const task of retryTasks) {
        try {
          await runImplementer(task);
        } catch (err) {
          handleAgentError(task, err);
        }
      }

      const max = config.maxOpenPrs;
      const available = Math.max(0, max - countOpenPRs());
      if (available > 0) {
        const allTasks = getAllTasks();
        const pending = getReadyPendingTasks(100);
        const byId = new Map(allTasks.map((t) => [t.id, t]));

        for (const task of pending) {
          const depState = resolveTaskState(task, byId);
          if (depState.status === "blocked" || depState.status === "skipped") {
            updateTask(task.id, {
              status: depState.status,
              blocked_reason: depState.blockedReason,
            });
            taskLog(task.id, `pending → ${depState.status} (${depState.blockedReason})`);
          }
        }

        const { ready, blocked } = pickReadyTasks(pending, allTasks, available);
        for (const b of blocked) {
          updateTask(b.task.id, { blocked_reason: b.reason });
        }
        for (const next of ready) {
          taskLog(next.id, "pending → running");
          markInProgress(next.id);
          try {
            await runImplementer({ ...next, status: "running", blocked_reason: null });
          } catch (err) {
            handleAgentError(next, err);
          }
        }
      }

      const reviewTasks = getTasksInReview();
      for (const task of reviewTasks) {
        try {
          await runReviewer(task);
        } catch (err) {
          handleAgentError(task, err);
        }
      }
    } catch (err) {
      console.error("[orchestrator] tick failed:", err);
    } finally {
      isRunning = false;
    }
  };

  void tick();
  return setInterval(() => {
    void tick();
  }, INTERVAL_MS);
}
