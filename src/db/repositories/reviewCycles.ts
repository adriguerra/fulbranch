/**
 * `review_cycles` repository — append-only log of reviewer verdicts per issue.
 */

import { db } from "@/db/client";
import type { ReviewCycle } from "@/types/pipeline";

interface ReviewCycleRow {
  id: number;
  issue_id: string;
  cycle_number: number;
  reviewer_verdict: "pass" | "fail";
  feedback: string;
  created_at: string;
}

function rowToReviewCycle(row: ReviewCycleRow): ReviewCycle {
  return {
    id: row.id,
    issueId: row.issue_id,
    cycleNumber: row.cycle_number,
    verdict: row.reviewer_verdict,
    feedback: row.feedback,
    createdAt: row.created_at,
  };
}

export interface AppendCycleInput {
  issueId: string;
  cycleNumber: number;
  verdict: "pass" | "fail";
  feedback: string;
}

export function appendCycle(input: AppendCycleInput): ReviewCycle {
  const row = db()
    .prepare(
      `INSERT INTO review_cycles (issue_id, cycle_number, reviewer_verdict, feedback)
       VALUES (?, ?, ?, ?)
       RETURNING *`,
    )
    .get(input.issueId, input.cycleNumber, input.verdict, input.feedback) as ReviewCycleRow;
  return rowToReviewCycle(row);
}

export function listForIssue(issueId: string): ReviewCycle[] {
  const rows = db()
    .prepare("SELECT * FROM review_cycles WHERE issue_id = ? ORDER BY cycle_number ASC")
    .all(issueId) as ReviewCycleRow[];
  return rows.map(rowToReviewCycle);
}
