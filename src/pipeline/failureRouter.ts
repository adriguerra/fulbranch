/**
 * Failure router (Phase 1e).
 *
 * Translates a classified `FailureKind` into a concrete pipeline action:
 *
 *   FailureKind        | Status   | Worktree | Slack          | Linear
 *   -------------------|----------|----------|----------------|----------------
 *   rate_limit         | pending  | KEEP     | suppressed     | unchanged
 *   schema_invalid     | pending  | KEEP     | suppressed     | unchanged
 *   timeout            | pending  | KEEP     | suppressed     | unchanged
 *   network            | pending  | KEEP     | suppressed     | unchanged
 *   auth               | failed   | KEEP     | @here alert    | failed → Todo
 *   agent_error        | failed   | DROP     | pipeline failed| failed → Todo
 *
 * "KEEP" means the worktree is left in place so the next dispatch can resume
 * inside it (Phase 2). The actual `removeWorktree` call is handled by the
 * caller based on `result.dropWorktree`.
 *
 * Phase 4 (resume-from-review): the `context.stage` is persisted as
 * `last_failure_stage` so runPipeline can decide whether the resume needs
 * to re-run the developer agent (stage='dev') or skip straight into the
 * review loop (stage='review'). A schema_invalid at the reviewer should not
 * burn a dev retry slot or flip Linear back to "In Progress".
 *
 * Backoff for transient retries (the wall-clock delay until next_retry_at):
 *   - rate_limit    → resetsAt if Anthropic told us, else +5min
 *   - schema_invalid→ +30s, capped at 2 attempts inside the loop
 *   - timeout       → exponential: retryCount=0 → 1m, =1 → 5m, =2 → 15m
 *   - network       → same exponential as timeout
 *
 * After backoff caps are exhausted, the failure is escalated to `agent_error`.
 */

import type { FailureKind, FailureStage, Issue } from "@/types/pipeline";
import {
  clearRetryState,
  markFailed,
  scheduleRetry,
} from "@/db/repositories/issues";
import { appendEvent } from "@/db/repositories/events";
import { onFailed } from "@/integrations/linear/statusSync";
import {
  notifyAuthFailure,
  notifyPipelineFailed,
} from "@/integrations/slack/notifier";
import type { NotifyTarget } from "@/integrations/slack/notifier";
import { logger } from "@/utils/logger";

const log = logger.child({ component: "failure_router" });

const TRANSIENT_BACKOFF_CAPS: Record<string, number> = {
  rate_limit: 5,
  schema_invalid: 2,
  timeout: 3,
  network: 3,
};

const TIMEOUT_NETWORK_BACKOFF_MS = [
  1 * 60 * 1000,   // 1m
  5 * 60 * 1000,   // 5m
  15 * 60 * 1000,  // 15m
];

const SCHEMA_INVALID_BACKOFF_MS = 30 * 1000;          // 30s
const RATE_LIMIT_DEFAULT_BACKOFF_MS = 5 * 60 * 1000;  // 5m if no resetsAt

export interface RoutedAction {
  /** True if the worktree should be removed by the caller. */
  dropWorktree: boolean;
  /** True if the dispatcher should pull this issue again later. */
  willRetry: boolean;
  /** Permanent failure was recorded — the pipeline is done with this issue. */
  permanent: boolean;
}

/**
 * Decide what to do with a failed agent run.
 *
 * Side effects: updates SQLite (status, retry_count, next_retry_at,
 * last_failure_kind, failure_reason), appends an event, fires Slack/Linear
 * sync where appropriate. Worktree teardown is left to the caller via
 * `dropWorktree` so the same router can be reused at multiple call sites.
 */
export async function routeFailure(
  issue: Issue,
  kind: FailureKind,
  context: { stage: FailureStage },
): Promise<RoutedAction> {
  log.info("routing failure", {
    issueId: issue.id,
    stage: context.stage,
    kind: kind.type,
    retryCount: issue.retryCount,
    message: kind.message.slice(0, 200),
  });

  switch (kind.type) {
    case "rate_limit": {
      if (overBackoffCap(issue, "rate_limit")) {
        return await escalateToAgentError(issue, kind, context, "rate_limit cap");
      }
      const when = kind.resetsAt
        ?? new Date(Date.now() + RATE_LIMIT_DEFAULT_BACKOFF_MS);
      scheduleTransient(issue, kind, when, context);
      return { dropWorktree: false, willRetry: true, permanent: false };
    }

    case "schema_invalid": {
      if (overBackoffCap(issue, "schema_invalid")) {
        return await escalateToAgentError(issue, kind, context, "schema_invalid cap");
      }
      const when = new Date(Date.now() + SCHEMA_INVALID_BACKOFF_MS);
      scheduleTransient(issue, kind, when, context);
      return { dropWorktree: false, willRetry: true, permanent: false };
    }

    case "timeout":
    case "network": {
      if (overBackoffCap(issue, kind.type)) {
        return await escalateToAgentError(issue, kind, context, `${kind.type} cap`);
      }
      const idx = Math.min(issue.retryCount, TIMEOUT_NETWORK_BACKOFF_MS.length - 1);
      const when = new Date(Date.now() + TIMEOUT_NETWORK_BACKOFF_MS[idx]!);
      scheduleTransient(issue, kind, when, context);
      return { dropWorktree: false, willRetry: true, permanent: false };
    }

    case "auth": {
      markFailed(issue.id, `auth: ${kind.message}`);
      appendEvent({
        issueId: issue.id,
        eventType: "dev_agent_complete",
        detail: `auth_failure: ${kind.message.slice(0, 200)}`,
      });
      if (issue.linearUuid) await onFailed(issue.linearUuid, kind.message);
      const authTarget: NotifyTarget = { id: issue.id, title: issue.title, linearUrl: issue.linearUrl };
      notifyAuthFailure(authTarget, kind.message).catch(() => {});
      return { dropWorktree: false, willRetry: false, permanent: true };
    }

    case "agent_error":
    default: {
      return await escalateToAgentError(issue, kind, context, "agent_error");
    }
  }
}

function overBackoffCap(issue: Issue, kind: string): boolean {
  const cap = TRANSIENT_BACKOFF_CAPS[kind];
  return cap != null && issue.retryCount >= cap;
}

function scheduleTransient(
  issue: Issue,
  kind: FailureKind,
  nextRetryAt: Date,
  context: { stage: FailureStage },
): void {
  scheduleRetry({
    id: issue.id,
    kind: kind.type,
    stage: context.stage,
    reason: kind.message.slice(0, 1000),
    nextRetryAt,
  });
  appendEvent({
    issueId: issue.id,
    eventType: "dev_agent_complete",
    detail: `transient_retry stage=${context.stage} kind=${kind.type} nextAt=${nextRetryAt.toISOString()}`,
  });
}

async function escalateToAgentError(
  issue: Issue,
  kind: FailureKind,
  context: { stage: FailureStage },
  why: string,
): Promise<RoutedAction> {
  const reason = `${kind.type}: ${kind.message}`.slice(0, 1000);
  markFailed(issue.id, reason);
  // Reset retry state so a manual re-queue (Linear → Todo) starts clean.
  clearRetryState(issue.id);
  appendEvent({
    issueId: issue.id,
    eventType: "dev_agent_complete",
    detail: `permanent_failure stage=${context.stage} cause=${why}`,
  });
  if (issue.linearUuid) await onFailed(issue.linearUuid, reason);
  const failTarget: NotifyTarget = { id: issue.id, title: issue.title, linearUrl: issue.linearUrl };
  notifyPipelineFailed(failTarget, reason).catch(() => {});
  return { dropWorktree: true, willRetry: false, permanent: true };
}
