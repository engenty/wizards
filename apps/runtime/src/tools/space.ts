import { stepCaller } from "../elements/caller.js";
import { knowledgeTools, readKnowledgePage as readPageAs } from "../elements/knowledge.js";
import type { StepContext } from "../engine/types.js";

/**
 * Knowledge, for every agent step of the space's wizards: the catalogue's Knowledge tools
 * (elements/knowledge.ts) for the run's holder and its wizard.
 */

export { pageReadInput } from "../elements/specs.js";

/** A page of Knowledge by its path, for a step: its front matter and Markdown, in parts. */
export function readKnowledgePage(
  ctx: StepContext,
  input: { path: string; section?: string; from?: number },
) {
  return readPageAs(stepCaller(ctx), input);
}

export function spaceTools(ctx: StepContext): Promise<Record<string, any>> {
  return knowledgeTools(stepCaller(ctx));
}
