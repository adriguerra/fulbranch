/**
 * GitHub webhook handler.
 *
 * Consumes `pull_request` events. We only act on `action=closed` with
 * `merged=true` — merge is the completion signal, not PR-open.
 *
 * Flow:
 *   1. Verify HMAC signature.
 *   2. Short-circuit if event isn't a merged PR.
 *   3. Find the matching issue by PR number in SQLite.
 *   4. Apply merge side effects via the shared `applyMergedPr` (DB,
 *      Linear → Done, Slack notify, dependent_unblocked events). The same
 *      function is used by the reconcile loop, so a missed webhook + late
 *      reconcile recovery produce identical end state.
 *   5. Trigger a dispatch cycle to start any newly-unblocked dependents.
 *
 * Body parsing: GitHub webhooks support TWO content types per the webhook
 * config UI — `application/json` (recommended) and
 * `application/x-www-form-urlencoded` (legacy). We accept both
 * transparently. 
 * 
 */

import { config } from "@/config";
import { verifyGitHubSignature } from "@/server/middleware/signature";
import { getByPrNumber } from "@/db/repositories/issues";
import { dispatch } from "@/orchestrator/dispatcher";
import { applyMergedPr } from "@/integrations/github/merge";
import { logger } from "@/utils/logger";
import type { GitHubPullRequestEvent } from "@/types/github";

const log = logger.child({ component: "webhook_github" });

export async function handleGitHubWebhook(req: Request): Promise<Response> {
  const rawBody = await req.text();
  const header = req.headers.get("x-hub-signature-256");
  const contentType = req.headers.get("content-type") ?? "";

  if (!verifyGitHubSignature(config().githubWebhookSecret, rawBody, header)) {
    log.warn("invalid signature");
    return new Response("invalid signature", { status: 401 });
  }

  const event = req.headers.get("x-github-event");
  if (event !== "pull_request") {
    return new Response("ignored: not pull_request", { status: 200 });
  }

  const payload = parseGitHubBody(rawBody, contentType);
  if (!payload) {
    // parseGitHubBody already emitted a diagnostic log line.
    return new Response("invalid body", { status: 400 });
  }

  if (payload.action !== "closed") {
    return new Response("ignored: action", { status: 200 });
  }
  if (!payload.pull_request?.merged) {
    return new Response("ignored: not merged", { status: 200 });
  }

  const prNumber = payload.number ?? payload.pull_request.number;
  const issue = getByPrNumber(prNumber);
  if (!issue) {
    log.info("no matching issue for PR", { prNumber });
    return new Response("no matching issue", { status: 200 });
  }

  const prUrl = payload.pull_request.html_url ?? `#${prNumber}`;

  const result = await applyMergedPr({
    issue,
    prNumber,
    prUrl,
    mergedAt: payload.pull_request.merged_at,
    source: "webhook",
  });

  if (result.alreadyMerged) {
    return new Response("already merged", { status: 200 });
  }

  dispatch("github_merge").catch((err) => {
    log.error("dispatch after github webhook failed", {
      error: err instanceof Error ? err.stack : String(err),
    });
  });

  return new Response("ok", { status: 200 });
}

/**
 * Parse a GitHub webhook body, transparently handling both
 * `application/json` (recommended config) and
 * `application/x-www-form-urlencoded` (legacy config).
 *
 * On failure, logs a diagnostic line including content type, body length,
 * and a small body preview so the operator can see why parsing failed
 * (e.g. wrong content-type setting on the GitHub webhook). Returns null.
 */
function parseGitHubBody(
  rawBody: string,
  contentType: string,
): GitHubPullRequestEvent | null {
  let jsonText = rawBody;

  // application/x-www-form-urlencoded: GitHub sends `payload=<URL-encoded JSON>`.
  if (contentType.includes("application/x-www-form-urlencoded")) {
    try {
      const params = new URLSearchParams(rawBody);
      const payloadField = params.get("payload");
      if (!payloadField) {
        log.warn("github body: form-urlencoded missing payload field", {
          contentType,
          bodyLen: rawBody.length,
          bodyPreview: rawBody.slice(0, 200),
        });
        return null;
      }
      jsonText = payloadField;
    } catch (err) {
      log.warn("github body: form-urlencoded parse failed", {
        contentType,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  try {
    return JSON.parse(jsonText) as GitHubPullRequestEvent;
  } catch (err) {
    log.warn("github body: JSON parse failed", {
      contentType,
      bodyLen: rawBody.length,
      bodyPreview: rawBody.slice(0, 200),
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
