import { generateText, generateObject } from "ai";
import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import type {
  FileChange,
  FileContent,
  ReviewResult,
  StructuredReviewIssue,
  Task,
} from "../types.js";
import {
  formatStructuredIssuesForFixPrompt,
  issueFingerprint,
  parseLatestReviewJson,
} from "../review/structured.js";
export type LLMProvider = "openai" | "anthropic";

export interface LLMRequest {
  provider: LLMProvider;
  model: string;
  system: string;
  prompt: string;
}

export interface ImplementationOptions {
  githubSupplement?: string;
}

const implementationSchema = z.object({
  files: z.array(
    z.object({
      path: z.string(),
      content: z.string(),
    })
  ),
});

const reviewSchema = z.object({
  status: z.enum(["pass", "needs_work"]),
  summary: z.string(),
  issues: z.array(
    z.object({
      id: z.string(),
      type: z.enum(["bug", "style", "robustness", "test_gap"]),
      file: z.string(),
      instruction: z.string(),
      severity: z.enum(["low", "medium", "high"]),
    })
  ),
});

export async function callLLM(req: LLMRequest): Promise<string> {
  const model =
    req.provider === "openai"
      ? openai(req.model)
      : anthropic(req.model as Parameters<typeof anthropic>[0]);

  const { text } = await generateText({
    model,
    system: req.system,
    prompt: req.prompt,
    temperature: 0.2,
  });

  return text;
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
      stored.issues,
      stored.summary,
      options?.githubSupplement
    );
  }

  const rf = task.review_feedback?.trim() ?? "";
  const fixingMode = rf !== "";

  const systemImplement = `You are an expert software engineer. Output a JSON object with a "files" array containing objects with "path" and "content" (full file contents) for each file to create or replace.`;

  const systemFix = `You are fixing an existing pull request to satisfy review feedback. Output a JSON object with a "files" array containing objects with "path" and "content" (full file contents) for each modified file only.

Rules:
- Fix ONLY what the review feedback requests. No scope creep.
- Minimal edits — prefer targeted changes over rewrites.
- Include ONLY files you actually modified.
- Preserve the PR's original intent.`;

  const feedbackBlock = fixingMode
    ? `\n\nReview feedback to address:\n${rf}\n`
    : "";

  const prompt = fixingMode
    ? `Task ID: ${task.id}
Original title: ${task.title}
Original description (context only):
${task.description}
${feedbackBlock}
Repository files for context:
${context}

Apply ONLY the fixes required by the review feedback. Output files array with one entry per modified file (full file contents).`
    : `Task ID: ${task.id}
Title: ${task.title}
Description:
${task.description}

Repository files for context:
${context}

Implement the task. Output files array with all files to create or replace.`;

  const { object } = await generateObject({
    model: openai("gpt-4o"),
    system: fixingMode ? systemFix : systemImplement,
    prompt,
    schema: implementationSchema,
  });

  return object.files;
}

async function generateStructuredFixImplementation(
  task: Task,
  context: string,
  issues: StructuredReviewIssue[],
  summary: string,
  githubSupplement?: string
): Promise<FileChange[]> {
  const issueList = formatStructuredIssuesForFixPrompt(issues);
  const supplementBlock = githubSupplement?.trim()
    ? `\n\nSupplementary context (lower priority — GitHub PR thread):\n${githubSupplement.trim().slice(0, 12_000)}\n`
    : "";

  const system = `You are fixing an existing pull request. Output a JSON object with a "files" array containing objects with "path" and "content" (full file contents) for each modified file only.

Rules:
- Fix ONLY the numbered issues listed. Each issue specifies file, type, severity, and instruction.
- Minimal edits. No unrelated refactoring or feature additions.
- Include ONLY files you modified.
- Preserve the PR's original intent.`;

  const prompt = `Task ID: ${task.id}
Original title: ${task.title}
Summary from reviewer: ${summary}

Fix ONLY these issues:
${issueList}
${supplementBlock}
Repository files for context:
${context}

Output files array with one entry per modified file.`;

  const { object } = await generateObject({
    model: openai("gpt-4o"),
    system,
    prompt,
    schema: implementationSchema,
  });

  return object.files;
}

export async function reviewCode(diff: string): Promise<ReviewResult> {
  const system = `You are a senior code reviewer. Review the pull request diff and output a structured JSON review.

Rules:
- If status is "pass", issues MUST be empty.
- If status is "needs_work", every issue must be actionable: what to change and where.
- One issue per distinct problem. Use the repo-relative file path when possible.
- Generate a stable short id per issue (hex or slug).`;

  const prompt = `Review this pull request diff. Find bugs, missing tests, and risks.

DIFF:
${diff}`;

  const { object } = await generateObject({
    model: anthropic("claude-sonnet-4-20250514"),
    system,
    prompt,
    schema: reviewSchema,
  });

  let structuredIssues = object.issues.map((i) => ({
    ...i,
    id: i.id.trim() || issueFingerprint(i.file, i.instruction),
  }));

  if (object.status === "needs_work" && structuredIssues.length === 0) {
    const instruction =
      object.summary.trim() || "Address the problems identified in this review.";
    structuredIssues = [
      {
        id: issueFingerprint("(unspecified)", instruction),
        type: "robustness" as const,
        file: "(unspecified)",
        instruction,
        severity: "medium" as const,
      },
    ];
  }

  return {
    verdict: object.status === "pass" ? "pass" : "needs_work",
    summary: object.summary,
    structuredIssues,
  };
}
