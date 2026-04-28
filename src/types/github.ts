/**
 * GitHub webhook payload shapes used by the orchestrator.
 *
 * Only the `pull_request` event is consumed.
 */

export interface GitHubPullRequest {
  number: number;
  html_url: string;
  merged: boolean;
  merged_at: string | null;
  state: "open" | "closed";
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  title: string;
  body: string | null;
}

export interface GitHubPullRequestEvent {
  action:
    | "opened"
    | "closed"
    | "reopened"
    | "edited"
    | "synchronize"
    | "ready_for_review"
    | string;
  number: number;
  pull_request: GitHubPullRequest;
  repository: { full_name: string; default_branch: string };
  sender: { login: string };
}
