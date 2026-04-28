/**
 * Linear webhook + API payload shapes.
 *
 * Only the fields the orchestrator consumes are typed — Linear's full schema
 * is much larger and we intentionally avoid depending on unused fields.
 */

export interface LinearLabel {
  id: string;
  name: string;
  color?: string;
}

/**
 * Represents one record from `inverseRelations` on an Issue.
 * When type = "blocks", `issue` is the blocker and the owning issue is the one
 * being blocked. Linear's relation model is unidirectional — the `blocks` type
 * only exists on the source (blocker) side; the target (blocked) issue exposes
 * it through `inverseRelations`.
 */
export interface LinearIssueRelation {
  type: string;               // "blocks" | "duplicate" | "related" | "similar"
  issue: {
    identifier: string;       // e.g. "ENG-142" — the source/blocker issue
  };
}

/**
 * `data` envelope shared by `Issue` webhook events (create + update).
 * See TDD §2.1 example payload.
 */
export interface LinearIssueData {
  id: string;                 // UUID
  identifier: string;         // e.g. "ENG-144"
  title: string;              // spec agent prefixes this with identifier in Pass 2
  description: string;
  labels?: LinearLabel[];
  state?: { name: string; type?: string };
  priority?: number;
  url?: string;
  inverseRelations?: LinearIssueRelation[];
}

/**
 * Top-level webhook envelope Linear POSTs to `/webhook/linear`.
 */
export interface LinearWebhookPayload {
  action: "create" | "update" | "remove";
  type: "Issue" | "Comment" | "Project" | string;
  data: LinearIssueData;
  // Linear also sends `createdAt`, `webhookTimestamp`, `organizationId`, etc.
  // Left untyped — we don't read them.
  [key: string]: unknown;
}

/** Subset of the Linear GraphQL `issues` query response used by reconciliation. */
export interface LinearIssuesQueryResponse {
  data: {
    issues: {
      nodes: LinearIssueData[];
      pageInfo?: { hasNextPage: boolean; endCursor: string };
    };
  };
}
