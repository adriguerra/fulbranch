/**
 * Linear webhook handler.
 *
 * Flow:
 *   1. Verify HMAC signature.
 *   2. Parse body; must be an Issue create/update event.
 *   3. Filter: `orchestrator-managed` label must be present. Anything else
 *      is silently ignored + logged — this is how we keep human-created
 *      tickets and Pass 1 drafts out of the pipeline.
 *   4. Parse `depends_on` from the description.
 *   5. Upsert into SQLite.
 *   6. Trigger dispatch().
 *
 * Signature + label filter are both first-class safety checks — we do them
 * before any meaningful work.
 */

import { config } from "@/config";
import { verifyLinearSignature } from "@/server/middleware/signature";
import { getIssueByIdentifier, extractBlockedBy } from "@/integrations/linear/client";
import { upsertIssue, getIssue, updateStatus } from "@/db/repositories/issues";
import { appendEvent } from "@/db/repositories/events";
import { dispatch } from "@/orchestrator/dispatcher";
import { logger } from "@/utils/logger";
import type { LinearWebhookPayload } from "@/types/linear";

export const ORCHESTRATOR_MANAGED_LABEL = "orchestrator-managed";

export const LINEAR_STATE_BACKLOG = "Backlog";
export const LINEAR_STATE_TODO = "Todo";
export const LINEAR_STATE_IN_PROGRESS = "In Progress";
export const LINEAR_STATE_IN_REVIEW = "In Review";
export const LINEAR_STATE_DONE = "Done";

export const LINEAR_ACTIVE_STATES = new Set([
  LINEAR_STATE_TODO,
  LINEAR_STATE_IN_PROGRESS,
  LINEAR_STATE_IN_REVIEW,
]);

const log = logger.child({ component: "webhook_linear" });

export async function handleLinearWebhook(req: Request): Promise<Response> {
  const rawBody = await req.text();
  const header = req.headers.get("linear-signature");

  if (!verifyLinearSignature(config().linearWebhookSecret, rawBody, header)) {
    log.warn("invalid signature");
    return new Response("invalid signature", { status: 401 });
  }

  let payload: LinearWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as LinearWebhookPayload;
  } catch {
    return new Response("invalid json", { status: 400 });
  }

  if (payload.type !== "Issue") {
    // Comment / Project events are not consumed.
    return new Response("ignored: not Issue", { status: 200 });
  }
  if (payload.action !== "create" && payload.action !== "update") {
    return new Response("ignored: action", { status: 200 });
  }

  const { data } = payload;

  // Label filter — the orchestrator's first safety gate (TDD §6.1).
  const hasLabel = Array.isArray(data.labels)
    && data.labels.some((l) => l.name === ORCHESTRATOR_MANAGED_LABEL);
  if (!hasLabel) {
    log.info("ignored: missing orchestrator-managed label", {
      identifier: data.identifier,
    });
    appendEvent({
      issueId: data.identifier ?? null,
      eventType: "webhook_ignored_unlabelled",
      detail: `action=${payload.action} labels=${(data.labels ?? []).map((l) => l.name).join(",")}`,
    });
    return new Response("ignored: unlabelled", { status: 200 });
  }

  const stateName = data.state?.name ?? "";
  if (!LINEAR_ACTIVE_STATES.has(stateName)) {
    // Backlog is the developer's safe-setup column. If a pending ticket is
    // moved there, pause it so the dispatcher won't pick it up. In-flight
    // tickets (running/reviewing) are left alone — we don't interrupt a live
    // pipeline. The reconciler will re-arm the ticket when it returns to an
    // active state.
    if (stateName === LINEAR_STATE_BACKLOG) {
      const existing = getIssue(data.identifier);
      if (existing?.status === "pending") {
        updateStatus(data.identifier, "paused");
        appendEvent({
          issueId: data.identifier,
          eventType: "webhook_received",
          detail: "paused: moved to Backlog",
        });
        log.info("ticket paused: moved to Backlog", { identifier: data.identifier });
      }
    }
    log.info("ignored: inactive state", { identifier: data.identifier, stateName });
    return new Response("ignored: inactive state", { status: 200 });
  }

  // Fetch the full issue to get native blocking relations — the webhook
  // payload does not include the `relations` field.
  const fullIssue = await getIssueByIdentifier(data.identifier).catch((err) => {
    log.warn("failed to fetch issue relations, ingesting with empty deps", {
      identifier: data.identifier,
      error: String(err),
    });
    return null;
  });

  const deps = fullIssue ? extractBlockedBy(fullIssue) : [];

  upsertIssue({
    id: data.identifier,
    linearUuid: data.id,
    linearUrl: data.url ?? null,
    title: data.title,
    description: data.description ?? "",
    dependsOn: deps,
  });

  appendEvent({
    issueId: data.identifier,
    eventType: "webhook_received",
    detail: `action=${payload.action} deps=[${deps.join(",")}]`,
  });

  log.info("issue ingested", {
    identifier: data.identifier,
    action: payload.action,
    deps,
  });

  // Trigger dispatch in the background — don't block the webhook response.
  dispatch("linear_webhook").catch((err) => {
    log.error("dispatch after linear webhook failed", {
      error: err instanceof Error ? err.stack : String(err),
    });
  });

  return new Response("ok", { status: 200 });
}
