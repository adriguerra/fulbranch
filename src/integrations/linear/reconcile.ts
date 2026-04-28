/**
 * Linear reconciliation.
 *
 * Called by the reconciliation loop every RECONCILE_INTERVAL_MS.
 *
 * Responsibilities:
 *   1. List all issues in Linear with the `orchestrator-managed` label.
 *   2. Diff against SQLite; anything in Linear but absent in SQLite is
 *      treated as a missed webhook and ingested.
 *   3. Log and notify on anomalies (issue marked `running` in SQLite but
 *      closed externally in Linear).
 *   4. Retry gate: if an issue is `failed` in SQLite but back at a
 *      "backlog" state (type=`backlog` or name="Todo") in Linear, reset it
 *      to `pending` so the dispatcher will re-pick it up. This lets developers
 *      trigger a retry simply by moving the card back to Todo in Linear.
 */

import { listIssuesByLabel, extractBlockedBy } from "./client";
import { getIssue, upsertIssue, updateStatus } from "@/db/repositories/issues";
import { appendEvent } from "@/db/repositories/events";
import { logger } from "@/utils/logger";
import {
  ORCHESTRATOR_MANAGED_LABEL,
  LINEAR_ACTIVE_STATES,
  LINEAR_STATE_TODO,
  LINEAR_STATE_DONE,
} from "@/server/webhooks/linear";
import type { IssueStatus } from "@/types/pipeline";

const log = logger.child({ component: "linear_reconcile" });

export interface LinearReconcileResult {
  ingested: string[];
  anomalies: string[];
  retried: string[];
}

export async function reconcileLinear(): Promise<LinearReconcileResult> {
  const issues = await listIssuesByLabel(ORCHESTRATOR_MANAGED_LABEL);
  const ingested: string[] = [];
  const anomalies: string[] = [];
  const retried: string[] = [];

  for (const issue of issues) {
    const isActive = LINEAR_ACTIVE_STATES.has(issue.state?.name ?? "");

    const existing = getIssue(issue.identifier);
    if (!existing) {
      if (!isActive) continue;
      const deps = extractBlockedBy(issue);
      upsertIssue({
        id: issue.identifier,
        linearUuid: issue.id,
        linearUrl: issue.url ?? null,
        title: issue.title,
        description: issue.description ?? "",
        dependsOn: deps,
      });
      appendEvent({
        issueId: issue.identifier,
        eventType: "webhook_received",
        detail: "reconcile: missed webhook recovered",
      });
      ingested.push(issue.identifier);
      continue;
    }

    // Resume gate: paused or failed in SQLite + now in an active Linear state
    // → developer has moved the card back into the flow.
    //   - paused  → any active state re-arms it (they finished setting it up)
    //   - failed  → only "Todo" re-arms it (explicit developer retry signal)
    const resumableStatuses: IssueStatus[] = ["paused", "failed"];
    if (resumableStatuses.includes(existing.status) && isActive) {
      const isPausedResume = existing.status === "paused";
      const isFailedRetry = existing.status === "failed" && issue.state?.name === LINEAR_STATE_TODO;
      if (isPausedResume || isFailedRetry) {
        updateStatus(issue.identifier, "pending");
        appendEvent({
          issueId: issue.identifier,
          eventType: "webhook_received",
          detail: `reconcile: ${isPausedResume ? "resumed from Backlog" : "retry triggered via Linear Todo"}`,
        });
        retried.push(issue.identifier);
        log.info(isPausedResume ? "paused issue resumed" : "failed issue reset to pending", {
          issueId: issue.identifier,
          previousStatus: existing.status,
          linearState: issue.state?.name,
        });
        continue;
      }
    }

    // Anomaly detection: externally completed/cancelled but SQLite shows active.
    const externallyDone = issue.state?.name === LINEAR_STATE_DONE;
    if (externallyDone && existing.status !== "merged" && existing.status !== "failed") {
      anomalies.push(issue.identifier);
    }
  }

  log.info("linear reconcile done", {
    linearCount: issues.length,
    ingested: ingested.length,
    retried: retried.length,
    anomalies: anomalies.length,
  });
  return { ingested, anomalies, retried };
}
