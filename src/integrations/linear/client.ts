/**
 * Linear GraphQL client.
 *
 * Scope: the orchestrator only needs to (a) query issues by label for
 * reconciliation, (b) update issue status, and (c) append comments per
 * pipeline stage.
 */

import { config } from "@/config";
import { logger } from "@/utils/logger";
import { withRetry } from "@/utils/retry";
import type { LinearIssueData, LinearIssueRelation, LinearIssuesQueryResponse } from "@/types/linear";

const LINEAR_ENDPOINT = "https://api.linear.app/graphql";
const log = logger.child({ component: "linear" });

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await withRetry(
    async () => {
      const r = await fetch(LINEAR_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: config().linearApiKey,
        },
        body: JSON.stringify({ query, variables }),
      });
      if (!r.ok) {
        throw new Error(`Linear ${r.status}: ${await r.text()}`);
      }
      return (await r.json()) as GraphQLResponse<T>;
    },
    { label: "linear_gql", attempts: 3 },
  );

  if (res.errors && res.errors.length > 0) {
    const msg = res.errors.map((e) => e.message).join("; ");
    throw new Error(`Linear GraphQL errors: ${msg}`);
  }
  if (!res.data) throw new Error("Linear GraphQL: empty response");
  return res.data;
}

/**
 * Returns the identifiers of issues that block `issue` (i.e. must be merged
 * before `issue` can start).
 *
 * Linear's relation model is unidirectional: only the source (blocker) issue
 * holds a `blocks` relation. The target (blocked) issue exposes the same data
 * through `inverseRelations` — records where type = "blocks" and `issue` is
 * the blocker.
 */
export function extractBlockedBy(issue: LinearIssueData): string[] {
  if (!Array.isArray(issue.inverseRelations)) return [];
  return issue.inverseRelations
    .filter((r: LinearIssueRelation) => r.type === "blocks")
    .map((r: LinearIssueRelation) => r.issue.identifier)
    .filter(Boolean);
}

/**
 * List all issues carrying a given label name. Used by the reconciliation
 * loop to detect missed webhooks. Includes inverse blocking relations so that
 * dependency data is available without a separate per-issue fetch.
 */
export async function listIssuesByLabel(labelName: string): Promise<LinearIssueData[]> {
  const query = `
    query IssuesByLabel($filter: IssueFilter) {
      issues(filter: $filter, first: 250) {
        nodes {
          id
          identifier
          title
          description
          labels { nodes { id name } }
          state { name type }
          url
          inverseRelations { nodes { type issue { identifier } } }
        }
      }
    }
  `;
  const data = await gql<{
    issues: {
      nodes: Array<
        Omit<LinearIssueData, "labels" | "inverseRelations"> & {
          labels: { nodes: { id: string; name: string }[] };
          inverseRelations: { nodes: LinearIssueRelation[] };
        }
      >;
    };
  }>(query, { filter: { labels: { name: { eq: labelName } } } });

  return data.issues.nodes.map((n) => ({
    id: n.id,
    identifier: n.identifier,
    title: n.title,
    description: n.description,
    labels: n.labels.nodes,
    state: n.state,
    url: n.url,
    inverseRelations: n.inverseRelations.nodes,
  }));
}

/**
 * Move the issue to a workflow state. The orchestrator looks up state IDs
 * by name-on-team — we cache nothing across calls in v1.
 */
export async function updateIssueState(issueUuid: string, stateName: string): Promise<void> {
  // Resolve the state ID by name scoped to the issue's team.
  const stateId = await resolveStateIdForIssue(issueUuid, stateName);
  if (!stateId) {
    log.warn("state name not found on team", { issueUuid, stateName });
    return;
  }
  const mutation = `
    mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) { success }
    }
  `;
  await gql(mutation, { id: issueUuid, input: { stateId } });
  log.info("state updated", { issueUuid, stateName });
}

async function resolveStateIdForIssue(
  issueUuid: string,
  stateName: string,
): Promise<string | null> {
  const query = `
    query IssueTeamStates($id: String!) {
      issue(id: $id) {
        team {
          states { nodes { id name } }
        }
      }
    }
  `;
  const data = await gql<{
    issue: { team: { states: { nodes: Array<{ id: string; name: string }> } } } | null;
  }>(query, { id: issueUuid });

  const node = data.issue?.team.states.nodes.find(
    (s) => s.name.toLowerCase() === stateName.toLowerCase(),
  );
  return node?.id ?? null;
}

/** Append a comment to a Linear issue. */
export async function addComment(issueUuid: string, body: string): Promise<void> {
  const mutation = `
    mutation CommentCreate($input: CommentCreateInput!) {
      commentCreate(input: $input) { success }
    }
  `;
  await gql(mutation, { input: { issueId: issueUuid, body } });
  log.info("comment added", { issueUuid });
}

/** Fetch a single issue by identifier (e.g. ENG-144), including inverse blocking relations. */
export async function getIssueByIdentifier(identifier: string): Promise<LinearIssueData | null> {
  const query = `
    query IssueByIdentifier($id: String!) {
      issue(id: $id) {
        id identifier title description
        labels { nodes { id name } }
        state { name type }
        url
        inverseRelations { nodes { type issue { identifier } } }
      }
    }
  `;
  const data = await gql<{
    issue:
      | (Omit<LinearIssueData, "labels" | "inverseRelations"> & {
          labels: { nodes: { id: string; name: string }[] };
          inverseRelations: { nodes: LinearIssueRelation[] };
        })
      | null;
  }>(query, { id: identifier });
  if (!data.issue) return null;
  return {
    id: data.issue.id,
    identifier: data.issue.identifier,
    title: data.issue.title,
    description: data.issue.description,
    labels: data.issue.labels.nodes,
    state: data.issue.state,
    url: data.issue.url,
    inverseRelations: data.issue.inverseRelations.nodes,
  };
}

/**
 * Thin wrapper exporting the low-level `gql` for callers that need
 * one-off queries (e.g. reconcile paging). Keeps the http concern localized.
 */
export const linear = {
  gql,
  listIssuesByLabel,
  updateIssueState,
  addComment,
  getIssueByIdentifier,
  extractBlockedBy,
};

export type { LinearIssueData, LinearIssueRelation, LinearIssuesQueryResponse };
