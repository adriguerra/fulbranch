export type TaskStatus =
  | "pending"
  | "running"
  | "in_progress"
  | "fixing"
  | "review"
  | "done"
  | "failed"
  | "skipped"
  | "blocked";

export type TaskScope = "file" | "function" | "test" | "module";
export type MergeStrategy = "sequential" | "parallel-safe";

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
  run_id: string | null;
  logical_key: string | null;
  spec_hash: string | null;
  task_ref: string | null;
  depends_on: string[];
  owned_files: string[];
  scope: TaskScope;
  target: string | null;
  allow_parallel: boolean;
  blocked_reason: string | null;
  failure_reason: string | null;
  merge_strategy: MergeStrategy | null;
  merge_order: number | null;
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
  /** Structured implementer output (files_modified/tests_added/summary/notes) */
  agent_output_json: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface TaskEvent {
  id: number;
  task_id: string;
  run_id: string | null;
  message: string;
  created_at: Date;
}

export interface FileContent {
  path: string;
  content: string;
}

export interface FileChange {
  path: string;
  content: string;
}

export interface ImplementerOutput {
  files: FileChange[];
  files_modified: string[];
  summary: string;
  tests_added: string[];
  notes: string;
}

/** Normalized output from reviewer LLM after parsing legacy + structured formats */
export interface ReviewResult {
  verdict: "pass" | "needs_work";
  summary: string;
  structuredIssues: StructuredReviewIssue[];
}

export interface SpecTaskInput {
  id: string;
  prompt: string;
  depends_on: string[];
  owned_files: string[];
  scope: TaskScope;
  target: string | null;
  allow_parallel: boolean;
}

export interface SpecRunConfig {
  max_parallel_tasks: number;
  max_retries: number;
}

export interface SpecMergeConfig {
  strategy: MergeStrategy;
  order: string[];
}

export interface SpecDefinition {
  version: 1;
  config: SpecRunConfig;
  merge: SpecMergeConfig;
  tasks: SpecTaskInput[];
}
