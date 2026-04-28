/**
 * Environment configuration for the orchestrator.
 *
 * Loaded once at boot and re-exported as a frozen object.
 * Validation is strict: any missing required var halts the process
 * before webhook traffic is accepted.
 *
 * Auth rules (TDD §4.1):
 *   - If ANTHROPIC_API_KEY is set, it takes precedence and the CLI bills pay-per-token.
 *   - Else CLAUDE_CODE_OAUTH_TOKEN must be set (draws from Pro/Max subscription).
 */

export interface Config {
  // HTTP
  port: number;

  // GitHub
  githubPat: string;
  repoUrl: string;
  repoPath: string;
  githubWebhookSecret: string;
  gitDefaultBranch: string;

  // Linear
  linearApiKey: string;
  linearWebhookSecret: string;

  // Slack
  slackWebhookUrl: string;

  // Claude auth — exactly one of these must be set.
  anthropicApiKey: string | undefined;
  claudeCodeOauthToken: string | undefined;

  // Tuning
  maxParallelAgents: number;
  maxReviewCycles: number;
  reconcileIntervalMs: number;

  // Auto-merge: when true, the pipeline merges the PR immediately after a
  // clean reviewer pass instead of leaving it open for human merge.
  // Flagged PRs (review cycles exhausted) are never auto-merged.
  autoMerge: boolean;
  autoMergeStrategy: "squash" | "merge" | "rebase";

  // Derived absolute paths.
  promptsDir: string;
  worktreesDir: string;
  sqlitePath: string;
}

function required(name: string): string {
  const v = Bun.env[name];
  if (!v || v.trim() === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function optional(name: string): string | undefined {
  const v = Bun.env[name];
  return v && v.trim() !== "" ? v : undefined;
}

function validateMergeStrategy(v: string | undefined): "squash" | "merge" | "rebase" {
  if (v === "merge" || v === "rebase") return v;
  return "squash"; // default
}

function intEnv(name: string, fallback: number): number {
  const v = Bun.env[name];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) {
    throw new Error(`Env var ${name} must be an integer, got: ${v}`);
  }
  return n;
}

export function loadConfig(): Config {
  const anthropicApiKey = optional("ANTHROPIC_API_KEY");
  const claudeCodeOauthToken = optional("CLAUDE_CODE_OAUTH_TOKEN");

  if (!anthropicApiKey && !claudeCodeOauthToken) {
    throw new Error(
      "Claude auth missing: set ANTHROPIC_API_KEY (prod) or CLAUDE_CODE_OAUTH_TOKEN (dev/staging).",
    );
  }

  const repoPath = Bun.env.REPO_PATH?.trim() || "/repo";

  // Worktrees live as a sibling dir of the repo per TDD §2.4 Step 1:
  //   git worktree add ../worktrees/<issue-id> -b feature/<issue-id>
  const worktreesDir = Bun.env.WORKTREES_DIR?.trim() || "/worktrees";

  const sqlitePath = Bun.env.SQLITE_PATH?.trim() || "/data/orchestrator.db";

  // prompts/ is baked into the container alongside src/.
  const promptsDir = Bun.env.PROMPTS_DIR?.trim() || new URL("../prompts", import.meta.url).pathname;

  const cfg: Config = {
    port: intEnv("PORT", 3000),

    githubPat: required("GITHUB_PAT"),
    repoUrl: required("REPO_URL"),
    repoPath,
    githubWebhookSecret: required("GITHUB_WEBHOOK_SECRET"),
    gitDefaultBranch: Bun.env.GIT_DEFAULT_BRANCH?.trim() || "main",

    linearApiKey: required("LINEAR_API_KEY"),
    linearWebhookSecret: required("LINEAR_WEBHOOK_SECRET"),

    slackWebhookUrl: required("SLACK_WEBHOOK_URL"),

    anthropicApiKey,
    claudeCodeOauthToken,

    maxParallelAgents: intEnv("MAX_PARALLEL_AGENTS", 4),
    maxReviewCycles: intEnv("MAX_REVIEW_CYCLES", 3),
    reconcileIntervalMs: intEnv("RECONCILE_INTERVAL_MS", 5 * 60 * 1000),

    autoMerge: Bun.env.AUTO_MERGE?.trim().toLowerCase() === "true",
    autoMergeStrategy: validateMergeStrategy(Bun.env.AUTO_MERGE_STRATEGY?.trim()),

    promptsDir,
    worktreesDir,
    sqlitePath,
  };

  return Object.freeze(cfg);
}

/**
 * Singleton accessor. The boot sequence calls `loadConfig()` first and every
 * subsequent module uses `config` directly.
 */
let _cfg: Config | null = null;

export function config(): Config {
  if (!_cfg) _cfg = loadConfig();
  return _cfg;
}
