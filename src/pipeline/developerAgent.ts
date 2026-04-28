/**
 * Developer agent spawn.
 *
 * Runs Claude Code CLI inside the worktree with:
 *   - -p <issue-body>
 *   - --append-system-prompt-file <prompts/developer.md>
 *   - --allowedTools Read,Edit,Write,Bash,Glob
 *   - --output-format stream-json
 *   - --include-partial-messages
 *   - --exclude-dynamic-system-prompt-sections
 *
 * On subsequent cycles, reviewer feedback is prepended to the prompt under
 * a `## Review Feedback` section so the agent sees it as part of the task.
 */

import { join } from "node:path";
import { config } from "@/config";
import { runClaude, type ClaudeRunResult } from "@/integrations/claude/spawn";
import type { Issue } from "@/types/pipeline";

export interface DeveloperRunInput {
  issue: Issue;
  worktreePath: string;
  /** Non-null on retry cycles — prepended to the prompt. */
  reviewFeedback: string | null;
}

export async function runDeveloperAgent(input: DeveloperRunInput): Promise<ClaudeRunResult> {
  const cfg = config();
  const prompt = buildPrompt(input);

  return runClaude({
    cwd: input.worktreePath,
    prompt,
    systemPromptFile: join(cfg.promptsDir, "developer.md"),
    allowedTools: ["Read", "Edit", "Write", "Bash", "Glob"],
    outputFormat: "stream-json",
    includePartialMessages: true,
    issueId: input.issue.id,
    role: "dev-agent",
  });
}

function buildPrompt(input: DeveloperRunInput): string {
  const { issue, reviewFeedback } = input;
  const header = `# Task: ${issue.id} — ${stripIdPrefix(issue.title, issue.id)}`;
  const parts: string[] = [header, "", issue.description];

  if (reviewFeedback && reviewFeedback.trim() !== "") {
    parts.push(
      "",
      "---",
      "",
      "## Review Feedback",
      "",
      "Your previous attempt was reviewed and did not pass. Address each point below in this pass. Do not relitigate — fix what's asked.",
      "",
      reviewFeedback,
    );
  }

  return parts.join("\n");
}

function stripIdPrefix(title: string, id: string): string {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return title.replace(new RegExp(`^${escaped}:\\s*`), "");
}
