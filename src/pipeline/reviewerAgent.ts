/**
 * Reviewer agent spawn.
 *
 * The reviewer has Bash + Read + Glob and is told to invoke `git diff --stat`
 * itself, drilling into specific paths only as needed. This keeps the prompt
 * static (so prompt-cache hits work cycle-to-cycle) and helps with token usage
 * optimizations.
 *
 * Failures are surfaced as typed `FailureKind`so the review loop can route 
 * schema_invalid retries vs permanent failures intelligently.
 */

import { join } from "node:path";
import { config } from "@/config";
import { runClaude, type TokenUsage } from "@/integrations/claude/spawn";
import {
  REVIEWER_VERDICT_SCHEMA_JSON,
} from "./schemas/reviewerVerdict";
import type { FailureKind, Issue, ReviewerVerdict } from "@/types/pipeline";
import { logger } from "@/utils/logger";

const log = logger.child({ component: "reviewer_agent" });

/**
 * Anthropic's small/fast model is plenty for diff reading.
 * Override via REVIEWER_MODEL if a future tuning pass shows otherwise.
 */
const REVIEWER_MODEL = process.env.REVIEWER_MODEL || "claude-haiku-4-5";

/**
 * Safety cap. Generous enough that legitimate reviews aren't
 * cut short, tight enough to halt a runaway agent that's wandering through
 * `node_modules`. The reviewer prompt also includes guidance to aim for
 * 5-10 turns; this is just the hard ceiling.
 */
const REVIEWER_MAX_TURNS = 25;

export interface ReviewerRunInput {
  issue: Issue;
  worktreePath: string;
}

/**
 * Either a verdict (success) or a FailureKind (the loop should route it).
 * Never both.
 */
export interface ReviewerRunResult {
  verdict?: ReviewerVerdict;
  failure?: FailureKind;
  tokenUsage?: TokenUsage;
}

export async function runReviewerAgent(input: ReviewerRunInput): Promise<ReviewerRunResult> {
  const cfg = config();

  const prompt = buildPrompt(input.issue);

  const run = await runClaude({
    cwd: input.worktreePath,
    prompt,
    systemPromptFile: join(cfg.promptsDir, "reviewer.md"),
    // Bash so the reviewer can run `git diff --stat`, `git diff <path>`, etc.
    allowedTools: ["Read", "Glob", "Bash"],
    outputFormat: "stream-json",
    jsonSchema: REVIEWER_VERDICT_SCHEMA_JSON,
    maxTurns: REVIEWER_MAX_TURNS,
    model: REVIEWER_MODEL,
    issueId: input.issue.id,
    timeoutMs: 10 * 60 * 1000,
    role: "reviewer-agent",
  });

  if (!run.ok) {
    // Surface the classified failure (rate_limit, timeout, auth, etc.)
    // so the review loop can route via failureRouter.
    const failure: FailureKind = run.failure ?? {
      type: "agent_error",
      message: `Reviewer exit ${run.exitCode}: ${run.stderr.slice(0, 500)}`,
    };
    log.warn("reviewer agent failed", {
      issueId: input.issue.id,
      kind: failure.type,
    });
    return { failure, tokenUsage: run.tokenUsage };
  }

  // Schema validation: even with --json-schema, the CLI sometimes returns
  // text or a malformed envelope (especially under rate limits, or when the
  // agent hits max-turns mid-tool-use and never writes a final assistant
  // message). Treat parse failures as schema_invalid so they retry instead
  // of failing hard.
  try {
    const verdict = coerceVerdict(run.result);
    log.info("reviewer verdict", {
      issueId: input.issue.id,
      verdict: verdict.verdict,
      issues: verdict.issues.length,
    });
    return { verdict, tokenUsage: run.tokenUsage };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Include a preview of what the agent actually returned so we can tell
    // empty-result (max-turns exhaustion) apart from malformed-JSON apart
    // from prose-instead-of-JSON. Also surface the result subtype + turn
    // count if the CLI exposed them.
    const diag = describeRawResult(run.result);
    log.warn("reviewer schema_invalid", {
      issueId: input.issue.id,
      error: message,
      resultSubtype: diag.subtype,
      resultLength: diag.length,
      resultPreview: diag.preview,
      numTurns: diag.numTurns,
    });
    return {
      failure: { type: "schema_invalid", message, raw: run.result },
      tokenUsage: run.tokenUsage,
    };
  }
}

/**
 * Pull diagnostic fields out of the CLI's terminating `result` event so a
 * schema_invalid warning carries enough context to debug. Handles both:
 *   - stream-json terminating event: { type:"result", subtype, result:"<text>", num_turns }
 *   - legacy json blob: same shape but parsed once at end-of-stream
 */
function describeRawResult(raw: unknown): {
  subtype: string | undefined;
  length: number | undefined;
  preview: string;
  numTurns: number | undefined;
} {
  if (!raw || typeof raw !== "object") {
    return {
      subtype: undefined,
      length: undefined,
      preview: String(raw ?? "null").slice(0, 300),
      numTurns: undefined,
    };
  }
  const obj = raw as Record<string, unknown>;
  const subtype = typeof obj.subtype === "string" ? obj.subtype : undefined;
  const numTurns = typeof obj.num_turns === "number" ? obj.num_turns : undefined;
  const text = typeof obj.result === "string" ? obj.result : undefined;
  if (text !== undefined) {
    return {
      subtype,
      length: text.length,
      preview: text.length === 0 ? "(empty)" : text.slice(0, 300),
      numTurns,
    };
  }
  // Embedded object (older json output mode) — show the JSON shape.
  return {
    subtype,
    length: undefined,
    preview: JSON.stringify(obj.result ?? obj).slice(0, 300),
    numTurns,
  };
}

function buildPrompt(issue: Issue): string {
  // Keep this prompt byte-stable across cycles for the same issue
  // so prompt caching hits. The reviewer pulls the diff itself via Bash.
  return [
    `# Review: ${issue.id} — ${issue.title.replace(new RegExp(`^${escapeRegex(issue.id)}:\\s*`), "")}`,
    "",
    "## Original ticket",
    "",
    issue.description,
    "",
    "## How to inspect the work",
    "",
    "The implementation lives in this worktree on branch `feature/" + issue.id + "`.",
    "Use Bash to inspect the diff against `main`. Recommended flow:",
    "",
    "1. `git diff main...HEAD --stat` — see what files changed and how much.",
    "2. `git diff main...HEAD -- <path>` — drill into specific files.",
    "3. `Read` / `Glob` for surrounding context in unchanged files.",
    "",
    "**Do not** read into `node_modules/`, `.next/`, `dist/`, `build/`, or generated migration SQL — those are noise.",
    "Aim to reach a verdict in 5-10 tool calls. Trust your judgement on what to inspect deeply vs. skim.",
    "",
    "Return the verdict per the JSON schema. No prose outside the JSON.",
  ].join("\n");
}

function coerceVerdict(raw: unknown): ReviewerVerdict {
  if (!raw || typeof raw !== "object") {
    throw new Error(`Reviewer returned non-object envelope: ${JSON.stringify(raw)?.slice(0, 200)}`);
  }
  const obj = raw as Record<string, unknown>;

  // Three envelopes to handle:
  //   A. outputFormat=json, top-level verdict/summary/issues (legacy)
  //      → obj has `verdict`
  //   B. outputFormat=json, JSON-schema wrapped in nested `result` object (legacy)
  //      → obj.result is an object with `verdict`
  //   C. outputFormat=stream-json terminating event (current)
  //      → obj.result is a STRING containing the JSON the agent wrote
  let candidate: Record<string, unknown>;
  if ("verdict" in obj) {
    candidate = obj;
  } else if (obj.result && typeof obj.result === "object") {
    candidate = obj.result as Record<string, unknown>;
  } else if (typeof obj.result === "string") {
    const text = obj.result.trim();
    if (!text) {
      throw new Error(
        "Reviewer produced empty result — likely hit max-turns or exited mid-tool-use without writing the verdict",
      );
    }
    candidate = parseJsonOrFenced(text);
  } else {
    throw new Error(`Reviewer envelope unrecognised: ${JSON.stringify(obj).slice(0, 200)}`);
  }

  const verdict = candidate.verdict;
  if (verdict !== "pass" && verdict !== "fail") {
    throw new Error(`Reviewer verdict must be pass|fail, got: ${String(verdict)}`);
  }
  const summary = typeof candidate.summary === "string" ? candidate.summary : "";
  const issues = Array.isArray(candidate.issues)
    ? (candidate.issues as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  return { verdict, summary, issues };
}

/**
 * Parse `text` as JSON. If it isn't bare JSON, peel one `\`\`\`json … \`\`\``
 * fence (the prompt forbids fences but the model occasionally adds one anyway).
 */
function parseJsonOrFenced(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") {
      throw new Error(`Reviewer result not a JSON object: ${text.slice(0, 200)}`);
    }
    return parsed as Record<string, unknown>;
  } catch {
    const fence = text.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
    if (fence) {
      try {
        const parsed = JSON.parse(fence[1]!);
        if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
      } catch {
        // fall through
      }
    }
    throw new Error(`Reviewer result not valid JSON: ${text.slice(0, 200)}`);
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
