import "dotenv/config";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  maxOpenPrs: Number(process.env.MAX_OPEN_PRS ?? 3),
  maxReviewRetries: Number(process.env.MAX_REVIEW_RETRIES ?? 2),
  github: {
    token: () => requireEnv("GITHUB_TOKEN"),
    owner: () => requireEnv("GITHUB_OWNER"),
    repo: () => requireEnv("GITHUB_REPO"),
    defaultBranch: process.env.GITHUB_DEFAULT_BRANCH ?? "main",
    webhookSecret: () => requireEnv("GITHUB_WEBHOOK_SECRET"),
  },
  linear: {
    webhookSecret: () => requireEnv("LINEAR_WEBHOOK_SECRET"),
    readyStateId: () => requireEnv("LINEAR_READY_STATE_ID"),
    apiKey: process.env.LINEAR_API_KEY ?? "",
  },
  llm: {
    openaiKey: () => requireEnv("OPENAI_API_KEY"),
    anthropicKey: () => requireEnv("ANTHROPIC_API_KEY"),
  },
  contextPaths: (): string[] => {
    const raw = process.env.GITHUB_CONTEXT_PATHS ?? "README.md";
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  },
};
