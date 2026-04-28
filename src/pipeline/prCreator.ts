/**
 * Pipeline-facing PR creator.
 *
 * The GitHub-specific `git push` + `gh pr create` mechanics live in
 * integrations/github/pr.ts. This module is the pipeline's seam into that
 * work so the runPipeline code path imports from pipeline/* only.
 */

export { createPr, type CreatePrInput, type CreatePrResult } from "@/integrations/github/pr";
