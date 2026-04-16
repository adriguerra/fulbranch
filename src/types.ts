export type TaskStatus =
  | "pending"
  | "in_progress"
  | "review"
  | "done"
  | "blocked";

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  branch_name: string | null;
  pr_url: string | null;
  pr_number: number | null;
  retries: number;
  review_feedback: string | null;
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

export interface ReviewResult {
  verdict: "pass" | "needs_work";
  issues: string[];
  summary: string;
}
