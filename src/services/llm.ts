import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type {
  FileChange,
  FileContent,
  ReviewResult,
  StructuredReviewIssue,
  StructuredReviewRecord,
  Task,
} from "../types.js";
import {
  formatStructuredIssuesForFixPrompt,
  issueFingerprint,
  parseLatestReviewJson,
} from "../review/structured.js";
import { config } from "../config.js";

export type LLMProvider = "openai" | "anthropic";

export interface LLMRequest {
  provider: LLMProvider;
  model: string;
  system: string;
  prompt: string;
}

export interface ImplementationOptions {
  /** Lower-priority excerpt from GitHub thread when structured issues are primary. */
  githubSupplement?: string;
}

const implementationSchema = z.array(
  z.object({
    path: z.string(),
    content: z.string(),
  })
);

function extractJsonArray(text: string): string {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("No JSON array found in LLM response");
  }
  return text.slice(start, end + 1);
}

function extractJsonObject(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("No JSON object found in LLM response");
  }
  return text.slice(start, end + 1);
}

function coerceStructuredIssue(raw: unknown): StructuredReviewIssue {
  if (typeof raw === "string") {
    const instruction = raw.trim();
    const file = "(unspecified)";
    const id = issueFingerprint(file, instruction);
    return {
      id,
      type: "robustness",
      file,
      instruction,
      severity: "medium",
    };
  }
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid structured issue");
  }
  const o = raw as Record<string, unknown>;
  const instruction =
    typeof o.instruction === "string"
      ? o.instruction
      : JSON.stringify(raw);
  const file = typeof o.file === "string" ? o.file : "(unspecified)";
  const id =
    typeof o.id === "string" && o.id.trim()
      ? o.id.trim()
      : issueFingerprint(file, instruction);
  const type =
    o.type === "bug" ||
    o.type === "style" ||
    o.type === "robustness" ||
    o.type === "test_gap"
      ? o.type
      : "robustness";
  const severity =
    o.severity === "low" ||
    o.severity === "medium" ||
    o.severity === "high"
      ? o.severity
      : "medium";
  return { id, type, file, instruction, severity };
}

/** Parse reviewer JSON — new shape (status + object issues), legacy (verdict + string[]), or mixed. */
export function normalizeReviewResult(parsed: unknown): ReviewResult {
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Review result is not an object");
  }
  const obj = parsed as Record<string, unknown>;

  const summary = typeof obj.summary === "string" ? obj.summary : "";

  const verdictRaw = obj.verdict ?? obj.status;
  if (verdictRaw !== "pass" && verdictRaw !== "needs_work") {
    throw new Error('Review result must include verdict or status: "pass" | "needs_work"');
  }
  const verdict = verdictRaw;

  const rawIssues = obj.issues;
  if (!Array.isArray(rawIssues)) {
    throw new Error('Review result must include an "issues" array');
  }

  let structuredIssues =
    verdict === "pass" ? [] : rawIssues.map(coerceStructuredIssue);

  if (verdict === "needs_work" && structuredIssues.length === 0) {
    const instruction =
      summary.trim() || "Address the problems identified in this review.";
    structuredIssues = [
      {
        id: issueFingerprint("(unspecified)", instruction),
        type: "robustness",
        file: "(unspecified)",
        instruction,
        severity: "medium",
      },
    ];
  }

  return {
    verdict,
    summary,
    structuredIssues,
  };
}

export async function callLLM(req: LLMRequest): Promise<string> {
  if (req.provider === "openai") {
    const client = new OpenAI({ apiKey: config.llm.openaiKey() });
    const res = await client.chat.completions.create({
      model: req.model,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.prompt },
      ],
      temperature: 0.2,
    });
    const text = res.choices[0]?.message?.content;
    if (!text) {
      throw new Error("OpenAI returned empty content");
    }
    return text;
  }
  const client = new Anthropic({ apiKey: config.llm.anthropicKey() });
  const res = await client.messages.create({
    model: req.model,
    max_tokens: 4096,
    system: req.system,
    messages: [{ role: "user", content: req.prompt }],
  });
  const block = res.content[0];
  if (!block || block.type !== "text") {
    throw new Error("Anthropic returned no text block");
  }
  return block.text;
}

export async function generateImplementation(
  task: Task,
  fileContents: FileContent[],
  options?: ImplementationOptions
): Promise<FileChange[]> {
  const context = fileContents
    .map((f) => `--- ${f.path} ---\n${f.content}`)
    .join("\n\n");

  const stored = parseLatestReviewJson(task.latest_review_json);
  const useStructuredFix =
    stored?.status === "needs_work" && stored.issues.length > 0;

  if (useStructuredFix && stored) {
    return generateStructuredFixImplementation(
      task,
      context,
      stored,
      options?.githubSupplement
    );
  }

  const rf = task.review_feedback?.trim() ?? "";
  const fixingMode = rf !== "";

  const feedbackBlock = fixingMode
    ? `\n\nReview feedback to address (Fulbranch automated review and/or GitHub discussion — treat every point as something to fix or satisfy):\n${rf}\n`
    : "";

  const systemImplement = `You are an expert software engineer. Respond with ONLY a valid JSON array of objects with keys "path" and "content" (full file contents). No markdown fences, no commentary.`;

  const systemFix = `You are fixing an existing pull request to satisfy review feedback. Respond with ONLY a valid JSON array of objects with keys "path" and "content" (full file contents for each changed file only). No markdown fences, no commentary.

Rules:
- This is a FIXING pass, not greenfield implementation. Address the review feedback only.
- Mentally extract each concrete issue from the feedback; fix those items. Do not skip review items.
- Make the smallest reasonable change: prefer editing existing code over rewriting files.
- Do NOT refactor unrelated code, add features, change architecture, rename APIs, or "improve" code outside the requested fixes.
- Include in the JSON array ONLY files you actually modified. Do not output unchanged files.
- Preserve the PR's original intent.

If feedback is ambiguous, make the safest minimal fix that addresses the stated concern.`;

  const promptImplement = `Task ID: ${task.id}
Title: ${task.title}
Description:
${task.description}

Repository files for context:
${context}

Implement the task by outputting the complete files to create or replace. JSON array format: [{"path":"relative/path.ts","content":"..."}]`;

  const promptFix = `Task ID: ${task.id}
Original title: ${task.title}
Original description (context only — do not expand scope beyond it):
${task.description}
${feedbackBlock}

Repository files for context:
${context}

Apply ONLY the fixes required by the review feedback above. Output JSON array with one entry per modified file only (full file contents): [{"path":"relative/path.ts","content":"..."}]`;

  const system = fixingMode ? systemFix : systemImplement;
  const prompt = fixingMode ? promptFix : promptImplement;

  const raw = await callLLM({
    provider: "openai",
    model: "gpt-4o",
    system,
    prompt,
  });
  const jsonText = extractJsonArray(raw);
  const parsed = JSON.parse(jsonText) as unknown;
  return implementationSchema.parse(parsed);
}

async function generateStructuredFixImplementation(
  task: Task,
  context: string,
  stored: StructuredReviewRecord,
  githubSupplement?: string
): Promise<FileChange[]> {
  const issueList = formatStructuredIssuesForFixPrompt(stored.issues);
  let supplementBlock = "";
  if (githubSupplement?.trim()) {
    const clipped = githubSupplement.trim().slice(0, 12_000);
    supplementBlock = `\n\nSupplementary context (lower priority — GitHub PR thread excerpt):\n${clipped}\n`;
  }

  const system = `You are fixing an existing pull request. Respond with ONLY a valid JSON array of objects with keys "path" and "content" (full file contents for each changed file only). No markdown fences, no commentary.

Rules:
- Fix ONLY the numbered issues below. Each issue lists file, type, severity, and instruction — those are your execution units.
- Make minimal edits. Do NOT refactor unrelated code, add features, or change architecture.
- Include ONLY files you modified in the JSON array (full file contents per file).
- Do not introduce unrelated improvements. Preserve the PR's original intent.`;

  const prompt = `Task ID: ${task.id}
Original title: ${task.title}
Summary from reviewer: ${stored.summary}

Fix ONLY the following issues:
${issueList}
${supplementBlock}
Repository files for context:
${context}

Output JSON array with one entry per modified file only: [{"path":"relative/path.ts","content":"..."}]`;

  const raw = await callLLM({
    provider: "openai",
    model: "gpt-4o",
    system,
    prompt,
  });
  const jsonText = extractJsonArray(raw);
  const parsed = JSON.parse(jsonText) as unknown;
  return implementationSchema.parse(parsed);
}

export async function reviewCode(diff: string): Promise<ReviewResult> {
  const system = `You are a senior code reviewer. Respond with ONLY a valid JSON object. No markdown fences, no extra text.

Required shape:
{
  "status": "pass" | "needs_work",
  "summary": "short string",
  "issues": [
    {
      "id": "stable id: use short hex or slug, unique per issue in this review",
      "type": "bug" | "style" | "robustness" | "test_gap",
      "file": "repo-relative path e.g. src/api/users.ts or (unspecified) if not file-specific",
      "instruction": "precise fix instruction in one sentence",
      "severity": "low" | "medium" | "high"
    }
  ]
}

Rules:
- If status is "pass", issues MUST be [].
- If status is "needs_work", each issue MUST be actionable: what to change and where (file path when possible).
- Prefer one issue per distinct problem. Do not merge unrelated concerns.`;

  const prompt = `Review this pull request diff. Find bugs, missing tests, and risks.

DIFF:
${diff}`;

  const raw = await callLLM({
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    system,
    prompt,
  });
  const jsonText = extractJsonObject(raw);
  const parsed = JSON.parse(jsonText) as unknown;
  return normalizeReviewResult(parsed);
}
