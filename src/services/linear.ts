import crypto from "node:crypto";
import { insertTaskPending } from "../db/db.js";
import { config } from "../config.js";

const READY = () => config.linear.readyStateId();

export interface LinearWebhookResult {
  ok: true;
  inserted: boolean;
  issueId: string;
}

function extractStateId(obj: Record<string, unknown> | undefined): string | undefined {
  if (!obj) {
    return undefined;
  }
  if (typeof obj.stateId === "string") {
    return obj.stateId;
  }
  const st = obj.state;
  if (st && typeof st === "object" && st !== null && "id" in st) {
    return String((st as { id: string }).id);
  }
  return undefined;
}

function getIssueTitleDescription(data: Record<string, unknown>): {
  title: string;
  description: string;
} {
  const title = typeof data.title === "string" ? data.title : "";
  const description =
    typeof data.description === "string"
      ? data.description
      : typeof data.body === "string"
        ? data.body
        : "";
  return { title, description };
}

/**
 * Verify Linear-Signature: hex-encoded HMAC-SHA256 of raw body (see Linear webhook docs).
 */
export function verifyLinearWebhookSignature(
  rawBody: Buffer,
  headerSignature: string | undefined
): boolean {
  const secret = config.linear.webhookSecret();
  if (!headerSignature || typeof headerSignature !== "string") {
    return false;
  }
  let headerBuf: Buffer;
  try {
    headerBuf = Buffer.from(headerSignature, "hex");
  } catch {
    return false;
  }
  const computed = crypto.createHmac("sha256", secret).update(rawBody).digest();
  if (headerBuf.length !== computed.length) {
    return false;
  }
  return crypto.timingSafeEqual(headerBuf, computed);
}

export function verifyWebhookTimestamp(webhookTimestamp: unknown): boolean {
  if (typeof webhookTimestamp !== "number") {
    return false;
  }
  const skew = Math.abs(Date.now() - webhookTimestamp);
  return skew <= 60_000;
}

export function parseAndEnqueueLinearWebhook(
  body: unknown
): LinearWebhookResult | null {
  if (!body || typeof body !== "object") {
    return null;
  }
  const payload = body as Record<string, unknown>;
  if (payload.type !== "Issue") {
    return null;
  }
  const action = payload.action;
  const data = payload.data as Record<string, unknown> | undefined;
  if (!data || typeof data.id !== "string") {
    return null;
  }
  const issueId = data.id;
  const readyStateId = READY();
  const currState = extractStateId(data);
  if (currState !== readyStateId) {
    return null;
  }

  const updatedFrom = payload.updatedFrom as Record<string, unknown> | undefined;

  if (action === "create") {
    const { title, description } = getIssueTitleDescription(data);
    const { inserted } = insertTaskPending({ id: issueId, title, description });
    return { ok: true, inserted, issueId };
  }

  if (action === "update") {
    const prevState = extractStateId(updatedFrom);
    if (prevState === undefined) {
      return null;
    }
    if (prevState === readyStateId) {
      return null;
    }
    const { title, description } = getIssueTitleDescription(data);
    const { inserted } = insertTaskPending({ id: issueId, title, description });
    return { ok: true, inserted, issueId };
  }

  return null;
}
