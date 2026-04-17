import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { FileChange, FileContent, ReviewResult, Task } from "../types.js";
import { config } from "../config.js";

export type LLMProvider = "openai" | "anthropic";

export interface LLMRequest {
  provider: LLMProvider;
  model: string;
  system: string;
  prompt: string;
}

const implementationSchema = z.array(
  z.object({
    path: z.string(),
    content: z.string(),
  })
);

const reviewSchema = z.object({
  verdict: z.enum(["pass", "needs_work"]),
  issues: z.array(z.string()),
  summary: z.string(),
});

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
  fileContents: FileContent[]
): Promise<FileChange[]> {
  const context = fileContents
    .map((f) => `--- ${f.path} ---\n${f.content}`)
    .join("\n\n");

  const rf = task.review_feedback?.trim() ?? "";
  const feedbackBlock =
    rf !== ""
      ? `\n\nReview feedback (address all of this — Fulbranch stored review and/or GitHub discussion):\n${rf}\n`
      : "";

  const system = `You are an expert software engineer. Respond with ONLY a valid JSON array of objects with keys "path" and "content" (full file contents). No markdown fences, no commentary.`;

  const prompt = `Task ID: ${task.id}
Title: ${task.title}
Description:
${task.description}
${feedbackBlock}

Repository files for context:
${context}

Implement the task by outputting the complete files to create or replace. JSON array format: [{"path":"relative/path.ts","content":"..."}]`;

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
  const system = `You are a senior code reviewer. Respond with ONLY a valid JSON object with keys:
- verdict: "pass" or "needs_work"
- issues: string array (empty if pass)
- summary: short string

No markdown fences, no extra text.`;

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
  return reviewSchema.parse(parsed);
}
