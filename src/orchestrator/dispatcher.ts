/**
 * Dispatch engine.
 *
 * Single entry point: dispatch(trigger). Called from:
 *   - webhook handlers (Linear create/update, GitHub merge)
 *   - reconciliation loop
 *   - recovery sweep
 *   - post-pipeline completion
 *
 * Algorithm:
 *   1. Load all known issues from SQLite.
 *   2. Topological sort. On cycle detection: mark every cycle member failed,
 *      emit cycle_detected event, alert Slack.
 *   3. Filter: remove issues whose depends_on are not all `status=merged`.
 *   4. Filter: remove issues already running / reviewing / pr_open / merged / failed.
 *   5. Cross-run priority: issues that belong to already-in-flight runs are
 *      preferred. In v1 we have no explicit run grouping, so we approximate
 *      this by preferring tickets whose dependencies exist in SQLite (they
 *      are part of an ongoing multi-ticket spec) over truly standalone ones.
 *   6. Spawn up to min(ready.length, availableSlots()) pipelines.
 *
 * Concurrency-safe: dispatch() serializes itself behind a module-level mutex
 * so overlapping webhook events don't double-spawn the same pipeline.
 */

import {
  listAll,
  markFailed,
  nextScheduledRetryMs,
} from "@/db/repositories/issues";
import { appendEvent } from "@/db/repositories/events";
import { topoSort, type DepNode } from "./topoSort";
import { acquire, availableSlots, release } from "./semaphore";
import { logger } from "@/utils/logger";
import type { Issue } from "@/types/pipeline";
import { runPipeline } from "@/pipeline/runPipeline";
import { notifyCycleDetected } from "@/integrations/slack/notifier";

const log = logger.child({ component: "dispatcher" });

let dispatchInFlight: Promise<void> = Promise.resolve();

/**
 * A single rolling wakeup timer that fires when the soonest-scheduled
 * retry (`next_retry_at`) elapses. We always cancel and re-arm after a dispatch
 * pass, so the timer never drifts more than one dispatch cycle off.
 */
let retryWakeupTimer: ReturnType<typeof setTimeout> | null = null;
const MAX_WAKEUP_MS = 60 * 60 * 1000; // cap at 1h; reconcile loop covers anything beyond.

/**
 * Serialized dispatch entry point. Multiple callers get chained — no overlap.
 */
export async function dispatch(trigger: string): Promise<void> {
  const previous = dispatchInFlight;
  dispatchInFlight = previous.then(() => dispatchOnce(trigger).catch((err) => {
    log.error("dispatch error", {
      trigger,
      error: err instanceof Error ? err.stack : String(err),
    });
  }));
  return dispatchInFlight;
}

async function dispatchOnce(trigger: string): Promise<void> {
  log.debug("dispatch start", { trigger });

  const all = listAll();
  if (all.length === 0) {
    rescheduleRetryWakeup();
    return;
  }

  const nodes: DepNode[] = all.map((i) => ({ id: i.id, dependsOn: i.dependsOn }));
  const sorted = topoSort(nodes);

  if (!sorted.ok) {
    await handleCycle(all, sorted.error.cycle, sorted.error.unresolved);
    if (sorted.error.cycle.length > 0) {
      // True circular dependency — abort entirely; human must fix the spec.
      rescheduleRetryWakeup();
      return;
    }
    // Unresolved external deps (missing nodes not yet ingested): continue
    // dispatching using the partial sorted list so independent tickets are
    // not frozen while waiting for a blocker to arrive.
  }

  const mergedIds = new Set(all.filter((i) => i.status === "merged").map((i) => i.id));
  const byId = new Map(all.map((i) => [i.id, i] as const));

  const terminalOrBusy = new Set<Issue["status"]>([
    "paused",
    "running",
    "reviewing",
    "pr_open",
    "merged",
    "failed",
  ]);

  const now = Date.now();
  const ready: Issue[] = [];
  for (const node of sorted.ordered) {
    const issue = byId.get(node.id)!;
    if (terminalOrBusy.has(issue.status)) continue;

    // retry are skipped here; the wakeup timer or the reconcile tick will
    // bring them around when the time comes.
    if (issue.nextRetryAt) {
      const due = Date.parse(issue.nextRetryAt);
      if (Number.isFinite(due) && due > now) {
        continue;
      }
    }

    const allDepsMerged = issue.dependsOn.every((d) => mergedIds.has(d));
    if (!allDepsMerged) {
      appendEvent({
        issueId: issue.id,
        eventType: "dispatch_skipped_blocked",
        detail: `waiting on: ${issue.dependsOn.filter((d) => !mergedIds.has(d)).join(",")}`,
      });
      continue;
    }
    ready.push(issue);
  }

  // Cross-run priority: tickets with dependencies (part of
  // a larger in-flight spec) beat standalone tickets. Stable sort preserves
  // the underlying topo order within each bucket.
  ready.sort((a, b) => {
    const aHasDeps = a.dependsOn.length > 0 ? 0 : 1;
    const bHasDeps = b.dependsOn.length > 0 ? 0 : 1;
    return aHasDeps - bHasDeps;
  });

  const toDispatch = ready.slice(0, availableSlots());
  log.info("dispatch computed", {
    trigger,
    total: all.length,
    ready: ready.length,
    available: availableSlots(),
    dispatching: toDispatch.length,
  });

  for (const issue of toDispatch) {
    if (!acquire()) break;
    // Fire-and-forget: pipeline is async and manages its own lifecycle.
    // Any exit reason releases the semaphore and may kick another dispatch.
    queueMicrotask(() => {
      runPipeline(issue)
        .catch((err) => {
          log.error("pipeline error", {
            issueId: issue.id,
            error: err instanceof Error ? err.stack : String(err),
          });
        })
        .finally(() => {
          release();
          // A completed pipeline may have just merged a dep or opened a PR —
          // re-run dispatch so any newly-unblocked tickets get picked up.
          dispatch("pipeline_complete").catch(() => {});
        });
    });
  }

  // earliest next_retry_at across pending issues.
  rescheduleRetryWakeup();
}

/**
 * Re-arm the wakeup timer to fire on the soonest scheduled retry.
 * Cancels any prior timer; a no-op if nothing is scheduled.
 */
function rescheduleRetryWakeup(): void {
  if (retryWakeupTimer) {
    clearTimeout(retryWakeupTimer);
    retryWakeupTimer = null;
  }
  const nextMs = nextScheduledRetryMs();
  if (nextMs == null) return;

  const delay = Math.min(MAX_WAKEUP_MS, Math.max(0, nextMs - Date.now()));
  log.info("retry wakeup armed", {
    delayMs: delay,
    fireAt: new Date(Date.now() + delay).toISOString(),
  });
  retryWakeupTimer = setTimeout(() => {
    retryWakeupTimer = null;
    dispatch("retry_wakeup").catch((err) => {
      log.error("retry wakeup dispatch error", {
        error: err instanceof Error ? err.stack : String(err),
      });
    });
  }, delay);
  // Don't keep the event loop alive solely for this timer.
  if (typeof retryWakeupTimer === "object" && retryWakeupTimer && "unref" in retryWakeupTimer) {
    (retryWakeupTimer as { unref: () => void }).unref();
  }
}

async function handleCycle(
  all: Issue[],
  cycle: string[],
  unresolved: string[],
): Promise<void> {
  // Distinguish: a true cycle has cycle.length > 0. An empty cycle with
  // unresolved nodes means their dependencies reference IDs the orchestrator
  // hasn't ingested yet — NOT an error, just wait for the missing webhook.
  if (cycle.length === 0) {
    log.debug("unresolved dependencies (missing nodes)", { unresolved });
    return;
  }

  const reason = `Circular dependency: ${cycle.join(" -> ")}`;
  log.error("cycle detected", { cycle });

  // Only fail issues that belong to the cycle itself, not every unresolved
  // node (some may simply be transitively blocked by the cycle).
  const cycleSet = new Set(cycle);
  for (const id of cycleSet) {
    const issue = all.find((i) => i.id === id);
    if (!issue) continue;
    if (issue.status === "failed") continue;
    markFailed(id, reason);
    appendEvent({ issueId: id, eventType: "cycle_detected", detail: reason });
  }

  try {
    await notifyCycleDetected(cycle);
  } catch (err) {
    log.warn("slack cycle notify failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
