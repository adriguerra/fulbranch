/**
 * Slack notifications.
 *
 * Every message follows the same two-line format:
 *
 *   *<linearUrl|ID — Title>*
 *   <status line>
 *
 * Where relevant, an agent summary or failure reason is appended as a
 * block-quoted section below the status line.
 */

import { config } from "@/config";
import { logger } from "@/utils/logger";
import { withRetry } from "@/utils/retry";

const log = logger.child({ component: "slack" });

/**
 * The minimal ticket context every notification needs to build its header.
 * Callers construct this from an `Issue`: `{ id: issue.id, title: issue.title, linearUrl: issue.linearUrl }`.
 */
export interface NotifyTarget {
  id: string;
  title: string;
  linearUrl: string | null | undefined;
}

async function post(text: string): Promise<void> {
  const url = config().slackWebhookUrl;
  await withRetry(
    async () => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) {
        throw new Error(`Slack webhook returned ${res.status}: ${await res.text()}`);
      }
    },
    { label: "slack_post", attempts: 3 },
  );
  log.info("slack notified", { text });
}

function extractPrNumber(prUrl: string): string {
  const match = prUrl.match(/\/pull\/(\d+)/);
  return match ? `#${match[1]}` : "PR";
}

function prLink(prUrl: string): string {
  return `<${prUrl}|PR ${extractPrNumber(prUrl)}>`;
}

/** Strips the "ENG-144: " prefix that the spec agent adds in Pass 2. */
function cleanTitle(id: string, title: string): string {
  return title.replace(new RegExp(`^${id}[: ]+`), "").trim();
}

/**
 * Builds the bold header line linking to the Linear ticket.
 * Falls back to plain bold text when no URL is available.
 */
function header(target: NotifyTarget): string {
  const t = cleanTitle(target.id, target.title);
  if (target.linearUrl) {
    return `*<${target.linearUrl}|${target.id} — ${t}>*`;
  }
  return `*${target.id} — ${t}*`;
}

/**
 * Wraps each non-empty line in a Slack block-quote (`>`).
 * Used for agent summaries and error reasons.
 */
function quote(text: string): string {
  return text
    .split("\n")
    .map((line) => `>${line}`)
    .join("\n");
}

/** Agent picked up the ticket and started development. */
export function notifyAgentStarted(target: NotifyTarget): Promise<void> {
  return post([header(target), "Ticket development in progress"].join("\n"));
}

/**
 * Reviewer cycle started.
 * `devSummary` is the concluding message from the developer agent for this cycle.
 */
export function notifyInReview(
  target: NotifyTarget,
  cycle: number,
  maxCycles: number,
  devSummary?: string,
): Promise<void> {
  const lines = [header(target), `In review — cycle ${cycle} of ${maxCycles}`];
  if (devSummary) {
    lines.push("", "Development summary:", quote(devSummary));
  }
  return post(lines.join("\n"));
}

/**
 * Reviewer returned FAIL and the ticket is sent back to the developer.
 * `issues` are the individual bullet-point items from the reviewer verdict.
 */
export function notifyReviewFailed(
  target: NotifyTarget,
  cycle: number,
  maxCycles: number,
  reviewSummary: string,
  reviewIssues: string[],
): Promise<void> {
  const feedbackLines = [reviewSummary, ...reviewIssues.map((i) => `• ${i}`)].join("\n");
  const lines = [
    header(target),
    `Sent back to development — cycle ${cycle} of ${maxCycles}`,
    "",
    "Reviewer notes:",
    quote(feedbackLines),
  ];
  return post(lines.join("\n"));
}

/** Reviewer passed and the PR is open and ready to merge. */
export function notifyPrReady(target: NotifyTarget, prUrl: string): Promise<void> {
  return post(
    [header(target), `Review passed — ${prLink(prUrl)} ready to merge`].join("\n"),
  );
}

/** AUTO_MERGE: reviewer passed and the PR was merged immediately by the orchestrator. */
export function notifyAutoMerged(target: NotifyTarget, prUrl: string): Promise<void> {
  return post(
    [header(target), `Review passed — ${prLink(prUrl)} auto-merged`].join("\n"),
  );
}

/**
 * All review cycles exhausted without a pass.
 * PR is opened with a NEEDS ATTENTION flag.
 */
export function notifyPrFlagged(
  target: NotifyTarget,
  prUrl: string,
  maxCycles: number,
  reviewSummary?: string,
  reviewIssues?: string[],
): Promise<void> {
  const lines = [
    header(target),
    `Review cycles exhausted (${maxCycles}/${maxCycles}) — ${prLink(prUrl)} opened with unresolved issues`,
  ];
  if (reviewSummary) {
    const feedbackLines = [reviewSummary, ...(reviewIssues ?? []).map((i) => `• ${i}`)].join("\n");
    lines.push("", "Reviewer notes:", quote(feedbackLines));
  }
  return post(lines.join("\n"));
}

/** Pipeline failed permanently — ticket moved to Todo. */
export function notifyPipelineFailed(
  target: NotifyTarget,
  reason: string,
): Promise<void> {
  return post(
    [header(target), "Pipeline failed — ticket moved to Todo", "", "Reason:", quote(reason)].join(
      "\n",
    ),
  );
}

/** Anthropic auth failure — no automatic retry, operator action required. */
export function notifyAuthFailure(target: NotifyTarget, reason: string): Promise<void> {
  return post(
    [
      header(target),
      "Anthropic auth failure — orchestrator paused for this ticket",
      "",
      "Reason:",
      quote(reason),
    ].join("\n"),
  );
}

/**
 * `git push` or `gh pr create` failed after the reviewer signed off.
 * The dev work is preserved in the worktree; a human must push manually
 * or fix the underlying cause (e.g. PAT scope) and re-arm via Retry-via-Todo.
 */
export function notifyPrCreationBlocked(target: NotifyTarget, reason: string): Promise<void> {
  return post(
    [
      header(target),
      "PR creation blocked — dev work preserved in worktree, manual push needed",
      "",
      "Reason:",
      quote(reason),
    ].join("\n"),
  );
}

/** PR merged; any downstream tickets that are now unblocked are listed. */
export function notifyDependentsUnblocked(
  target: NotifyTarget,
  prUrl: string,
  unblockedIds: string[],
): Promise<void> {
  const body =
    unblockedIds.length > 0
      ? `${prLink(prUrl)} merged — ${unblockedIds.join(", ")} unblocked and queued`
      : `${prLink(prUrl)} merged`;
  return post([header(target), body].join("\n"));
}

/** Circular dependency detected in the ticket graph. */
export function notifyCycleDetected(cycle: string[]): Promise<void> {
  return post(`Circular dependency detected: ${cycle.join(" -> ")}. Halting affected run.`);
}
