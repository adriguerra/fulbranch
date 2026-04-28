/**
 * Minimal GitHub REST client (fetch-based).
 *
 * Surface used by the orchestrator:
 *   - GET  /repos/:owner/:repo/pulls?state=closed — reconciliation safety net
 *   - GET  /repos/:owner/:repo/pulls/:number       — inspect a single PR
 *
 * PR creation goes through the `gh` CLI (`pr.ts`)
 */

import { config } from "@/config";
import { withRetry } from "@/utils/retry";
import { logger } from "@/utils/logger";

const GITHUB_API = "https://api.github.com";
const log = logger.child({ component: "github" });

export interface GitHubPrSummary {
  number: number;
  state: "open" | "closed";
  merged_at: string | null;
  html_url: string;
  title: string;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
}

async function ghFetch<T>(path: string): Promise<T> {
  const url = `${GITHUB_API}${path}`;
  const res = await withRetry(
    async () => {
      const r = await fetch(url, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${config().githubPat}`,
          "User-Agent": "ai-dev-orchestrator",
        },
      });
      if (!r.ok) {
        throw new Error(`GitHub ${r.status} ${path}: ${await r.text()}`);
      }
      return (await r.json()) as T;
    },
    { label: `github_get ${path}`, attempts: 3 },
  );
  return res;
}

/**
 * Parse owner/repo out of REPO_URL. Supports:
 *   - https://github.com/owner/repo.git
 *   - git@github.com:owner/repo.git
 */
export function parseRepoSlug(repoUrl: string): { owner: string; repo: string } {
  const httpsMatch = repoUrl.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!httpsMatch) {
    throw new Error(`Cannot parse GitHub slug from REPO_URL: ${repoUrl}`);
  }
  return { owner: httpsMatch[1], repo: httpsMatch[2] };
}

export async function listRecentClosedPulls(limit = 50): Promise<GitHubPrSummary[]> {
  const { owner, repo } = parseRepoSlug(config().repoUrl);
  const path = `/repos/${owner}/${repo}/pulls?state=closed&per_page=${limit}&sort=updated&direction=desc`;
  const pulls = await ghFetch<GitHubPrSummary[]>(path);
  log.debug("github listRecentClosedPulls", { count: pulls.length });
  return pulls;
}

export async function getPull(prNumber: number): Promise<GitHubPrSummary> {
  const { owner, repo } = parseRepoSlug(config().repoUrl);
  return ghFetch<GitHubPrSummary>(`/repos/${owner}/${repo}/pulls/${prNumber}`);
}
