import "dotenv/config";
import express from "express";
import type { Request } from "express";
import { runImplementer } from "./agents/implementer.js";
import { runReviewer } from "./agents/reviewer.js";
import { config } from "./config.js";
import { handleAgentError } from "./core/worker.js";
import { startOrchestrator } from "./core/orchestrator.js";
import {
  findTaskForPullRequest,
  getTaskByBranchName,
  updateTask,
} from "./db/db.js";
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

function taskEligibleForImplementer(
  status: string
): status is "in_progress" | "review" {
  return status === "in_progress" || status === "review";
}

app.post("/webhook/github", (req: RequestWithRawBody, res) => {
  const event = req.get("x-github-event") ?? "";

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

  const handledEvents = new Set([
    "push",
    "pull_request_review",
    "issue_comment",
  ]);
  if (!handledEvents.has(event)) {
    res.status(200).json({ ok: true, ignored: true });
    return;
  }

  if (event === "push") {
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
    return;
  }

  if (event === "pull_request_review") {
    if (payload.action !== "submitted") {
      res.status(200).json({ ok: true, ignored: true });
      return;
    }

    const pr = payload.pull_request as Record<string, unknown> | undefined;
    if (!pr || pr.state !== "open") {
      res.status(200).json({ ok: true, ignored: true });
      return;
    }

    const prNum = pr.number;
    const head = pr.head as Record<string, unknown> | undefined;
    const headRef =
      head && typeof head.ref === "string" ? head.ref : undefined;

    if (typeof prNum !== "number") {
      res.status(200).json({ ok: true, ignored: true });
      return;
    }

    const task = findTaskForPullRequest(prNum, headRef);
    if (!task || !taskEligibleForImplementer(task.status)) {
      res.status(200).json({ ok: true, ignored: true });
      return;
    }

    taskLog(task.id, "PR review submitted → implementer triggered");
    updateTask(task.id, { status: "in_progress" });
    void runImplementer(task).catch((err) => {
      console.error(`[webhook/github] implementer failed for ${task.id}:`, err);
      handleAgentError(task, err);
    });
    res.status(200).json({ ok: true });
    return;
  }

  if (event === "issue_comment") {
    if (payload.action !== "created") {
      res.status(200).json({ ok: true, ignored: true });
      return;
    }

    const issue = payload.issue as Record<string, unknown> | undefined;
    if (!issue?.pull_request) {
      res.status(200).json({ ok: true, ignored: true });
      return;
    }

    if (issue.state !== "open") {
      res.status(200).json({ ok: true, ignored: true });
      return;
    }

    const num = issue.number;
    if (typeof num !== "number") {
      res.status(200).json({ ok: true, ignored: true });
      return;
    }

    const task = findTaskForPullRequest(num, null);
    if (!task || !taskEligibleForImplementer(task.status)) {
      res.status(200).json({ ok: true, ignored: true });
      return;
    }

    taskLog(task.id, "PR thread comment → implementer triggered");
    updateTask(task.id, { status: "in_progress" });
    void runImplementer(task).catch((err) => {
      console.error(`[webhook/github] implementer failed for ${task.id}:`, err);
      handleAgentError(task, err);
    });
    res.status(200).json({ ok: true });
    return;
  }

  res.status(200).json({ ok: true, ignored: true });
});

startOrchestrator();

app.listen(config.port, () => {
  console.log(`Fulbranch listening on port ${config.port}`);
});
