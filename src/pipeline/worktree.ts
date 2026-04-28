/**
 * Git worktree lifecycle.
 *
 *   git worktree add ../worktrees/<issue-id> -b feature/<issue-id>
 *   cd ../worktrees/<issue-id> && npm install (lang dependent)
 *
 * Worktrees live at config().worktreesDir/<issue-id> and each carries its
 * own feature branch. We do NOT pull or rebase from main during setup —
 * merge-conflict detection happens at PR creation.
 */

import { $ } from "bun";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { config } from "@/config";
import { logger } from "@/utils/logger";

const log = logger.child({ component: "worktree" });

export interface WorktreeInfo {
  issueId: string;
  branch: string;
  path: string;
  created: boolean;
}

export function branchFor(issueId: string): string {
  return `feature/${issueId}`;
}

export function worktreePathFor(issueId: string): string {
  return join(config().worktreesDir, issueId);
}

export function worktreeExists(issueId: string): boolean {
  return existsSync(worktreePathFor(issueId));
}

/**
 * Create the worktree if missing, then bootstrap the environment.
 * Idempotent: if the worktree + branch already exist (recovery case), we
 * return immediately with created=false.
 *
 * Handles the stale-branch case: if a previous failed run left behind a
 * `feature/<id>` branch with no attached worktree (e.g. container crash
 * mid-setup), the branch is deleted and recreated from origin/main so
 * every dispatch starts from a clean base.
 */
export async function createWorktree(issueId: string): Promise<WorktreeInfo> {
  const cfg = config();
  const path = worktreePathFor(issueId);
  const branch = branchFor(issueId);

  if (existsSync(path)) {
    log.info("worktree exists, reusing", { issueId, path });
    return { issueId, branch, path, created: false };
  }

  // Ensure the main clone is up to date so the new branch points at a
  // reasonable base.
  await $`git -C ${cfg.repoPath} fetch origin ${cfg.gitDefaultBranch}`.quiet();

  // If a stale branch exists with no worktree attached (left over from a
  // previous failed run), remove it so `worktree add -b` can succeed.
  const branchExists = await $`git -C ${cfg.repoPath} branch --list ${branch}`
    .quiet()
    .text()
    .then((out) => out.trim().length > 0)
    .catch(() => false);

  if (branchExists) {
    log.info("removing stale branch before worktree create", { issueId, branch });
    await $`git -C ${cfg.repoPath} branch -D ${branch}`.quiet();
  }

  await $`git -C ${cfg.repoPath} worktree add ${path} -b ${branch} origin/${cfg.gitDefaultBranch}`
    .quiet();

  log.info("worktree created", { issueId, path, branch });

  await bootstrapEnv(path);

  return { issueId, branch, path, created: true };
}

/** Bootstrap language-specific deps if a package manifest is present. */
async function bootstrapEnv(path: string): Promise<void> {
  // Heuristic: install npm/bun deps when a package.json is present.
  // Python / Go / etc. environments are assumed to be managed inside the
  // dev agent itself (it can run `pip install` or `go mod download` as
  // part of its task).
  if (existsSync(join(path, "package.json"))) {
    const pm = existsSync(join(path, "bun.lockb")) ? "bun" : "npm";
    log.info("env bootstrapping", { path, packageManager: pm });
    const startedAt = Date.now();
    try {
      if (pm === "bun") {
        await $`bun install`.cwd(path).quiet();
      } else {
        await $`npm install --prefer-offline --no-audit --no-fund`.cwd(path).quiet();
      }
      log.info("env bootstrapped", { path, durationMs: Date.now() - startedAt });
    } catch (err) {
      log.warn("env bootstrap failed (non-fatal)", {
        path,
        durationMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Remove the worktree after the PR is opened. Best-effort: log and continue
 * on failure (the next prune will clean up stale entries).
 */
export async function removeWorktree(issueId: string): Promise<void> {
  const cfg = config();
  const path = worktreePathFor(issueId);
  if (!existsSync(path)) return;

  try {
    await $`git -C ${cfg.repoPath} worktree remove --force ${path}`.quiet();
  } catch (err) {
    log.warn("git worktree remove failed, falling back to rm", {
      issueId,
      error: err instanceof Error ? err.message : String(err),
    });
    try {
      rmSync(path, { recursive: true, force: true });
    } catch (rmErr) {
      log.warn("rm fallback failed", {
        issueId,
        error: rmErr instanceof Error ? rmErr.message : String(rmErr),
      });
    }
  }

  // Keep the branch around so `gh pr create` on retry still finds it.
  // A separate cleanup could prune merged branches periodically.
  log.info("worktree removed", { issueId });
}
