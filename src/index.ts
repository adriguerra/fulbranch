import "dotenv/config";
import express from "express";
import type { Request } from "express";
import { runReviewer } from "./agents/reviewer.js";
import { config } from "./config.js";
import { startOrchestrator } from "./core/orchestrator.js";
import { getTaskByBranchName } from "./db/db.js";
import { taskLog } from "./logger.js";
import {
  parseAndEnqueueLinearWebhook,
  verifyLinearWebhookSignature,
  verifyWebhookTimestamp,
} from "./services/linear.js";
import { verifyGitHubWebhookSignature } from "./services/github.js";
import { countOpenPRs } from "./core/queue.js";

type RequestWithRawBody = Request & { rawBody?: Buffer };

const app = express();
app.use(
  express.json({
    verify: (req: Request, _res, buf: Buffer) => {
      (req as RequestWithRawBody).rawBody = buf;
    },
  })
);

app.get("/health", (_req, res) => {
  res.json({ ok: true, openTasks: countOpenPRs() });
});

app.post("/webhook/linear", (req: RequestWithRawBody, res) => {
  const raw = req.rawBody;
  if (!raw) {
    res.status(400).json({ error: "missing raw body" });
    return;
  }
  const sig = req.get("linear-signature");
  if (!verifyLinearWebhookSignature(raw, sig)) {
    res.status(401).json({ error: "invalid signature" });
    return;
  }
  if (!verifyWebhookTimestamp(req.body?.webhookTimestamp)) {
    res.status(401).json({ error: "invalid or stale timestamp" });
    return;
  }
  const result = parseAndEnqueueLinearWebhook(req.body);
  if (!result) {
    res.status(200).json({ ok: true, ignored: true });
    return;
  }
  res.status(200).json({
    ok: true,
    inserted: result.inserted,
    issueId: result.issueId,
  });
});

app.post("/webhook/github", (req: RequestWithRawBody, res) => {
  const event = req.get("x-github-event");
  if (event !== "push") {
    res.status(200).json({ ok: true, ignored: true });
    return;
  }

  const raw = req.rawBody;
  if (!raw) {
    res.status(400).json({ error: "missing raw body" });
    return;
  }

  const sig = req.get("x-hub-signature-256");
  if (!verifyGitHubWebhookSignature(raw, sig)) {
    res.status(401).json({ error: "invalid signature" });
    return;
  }

  const payload = req.body as Record<string, unknown>;
  if (payload.deleted === true) {
    res.status(200).json({ ok: true, ignored: true });
    return;
  }

  const ref = payload.ref;
  if (typeof ref !== "string" || !ref.startsWith("refs/heads/")) {
    res.status(200).json({ ok: true, ignored: true });
    return;
  }

  const branchName = ref.slice("refs/heads/".length);
  const task = getTaskByBranchName(branchName);
  if (!task) {
    res.status(200).json({ ok: true, ignored: true });
    return;
  }
  if (task.status === "done" || task.status === "blocked") {
    res.status(200).json({ ok: true, ignored: true });
    return;
  }

  taskLog(task.id, "push received → review triggered");
  void runReviewer(task).catch((err) => {
    console.error(`[webhook/github] review failed for ${task.id}:`, err);
  });
  res.status(200).json({ ok: true });
});

startOrchestrator();

app.listen(config.port, () => {
  console.log(`Fulbranch listening on port ${config.port}`);
});
