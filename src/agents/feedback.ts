/**
 * Combine Mainark-persisted review text with fresh GitHub PR discussion for the implementer LLM.
 */
export function mergeReviewFeedbackForImplementer(
  mainarkFeedback: string | null,
  githubAggregated: string
): string | null {
  const parts: string[] = [];
  if (mainarkFeedback?.trim()) {
    parts.push(
      `Mainark automated review (last stored):\n${mainarkFeedback.trim()}`
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
