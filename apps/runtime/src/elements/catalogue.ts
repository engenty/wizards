import type { activeSkills } from "../services/skills.js";
import { skillToolsOf } from "../tools/skills.js";
import type { ElementCaller } from "./caller.js";
import { knowledgeTools } from "./knowledge.js";
import { wizardTools } from "./wizards.js";

/**
 * The tool catalogue (docs/plans/modular.md, phase 1): the one place that turns a space's
 * elements into tools. A wizard's step, a Work chat, Goose and outside clients (MCP, the API)
 * each take their tools from here, for a caller fixed before the model sees a tool, and each call
 * goes through the broker's gate (gate.ts). The callers differ only in what they ask for.
 */

export type Skills = Awaited<ReturnType<typeof activeSkills>>;

export interface CatalogueRequest {
  /** The space's Knowledge: search, list, read pages, tables and documents. */
  knowledge?: boolean;
  /** The skills that count for the caller (the `skills` switch on); null: none. */
  skills?: Skills | null;
  /** The space's published wizards: list them, run one (`x` on the wizard). */
  wizards?: boolean;
}

/** The element tools for the caller, by what it asks for. */
export async function elementTools(
  caller: ElementCaller,
  request: CatalogueRequest,
): Promise<Record<string, any>> {
  return {
    ...(request.knowledge ? await knowledgeTools(caller) : {}),
    ...(request.skills ? skillToolsOf(request.skills, caller) : {}),
    ...(request.wizards ? await wizardTools(caller) : {}),
  };
}

/** The names the catalogue can give, for the tests that hold the callers to it. */
export const ELEMENT_TOOL_NAMES = [
  "space_search",
  "space_list",
  "page_read",
  "table_read",
  "space_document",
  "skill_load",
  "skill_read",
  "wizard_list",
  "wizard_run",
] as const;
