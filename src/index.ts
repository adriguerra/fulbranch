import "dotenv/config";
import express from "express";
import type { Request } from "express";
import { config } from "./config.js";
import { startOrchestrator } from "./core/orchestrator.js";
import {
  parseAndEnqueueLinearWebhook,
  verifyLinearWebhookSignature,
  verifyWebhookTimestamp,
} from "./services/linear.js";
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

startOrchestrator();

app.listen(config.port, () => {
  console.log(`Fulbranch listening on port ${config.port}`);
});
