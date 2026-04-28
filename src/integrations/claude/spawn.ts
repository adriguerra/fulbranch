/**
 * Shared Claude Code CLI subprocess wrapper (TDD §4.2).
 *
 * Both the developer agent and reviewer agent go through this module.
 *
 * Auth (§4.1):
 *   - If ANTHROPIC_API_KEY is set → production, pay-per-token.
 *   - Else CLAUDE_CODE_OAUTH_TOKEN is used → dev/staging via subscription.
 *   The same CLI binary handles both; we just pass the env through unchanged.
 *
 * The wrapper returns structured events parsed from the CLI's
 * stream-json / json output, plus exit code. Completion signal (§2.4 Step 2):
 *   - exit 0 + `result` event with subtype=success → ok
 *   - non-zero exit OR subtype=error → fail
 */

import { spawn } from "bun";
import { logger } from "@/utils/logger";
import type { FailureKind } from "@/types/pipeline";

export interface ClaudeSpawnOptions {
  cwd: string;
  prompt: string;
  systemPromptFile: string;
  allowedTools: string[];
  outputFormat: "stream-json" | "json";
  includePartialMessages?: boolean;
  jsonSchema?: string;
  maxTurns?: number;
  timeoutMs?: number;
  /**
   * Optional Anthropic model slug (e.g. "claude-haiku-4-5"). Forwarded as
   * `--model`.
   */
  model?: string;
  /** Correlates logs back to a specific issue. */
  issueId?: string;
  /** Which agent role is running — appears as the log component. */
  role?: "dev-agent" | "reviewer-agent";
}

/**
 * Per-run token accounting. Sourced from `result` event usage block.
 * Used for measuring whether prompt-cache hits actually occur across cycles.
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  /** input + output (back-compat with the existing tokenUsage column). */
  total: number;
}

export interface ClaudeRunResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Parsed JSON (outputFormat=json) or last `result` event (outputFormat=stream-json). */
  result: unknown;
  /** Token accounting reported by the CLI, if available. */
  tokenUsage?: TokenUsage;
  /** Classified failure (only populated when ok=false). */
  failure?: FailureKind;
  timedOut: boolean;
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes per agent run.

/**
 * Build Claude Code CLI argv with the flags documented in TDD §4.2.
 *
 * The prompt is intentionally NOT included here — it is passed via stdin
 * using `-p -` to avoid E2BIG when the prompt (e.g. a large git diff) exceeds
 * the OS ARG_MAX limit for process arguments.
 */
function buildArgs(opts: ClaudeSpawnOptions): string[] {
  const args: string[] = [
    "claude",
    "-p", "-",   // read prompt from stdin
    "--append-system-prompt-file",
    opts.systemPromptFile,
    "--allowedTools",
    opts.allowedTools.join(","),
    "--dangerously-skip-permissions",
    "--output-format",
    opts.outputFormat,
    "--exclude-dynamic-system-prompt-sections",
  ];
  if (opts.outputFormat === "stream-json") args.push("--verbose");
  if (opts.includePartialMessages) args.push("--include-partial-messages");
  if (opts.jsonSchema) {
    args.push("--json-schema", opts.jsonSchema);
  }
  if (opts.maxTurns) args.push("--max-turns", String(opts.maxTurns));
  if (opts.model) args.push("--model", opts.model);
  return args;
}

export async function runClaude(opts: ClaudeSpawnOptions): Promise<ClaudeRunResult> {
  const log = logger.child({ component: opts.role ?? "claude" });
  const args = buildArgs(opts);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  log.info("claude spawn", {
    issueId: opts.issueId,
    cwd: opts.cwd,
    outputFormat: opts.outputFormat,
    allowedTools: opts.allowedTools,
  });

  const proc = spawn(args, {
    cwd: opts.cwd,
    env: {
      ...process.env,
      // Ensure the CLI inherits both auth envs; precedence (API > OAuth) is
      // enforced by the CLI itself.
    },
    // Prompt is piped via stdin (avoids E2BIG for large diffs / long prompts).
    stdin: new TextEncoder().encode(opts.prompt),
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);

  // Stream stdout line-by-line so agent activity is visible in docker logs
  // in real time rather than only appearing after the process exits.
  const [stdout, stderr, exitCode] = await Promise.all([
    streamLines(proc.stdout, opts.issueId, log),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);

  const { result, tokenUsage } = parseOutput(opts.outputFormat, stdout);

  const ok = !timedOut && exitCode === 0 && !isErrorResult(result);
  const failure = ok ? undefined : classifyFailure({
    timedOut,
    exitCode,
    result,
    stdout,
    stderr,
  });

  if (!ok) {
    log.warn("claude failed", {
      issueId: opts.issueId,
      exitCode,
      timedOut,
      failureKind: failure?.type,
      failureMessage: failure?.message,
      stdoutTail: stdout.slice(-2000) || "(empty)",
      stderrTail: stderr.slice(-1000) || "(empty)",
    });
  } else {
    log.info("claude exit", {
      issueId: opts.issueId,
      exitCode,
      timedOut,
      ok,
      // Cache telemetry (Phase 0) — lets us measure prompt-cache effectiveness
      // across cycles. Healthy run: cacheRead >> cacheCreation after cycle 1.
      tokens: tokenUsage,
    });
  }

  return { ok, exitCode, stdout, stderr, result, tokenUsage, failure, timedOut };
}

/**
 * Read a ReadableStream line by line, logging each event for real-time
 * visibility in docker logs, and return the full collected text.
 */
async function streamLines(
  stream: ReadableStream<Uint8Array>,
  issueId: string | undefined,
  log: ReturnType<typeof logger.child>,
): Promise<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  const lines: string[] = [];
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split("\n");
    buf = parts.pop() ?? "";
    for (const line of parts) {
      lines.push(line);
      logStreamEvent(line, issueId, log);
    }
  }
  if (buf) {
    lines.push(buf);
    logStreamEvent(buf, issueId, log);
  }

  return lines.join("\n");
}

/**
 * Log a single stream-json line at an appropriate level.
 * Skips partial/assistant messages to avoid log spam — only logs
 * tool use, tool results, and the final result event.
 */
function logStreamEvent(line: string, issueId: string | undefined, log: ReturnType<typeof logger.child>): void {
  const trimmed = line.trim();
  if (!trimmed) return;

  let evt: Record<string, unknown>;
  try {
    evt = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    // Non-JSON line (e.g. stray output) — log as-is at debug level.
    log.debug("claude raw", { issueId, line: trimmed.slice(0, 200) });
    return;
  }

  const type = evt.type as string | undefined;

  if (type === "assistant") {
    // Log tool_use blocks inside the assistant message.
    const msg = evt.message as Record<string, unknown> | undefined;
    const content = Array.isArray(msg?.content) ? msg.content as unknown[] : [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type === "tool_use") {
        log.info("claude tool_use", {
          issueId,
          tool: b.name,
          input: summariseInput(b.input),
        });
      } else if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
        log.info("claude text", { issueId, text: b.text.slice(0, 300) });
      }
    }
  } else if (type === "user") {
    // Tool results.
    const msg = evt.message as Record<string, unknown> | undefined;
    const content = Array.isArray(msg?.content) ? msg.content as unknown[] : [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type === "tool_result") {
        log.debug("claude tool_result", { issueId, tool_use_id: b.tool_use_id });
      }
    }
  } else if (type === "result") {
    const sub = evt.subtype as string | undefined;
    const resultText = typeof evt.result === "string" ? evt.result.slice(0, 500) : undefined;
    log.info("claude result", { issueId, subtype: sub, result: resultText });
  }
}

function summariseInput(input: unknown): string {
  if (!input || typeof input !== "object") return String(input ?? "").slice(0, 200);
  const obj = input as Record<string, unknown>;
  // For file tools, show the path.
  const path = obj.path ?? obj.file_path ?? obj.command;
  if (path) return String(path).slice(0, 200);
  return JSON.stringify(obj).slice(0, 200);
}

function parseOutput(
  format: ClaudeSpawnOptions["outputFormat"],
  stdout: string,
): { result: unknown; tokenUsage?: TokenUsage } {
  if (format === "json") {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      return { result: null };
    }
    // Single-shot JSON output may carry a top-level usage block.
    if (parsed && typeof parsed === "object") {
      const usage = readUsage(parsed as Record<string, unknown>);
      return { result: parsed, tokenUsage: usage };
    }
    return { result: parsed };
  }

  // stream-json: NDJSON events. Walk to the last `result` event and accumulate
  // token usage across all events (each turn reports its delta).
  //
  // CLI quirk: when --json-schema is passed, Claude Code registers a
  // synthetic tool named "StructuredOutput" and instructs the model to call
  // it with the schema-conformant payload. After the tool call the agent
  // typically exits, leaving the terminating `result` event with `result:""`.
  // Without special handling we'd discard a perfectly valid verdict.
  // Fix: capture the StructuredOutput tool_use input and surface it on the
  // result envelope so downstream parsing (coerceVerdict) finds it via the
  // same `obj.result` path used for non-schema runs.
  let result: unknown = null;
  let structuredOutput: unknown;
  let usage: TokenUsage | undefined;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const evt = JSON.parse(trimmed) as Record<string, unknown>;
      if (evt.type === "result") result = evt;
      if (evt.type === "assistant") {
        const so = extractStructuredOutput(evt);
        if (so !== undefined) structuredOutput = so;
      }
      const delta = readUsage(evt);
      if (delta) usage = mergeUsage(usage, delta);
    } catch {
      // Non-JSON lines (e.g. stray stderr bleed-through) are ignored.
    }
  }

  // Prefer the StructuredOutput payload over the (likely empty) terminating
  // result string. This is a no-op for runs that didn't use --json-schema.
  if (structuredOutput !== undefined && result && typeof result === "object") {
    (result as Record<string, unknown>).result = structuredOutput;
  }

  return { result, tokenUsage: usage };
}

/**
 * Look inside an `assistant` stream-json event for a tool_use block whose
 * name is `StructuredOutput`. That's the synthetic tool Claude Code uses to
 * deliver a `--json-schema`-validated payload from the model. Returns the
 * tool's input object, or undefined if no such tool call is present.
 */
function extractStructuredOutput(evt: Record<string, unknown>): unknown {
  const msg = evt.message as Record<string, unknown> | undefined;
  const content = Array.isArray(msg?.content) ? (msg.content as unknown[]) : [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "tool_use" && b.name === "StructuredOutput" && b.input !== undefined) {
      return b.input;
    }
  }
  return undefined;
}

/**
 * Pull a usage block out of any event shape Claude Code emits.
 * Possible shapes:
 *   - evt.usage = { input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens }
 *   - evt.message.usage = { ... }
 *   - evt.result.usage = { ... } (final `result` event)
 */
function readUsage(evt: Record<string, unknown>): TokenUsage | undefined {
  const candidates: unknown[] = [
    evt.usage,
    (evt.message as Record<string, unknown> | undefined)?.usage,
  ];
  for (const c of candidates) {
    if (c && typeof c === "object") {
      const u = c as Record<string, unknown>;
      const input = numOrZero(u.input_tokens);
      const output = numOrZero(u.output_tokens);
      const cacheCreation = numOrZero(u.cache_creation_input_tokens);
      const cacheRead = numOrZero(u.cache_read_input_tokens);
      // Skip empty usage blocks (some events emit zeros).
      if (input + output + cacheCreation + cacheRead === 0) continue;
      return {
        inputTokens: input,
        outputTokens: output,
        cacheCreationInputTokens: cacheCreation,
        cacheReadInputTokens: cacheRead,
        total: input + output,
      };
    }
  }
  return undefined;
}

function numOrZero(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function mergeUsage(a: TokenUsage | undefined, b: TokenUsage): TokenUsage {
  if (!a) return b;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
    total: a.total + b.total,
  };
}

function isErrorResult(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const obj = result as Record<string, unknown>;
  const subtype = obj.subtype;
  if (subtype === "error") return true;
  // is_error: true on `result` events with success subtype indicates the
  // model produced output but signalled an error condition (e.g. rate limit).
  if (obj.is_error === true) return true;
  return false;
}

/**
 * Classify the failure mode from the result event so the pipeline can
 * route to retry vs. permanent fail (Phase 1b).
 *
 * Heuristics:
 *   - timedOut wins regardless of exitCode
 *   - api_error_status === 429 → rate_limit
 *   - api_error_status === 401 → auth
 *   - error: "rate_limit" in result content → rate_limit (no api_error_status)
 *   - non-zero exit with empty result → agent_error (often a CLI startup issue)
 *   - everything else with non-zero exit → agent_error
 *
 * Note: schema_invalid is not produced here — it's emitted by reviewerAgent
 * when JSON parsing fails. We expose the type so callers can construct it.
 */
function classifyFailure(input: {
  timedOut: boolean;
  exitCode: number;
  result: unknown;
  stdout: string;
  stderr: string;
}): FailureKind {
  if (input.timedOut) {
    return { type: "timeout", message: "Agent run exceeded timeout" };
  }

  const result = input.result as Record<string, unknown> | null;
  const apiStatus = result?.api_error_status;
  const errorTag = result?.error ?? (result?.message as Record<string, unknown> | undefined)?.error;
  const resultText = typeof result?.result === "string" ? (result.result as string) : "";

  if (apiStatus === 429 || errorTag === "rate_limit" || /you've hit your limit/i.test(resultText)) {
    return {
      type: "rate_limit",
      message: resultText || "Anthropic rate limit reached",
      resetsAt: parseRateLimitReset(resultText),
    };
  }

  if (apiStatus === 401 || errorTag === "authentication_error" || /invalid bearer token/i.test(resultText)) {
    return {
      type: "auth",
      message: resultText || "Anthropic authentication failed",
    };
  }

  // Network-ish failures — heuristic match on stderr for connection errors.
  if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED/i.test(input.stderr)) {
    return { type: "network", message: input.stderr.slice(-500) };
  }

  return {
    type: "agent_error",
    message: resultText || input.stderr.slice(-500) || `Exit ${input.exitCode}`,
  };
}

/**
 * Best-effort: pull a JS Date out of a "resets HH:MMam/pm (UTC)" string
 * embedded in the rate-limit message Claude emits. Returns null if we can't.
 */
function parseRateLimitReset(text: string): Date | null {
  const m = text.match(/resets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(?(?:UTC|utc)\)?/i);
  if (!m) return null;
  let hour = parseInt(m[1]!, 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  const meridiem = m[3]!.toLowerCase();
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  const now = new Date();
  // Build a Date at HH:MM UTC today. If that's already past, advance one day.
  const candidate = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    hour,
    minute,
    0,
    0,
  ));
  if (candidate.getTime() <= now.getTime()) {
    candidate.setUTCDate(candidate.getUTCDate() + 1);
  }
  return candidate;
}

/**
 * Pull the agent's concluding text out of the `result` event that Claude Code
 * emits at the end of a stream-json run. Returns null if not present.
 *
 * Shape: { type: "result", subtype: "success", result: "<text>", ... }
 */
export function extractAgentMessage(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const text = (result as Record<string, unknown>).result;
  return typeof text === "string" && text.trim() ? text.trim() : null;
}
