import { runImplementer } from "../agents/implementer.js";
import { runReviewer } from "../agents/reviewer.js";
import {
  countOpenPRs,
  getNextPendingTask,
  getTasksAwaitingRetryImplementation,
  getTasksInReview,
  markInProgress,
} from "./queue.js";
import { handleAgentError } from "./worker.js";
import { config } from "../config.js";
import { taskLog } from "../logger.js";

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
      if (countOpenPRs() < max) {
        const next = getNextPendingTask();
        if (next) {
          taskLog(next.id, "pending → in_progress");
          markInProgress(next.id);
          try {
            await runImplementer({ ...next, status: "in_progress" });
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
