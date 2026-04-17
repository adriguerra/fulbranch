/**
 * Combine Fulbranch-persisted review text with fresh GitHub PR discussion for the implementer LLM.
 */
export function mergeReviewFeedbackForImplementer(
  fulbranchFeedback: string | null,
  githubAggregated: string
): string | null {
  const parts: string[] = [];
  if (fulbranchFeedback?.trim()) {
    parts.push(
      `Fulbranch automated review (last stored):\n${fulbranchFeedback.trim()}`
    );
  }
  if (githubAggregated.trim()) {
    parts.push(
      `GitHub PR discussion (reviews, inline comments, issue thread):\n${githubAggregated.trim()}`
    );
  }
  if (parts.length === 0) {
    return null;
  }
  return parts.join("\n\n---\n\n");
}
