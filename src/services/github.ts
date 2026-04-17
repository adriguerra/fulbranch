import crypto from "node:crypto";
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

/**
 * Verify GitHub X-Hub-Signature-256: sha256=<hex> HMAC of raw body (see GitHub webhook docs).
 */
export function verifyGitHubWebhookSignature(
  rawBody: Buffer,
  headerSignature: string | undefined
): boolean {
  const secret = config.github.webhookSecret();
  if (!headerSignature || typeof headerSignature !== "string") {
    return false;
  }
  const prefix = "sha256=";
  if (!headerSignature.startsWith(prefix)) {
    return false;
  }
  const receivedHex = headerSignature.slice(prefix.length);
  let receivedBuf: Buffer;
  try {
    receivedBuf = Buffer.from(receivedHex, "hex");
  } catch {
    return false;
  }
  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest();
  if (receivedBuf.length !== expected.length) {
    return false;
  }
  return crypto.timingSafeEqual(receivedBuf, expected);
}

/** Caps recursive directory reads so LLM context stays bounded. */
const MAX_CONTEXT_FILES = 200;

type ContentItem = {
  type: string;
  path: string;
  size?: number;
};

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

function pushDecodedFile(
  path: string,
  base64Content: string,
  out: FileContent[]
): void {
  if (out.length >= MAX_CONTEXT_FILES) {
    return;
  }
  const content = Buffer.from(base64Content, "base64").toString("utf-8");
  out.push({ path, content });
}

async function walkDirectory(
  api: ReturnType<typeof octokit>,
  owner: string,
  repo: string,
  ref: string,
  dirPath: string,
  out: FileContent[]
): Promise<void> {
  if (out.length >= MAX_CONTEXT_FILES) {
    return;
  }
  let data: unknown;
  try {
    const res = await api.rest.repos.getContent({
      owner,
      repo,
      path: dirPath,
      ref,
    });
    data = res.data;
  } catch (e: unknown) {
    const err = e as { status?: number };
    if (err.status === 404) {
      out.push({ path: dirPath, content: "" });
      return;
    }
    throw e;
  }
  if (!Array.isArray(data)) {
    return;
  }
  const entries = [...(data as ContentItem[])].sort((a, b) =>
    a.path.localeCompare(b.path)
  );
  for (const entry of entries) {
    if (out.length >= MAX_CONTEXT_FILES) {
      break;
    }
    if (entry.type === "file") {
      const { data: fileData } = await api.rest.repos.getContent({
        owner,
        repo,
        path: entry.path,
        ref,
      });
      if (!("content" in fileData) || Array.isArray(fileData)) {
        continue;
      }
      pushDecodedFile(entry.path, fileData.content, out);
    } else if (entry.type === "dir") {
      await walkDirectory(api, owner, repo, ref, entry.path, out);
    }
  }
}

export async function getFileContents(paths: string[]): Promise<FileContent[]> {
  const api = octokit();
  const { owner, repo } = repoParams();
  const ref = config.github.defaultBranch;
  const out: FileContent[] = [];
  let truncated = false;

  for (const path of paths) {
    if (out.length >= MAX_CONTEXT_FILES) {
      truncated = true;
      break;
    }
    try {
      const { data } = await api.rest.repos.getContent({
        owner,
        repo,
        path,
        ref,
      });
      if (Array.isArray(data)) {
        await walkDirectory(api, owner, repo, ref, path, out);
        if (out.length >= MAX_CONTEXT_FILES) {
          truncated = true;
        }
        continue;
      }
      if (!("content" in data)) {
        continue;
      }
      pushDecodedFile(path, data.content, out);
    } catch (e: unknown) {
      const err = e as { status?: number };
      if (err.status === 404) {
        out.push({ path, content: "" });
        continue;
      }
      throw e;
    }
  }

  if (truncated) {
    console.warn(
      `[github] context truncated: exceeded ${MAX_CONTEXT_FILES} files (GITHUB_CONTEXT_PATHS)`
    );
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

export async function postPRComment(
  prNumber: number,
  body: string
): Promise<void> {
  const api = octokit();
  const { owner, repo } = repoParams();
  await api.rest.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body,
  });
}
