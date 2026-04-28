/**
 * AI Dev Orchestrator — backend entry point.
 *
 * Boot sequence (TDD §4.1 + §5 + §6):
 *   1. Load + validate env config.
 *   2. Run SQLite migrations.
 *   3. Ensure target repo is cloned at REPO_PATH (clone or pull main).
 *   4. Run recovery sweep for interrupted runs (status=running).
 *   5. Start the 5-minute reconciliation loop (Linear + GitHub safety net).
 *   6. Start the HTTP server for webhook traffic.
 *   7. Trigger an initial dispatch() to pick up any pending work.
 *
 * Any boot-stage error is fatal — the container exits and Docker restarts it.
 */

import { config } from "./config";
import { logger } from "./utils/logger";
import { migrate } from "./db/migrate";
import { ensureRepo } from "./repo/manager";
import { recoverInterruptedRuns } from "./recovery/startup";
import { startReconciliationLoop } from "./reconciliation/loop";
import { startHttpServer } from "./server/http";
import { dispatch } from "./orchestrator/dispatcher";

async function main(): Promise<void> {
  const log = logger.child({ component: "boot" });

  log.info("orchestrator starting");

  // 1. Config — throws on missing required vars.
  const cfg = config();
  log.info("config loaded", {
    port: cfg.port,
    maxParallelAgents: cfg.maxParallelAgents,
    maxReviewCycles: cfg.maxReviewCycles,
    repoPath: cfg.repoPath,
    authMode: cfg.anthropicApiKey ? "api_key" : "oauth_token",
  });

  // 2. DB migrations.
  migrate();

  // 3. Repo bootstrap — clone or pull.
  await ensureRepo();

  // 4. Recovery — resume interrupted runs from last container boot.
  await recoverInterruptedRuns();

  // 5. Reconciliation loop.
  startReconciliationLoop();

  // 6. HTTP server.
  startHttpServer();

  // 7. Kick the dispatcher in case any tickets are already pending.
  await dispatch("boot");
  log.info("initial dispatch complete");
}

main().catch((err) => {
  logger.error("fatal boot error", { error: err instanceof Error ? err.stack : String(err) });
  process.exit(1);
});
