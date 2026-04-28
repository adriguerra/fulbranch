/**
 * Shared "PR merged" application logic.
 *
 * A merge can be observed two ways:
 *   1. POST /webhook/github (primary path — fast)
 *   2. github reconcile loop polling /repos/:owner/:repo/pulls?state=closed
 *      (safety net — catches missed webhook deliveries, e.g. tunnel down)
 *
 * Both paths must produce identical side effects:
 *   - DB:    markMerged(issueId), append `pr_merged` event
 *   - Graph: compute newly-unblocked dependents, append `dependent_unblocked`
 *            events for each
 *   - Linear: transition issue → Done
 *   - Slack: notifyDependentsUnblocked(prUrl, unblocked)
 *
 * Dispatch is intentionally NOT triggered here; the caller decides when
 * (the webhook fires it immediately, the reconcile loop fires it once at
 * the end of its tick after both reconcilers complete).
 */

import { markMerged, listByStatus } from "@/db/repositories/issues";
import { appendEvent } from "@/db/repositories/events";
import { onMerged } from "@/integrations/linear/statusSync";
import { notifyDependentsUnblocked } from "@/integrations/slack/notifier";
import type { NotifyTarget } from "@/integrations/slack/notifier";
import { logger } from "@/utils/logger";
import type { Issue } from "@/types/pipeline";

const log = logger.child({ component: "github_merge" });

export interface ApplyMergedPrInput {
  issue: Issue;
  prNumber: number;
  prUrl: string;
  mergedAt: string | null;
  source: "webhook" | "reconcile" | "auto_merge";
}

export interface ApplyMergedPrResult {
  unblocked: string[];
  alreadyMerged: boolean;
}

/**
 * Apply the side effects of a merged PR.
 *
 * Idempotent: if the issue is already marked merged in SQLite this is a
 * no-op (returns alreadyMerged=true with empty unblocked). The caller does
 * not need to pre-check.
 */
export async function applyMergedPr(
  input: ApplyMergedPrInput,
): Promise<ApplyMergedPrResult> {
  const { issue, prNumber, prUrl, mergedAt, source } = input;

  if (issue.status === "merged") {
    return { unblocked: [], alreadyMerged: true };
  }

  markMerged(issue.id);
  appendEvent({
    issueId: issue.id,
    eventType: "pr_merged",
    detail:
      source === "reconcile"
        ? `reconcile: prNumber=${prNumber} merged_at=${mergedAt ?? "unknown"}`
        : `prNumber=${prNumber} merged_at=${mergedAt ?? "unknown"}`,
  });

  // Compute downstream tickets that became dispatchable.
  const pending = listByStatus("pending");
  const unblocked = pending.filter((p) => p.dependsOn.includes(issue.id)).map((p) => p.id);

  for (const unblockedId of unblocked) {
    appendEvent({
      issueId: unblockedId,
      eventType: "dependent_unblocked",
      detail: `parent=${issue.id} pr=${prNumber} source=${source}`,
    });
  }

  log.info("merge processed", {
    issueId: issue.id,
    prNumber,
    unblocked,
    source,
  });

  // Linear + Slack are best-effort; a failure here must not roll back the DB
  // transitions above.
  if (issue.linearUuid) {
    onMerged(issue.linearUuid, unblocked).catch((err) =>
      log.warn("linear onMerged failed", { issueId: issue.id, error: String(err) }),
    );
  } else {
    log.warn("merge: no linearUuid, skipping Linear status sync", { issueId: issue.id });
  }

  const target: NotifyTarget = { id: issue.id, title: issue.title, linearUrl: issue.linearUrl };
  notifyDependentsUnblocked(target, prUrl, unblocked).catch((err) =>
    log.warn("slack unblock notify failed", { issueId: issue.id, error: String(err) }),
  );

  return { unblocked, alreadyMerged: false };
}
