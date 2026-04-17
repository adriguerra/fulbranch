export type TaskStatus =
  | "pending"
  | "in_progress"
  | "fixing"
  | "review"
  | "done"
  | "blocked";

export type ReviewIssueType = "bug" | "style" | "robustness" | "test_gap";
export type ReviewSeverity = "low" | "medium" | "high";

export interface StructuredReviewIssue {
  id: string;
  type: ReviewIssueType;
  file: string;
  instruction: string;
  severity: ReviewSeverity;
}

/** Canonical reviewer output persisted in tasks.latest_review_json */
export interface StructuredReviewRecord {
  status: "pass" | "needs_work";
  summary: string;
  issues: StructuredReviewIssue[];
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  branch_name: string | null;
  pr_url: string | null;
  pr_number: number | null;
  retries: number;
  /** Legacy flat feedback text (backward compat + PR comment fallback). */
  review_feedback: string | null;
  /** JSON serialized StructuredReviewRecord from last reviewer run */
  latest_review_json: string | null;
  /** JSON array string of issue fingerprints from last review (repeat detection) */
  review_issue_hashes: string | null;
  /** Increments when current issues overlap previous fingerprints; reset when no overlap */
  repeat_count: number;
  created_at: Date;
  updated_at: Date;
}

export interface FileContent {
  path: string;
  content: string;
}

export interface FileChange {
  path: string;
  content: string;
}

/** Normalized output from reviewer LLM after parsing legacy + structured formats */
export interface ReviewResult {
  verdict: "pass" | "needs_work";
  summary: string;
  structuredIssues: StructuredReviewIssue[];
}
