/**
 * GitHub merge-webhook reconciliation.
 *
 * The primary trigger for marking a ticket merged is the
 * POST /webhook/github event. This reconciler is a safety net: on every
 * reconciliation cycle we fetch the most recent closed PRs and match any
 * merged ones against SQLite rows still marked `pr_open`.
 *
 * Critically, the side effects of "PR merged" are NOT reimplemented here.
 * They live in `applyMergedPr()` and are shared with the webhook handler,
 * so a recovery via this reconciler produces identical end state:
 * Linear → Done, Slack notify, dependent_unblocked events fire.
 *
 * Up to v0.5 this file only did `markMerged` + `appendEvent` and skipped
 * the Linear/Slack side effects, which left tickets stuck in "In Review"
 * forever when the merge webhook was missed (e.g. tunnel down).
 */

import { listRecentClosedPulls } from "./client";
import { getByPrNumber } from "@/db/repositories/issues";
import { applyMergedPr } from "./merge";
import { logger } from "@/utils/logger";

const log = logger.child({ component: "github_reconcile" });

export interface GitHubReconcileResult {
  reconciledIds: string[];
}

export async function reconcileGitHub(): Promise<GitHubReconcileResult> {
  const closed = await listRecentClosedPulls();
  const reconciledIds: string[] = [];

  for (const pr of closed) {
    if (!pr.merged_at) continue;
    const issue = getByPrNumber(pr.number);
    if (!issue) continue;
    if (issue.status === "merged") continue;

    const result = await applyMergedPr({
      issue,
      prNumber: pr.number,
      prUrl: pr.html_url,
      mergedAt: pr.merged_at,
      source: "reconcile",
    });

    if (!result.alreadyMerged) {
      reconciledIds.push(issue.id);
    }
  }

  if (reconciledIds.length > 0) {
    log.warn("github reconcile recovered missed merges", { reconciledIds });
  } else {
    log.debug("github reconcile clean", {});
  }

  return { reconciledIds };
}
