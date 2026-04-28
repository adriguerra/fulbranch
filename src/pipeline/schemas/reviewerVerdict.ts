/**
 * Reviewer verdict JSON schema.
 *
 * Passed to `claude --json-schema <stringified-json>` so the CLI forces
 * structured output. The ReviewerVerdict type in types/pipeline.ts must
 * match this shape exactly.
 */

export const REVIEWER_VERDICT_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "issues"],
  properties: {
    verdict: {
      type: "string",
      enum: ["pass", "fail"],
      description: "Overall verdict against the ticket rubric.",
    },
    summary: {
      type: "string",
      minLength: 1,
      description: "One paragraph: what was built, in the reviewer's words.",
    },
    issues: {
      type: "array",
      items: {
        type: "string",
        minLength: 1,
      },
      description:
        "Actionable problems the developer agent must fix. Empty for pass.",
    },
  },
} as const;

export const REVIEWER_VERDICT_SCHEMA_JSON = JSON.stringify(REVIEWER_VERDICT_SCHEMA);
