/**
 * Reconciliation loop.
 *
 * Every RECONCILE_INTERVAL_MS (default 5 minutes):
 *   1. Linear reconcile — list orchestrator-managed issues, ingest any the
 *      orchestrator hasn't seen, log anomalies.
 *   2. GitHub reconcile — scan recent closed PRs, mark any merged PRs whose
 *      SQLite row is still `pr_open` as merged (covers missed merge
 *      webhooks).
 *   3. Trigger a dispatch cycle.
 *
 * Rate-limit safe: Linear allows 1500 req/hour; 12 calls/hour from here
 * (every 5 min) is well within limits. GitHub has 5000 req/hour for PATs.
 */

import { config } from "@/config";
import { logger } from "@/utils/logger";
import { reconcileLinear } from "@/integrations/linear/reconcile";
import { reconcileGitHub } from "@/integrations/github/reconcile";
import { dispatch } from "@/orchestrator/dispatcher";

const log = logger.child({ component: "reconcile_loop" });

let timer: ReturnType<typeof setInterval> | null = null;

export function startReconciliationLoop(): void {
  if (timer) return;
  const interval = config().reconcileIntervalMs;

  timer = setInterval(() => {
    runOnce().catch((err) => {
      log.error("reconcile error", {
        error: err instanceof Error ? err.stack : String(err),
      });
    });
  }, interval);

  log.info("reconcile loop started", { intervalMs: interval });
}

export function stopReconciliationLoop(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export async function runOnce(): Promise<void> {
  log.debug("reconcile tick");
  const [linearRes, githubRes] = await Promise.allSettled([
    reconcileLinear(),
    reconcileGitHub(),
  ]);

  if (linearRes.status === "rejected") {
    log.warn("linear reconcile failed", {
      error: linearRes.reason instanceof Error
        ? linearRes.reason.message
        : String(linearRes.reason),
    });
  }
  if (githubRes.status === "rejected") {
    log.warn("github reconcile failed", {
      error: githubRes.reason instanceof Error
        ? githubRes.reason.message
        : String(githubRes.reason),
    });
  }

  // Even partial success is worth a dispatch — new tickets may be ingestable.
  await dispatch("reconcile");
}
