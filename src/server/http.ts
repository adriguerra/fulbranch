/**
 * Bun HTTP server — routes webhook traffic + health checks.
 *
 * Routes:
 *   POST /webhook/linear  → handleLinearWebhook
 *   POST /webhook/github  → handleGitHubWebhook
 *   GET  /health          → liveness probe
 *   GET  /                → static index for humans poking the URL
 */

import { handleLinearWebhook } from "./webhooks/linear";
import { handleGitHubWebhook } from "./webhooks/github";
import { config } from "@/config";
import { logger } from "@/utils/logger";
import { inFlight } from "@/orchestrator/semaphore";

const log = logger.child({ component: "http" });

export function startHttpServer(): void {
  const port = config().port;

  Bun.serve({
    port,
    async fetch(req): Promise<Response> {
      const url = new URL(req.url);
      const start = performance.now();
      try {
        const res = await route(req, url);
        const ms = Math.round(performance.now() - start);
        log.info("http", {
          method: req.method,
          path: url.pathname,
          status: res.status,
          ms,
        });
        return res;
      } catch (err) {
        log.error("http error", {
          method: req.method,
          path: url.pathname,
          error: err instanceof Error ? err.stack : String(err),
        });
        return new Response("internal error", { status: 500 });
      }
    },
    error(err): Response {
      log.error("http framework error", { error: String(err) });
      return new Response("internal error", { status: 500 });
    },
  });
  log.info("http server listening", { port });
}

async function route(req: Request, url: URL): Promise<Response> {
  if (req.method === "POST" && url.pathname === "/webhook/linear") {
    return handleLinearWebhook(req);
  }
  if (req.method === "POST" && url.pathname === "/webhook/github") {
    return handleGitHubWebhook(req);
  }
  if (req.method === "GET" && url.pathname === "/health") {
    return Response.json({
      ok: true,
      inFlightAgents: inFlight(),
      maxParallelAgents: config().maxParallelAgents,
    });
  }
  if (req.method === "GET" && url.pathname === "/") {
    return new Response("AI Dev Orchestrator — see /health", { status: 200 });
  }
  return new Response("not found", { status: 404 });
}
