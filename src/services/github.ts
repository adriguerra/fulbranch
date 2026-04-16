import { Octokit } from "@octokit/rest";
import type { FileChange, FileContent } from "../types.js";
import { config } from "../config.js";

function octokit(): Octokit {
  return new Octokit({ auth: config.github.token() });
}

function repoParams() {
  return {
    owner: config.github.owner(),
    repo: config.github.repo(),
  };
}

export async function createBranch(branchName: string): Promise<void> {
  const api = octokit();
  const { owner, repo } = repoParams();
  const base = config.github.defaultBranch;
  const { data: refData } = await api.rest.git.getRef({
    owner,
    repo,
    ref: `heads/${base}`,
  });
  const sha = refData.object.sha;
  await api.rest.git.createRef({
    owner,
    repo,
    ref: `refs/heads/${branchName}`,
    sha,
  });
}

export async function getFileContents(paths: string[]): Promise<FileContent[]> {
  const api = octokit();
  const { owner, repo } = repoParams();
  const ref = config.github.defaultBranch;
  const out: FileContent[] = [];
  for (const path of paths) {
    try {
      const { data } = await api.rest.repos.getContent({
        owner,
        repo,
        path,
        ref,
      });
      if (!("content" in data) || Array.isArray(data)) {
        continue;
      }
      const content = Buffer.from(data.content, "base64").toString("utf-8");
      out.push({ path, content });
    } catch (e: unknown) {
      const err = e as { status?: number };
      if (err.status === 404) {
        out.push({ path, content: "" });
        continue;
      }
      throw e;
    }
  }
  return out;
}

export async function applyFileChanges(
  branch: string,
  changes: FileChange[],
  message: string
): Promise<void> {
  const api = octokit();
  const { owner, repo } = repoParams();
  for (const change of changes) {
    let sha: string | undefined;
    try {
      const { data } = await api.rest.repos.getContent({
        owner,
        repo,
        path: change.path,
        ref: branch,
      });
      if (!Array.isArray(data) && "sha" in data) {
        sha = data.sha;
      }
    } catch (e: unknown) {
      const err = e as { status?: number };
      if (err.status !== 404) {
        throw e;
      }
    }
    await api.rest.repos.createOrUpdateFileContents({
      owner,
      repo,
      path: change.path,
      message,
      content: Buffer.from(change.content, "utf-8").toString("base64"),
      branch,
      sha,
    });
  }
}

export async function createDraftPR(
  branch: string,
  title: string,
  body: string
): Promise<{ url: string; number: number }> {
  const api = octokit();
  const { owner, repo } = repoParams();
  const base = config.github.defaultBranch;
  const { data } = await api.rest.pulls.create({
    owner,
    repo,
    title,
    head: branch,
    base,
    body,
    draft: true,
  });
  const htmlUrl = data.html_url;
  const number = data.number;
  if (!htmlUrl || number == null) {
    throw new Error("GitHub did not return PR url/number");
  }
  return { url: htmlUrl, number };
}

export async function getPRDiff(prNumber: number): Promise<string> {
  const api = octokit();
  const { owner, repo } = repoParams();
  const response = await api.request(
    "GET /repos/{owner}/{repo}/pulls/{pull_number}",
    {
      owner,
      repo,
      pull_number: prNumber,
      headers: {
        accept: "application/vnd.github.v3.diff",
      },
      responseType: "text",
    }
  );
  if (typeof response.data !== "string") {
    throw new Error("Expected diff as text from GitHub");
  }
  return response.data;
}

export async function markPRReady(prNumber: number): Promise<void> {
  const api = octokit();
  const { owner, repo } = repoParams();
  await api.rest.pulls.update({
    owner,
    repo,
    pull_number: prNumber,
    draft: false,
  });
}
