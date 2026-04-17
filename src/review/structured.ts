import crypto from "node:crypto";
import { z } from "zod";
import type {
  StructuredReviewIssue,
  StructuredReviewRecord,
} from "../types.js";

const structuredIssueSchema = z.object({
  id: z.string(),
  type: z.enum(["bug", "style", "robustness", "test_gap"]),
  file: z.string(),
  instruction: z.string(),
  severity: z.enum(["low", "medium", "high"]),
});

export const structuredReviewRecordSchema = z.object({
  status: z.enum(["pass", "needs_work"]),
  summary: z.string(),
  issues: z.array(structuredIssueSchema),
});

/** Stable across review runs (ignores volatile LLM `id` strings) — used for repeat detection. */
export function issueFingerprint(file: string, instruction: string): string {
  return crypto
    .createHash("sha256")
    .update(`${file}\n${instruction}`, "utf8")
    .digest("hex")
    .slice(0, 24);
}

/** Parse persisted JSON from tasks.latest_review_json */
export function parseLatestReviewJson(
  raw: string | null | undefined
): StructuredReviewRecord | null {
  if (raw == null || String(raw).trim() === "") {
    return null;
  }
  try {
    const parsed = JSON.parse(String(raw)) as unknown;
    return structuredReviewRecordSchema.parse(parsed);
  } catch {
    return null;
  }
}

/** Parse stored hash list from tasks.review_issue_hashes */
export function parseIssueHashList(raw: string | null | undefined): string[] {
  if (raw == null || String(raw).trim() === "") {
    return [];
  }
  try {
    const parsed = JSON.parse(String(raw)) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

export function serializeIssueHashList(hashes: string[]): string {
  return JSON.stringify([...new Set(hashes)]);
}

/** Numbered prompt lines for fix mode (deterministic execution units). */
export function formatStructuredIssuesForFixPrompt(
  issues: StructuredReviewIssue[]
): string {
  return issues
    .map((issue, i) => {
      const id = issue.id ? `[${issue.id}] ` : "";
      return `${i + 1}. ${id}[${issue.type}] [${issue.severity}] ${issue.file}\n   ${issue.instruction}`;
    })
    .join("\n\n");
}
