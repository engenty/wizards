import type { activeSkills } from "../services/skills.js";
import { skillToolsOf } from "../tools/skills.js";
import type { ElementCaller } from "./caller.js";
import { connectionElementTools } from "./connections.js";
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
  /**
   * The space's connections as two calls, list and call: for outside clients, whose tools are
   * fixed before a space is known. A Work chat gets one tool per action instead
   * (services/work-connections.ts), Goose the person's own sign-ins.
   */
  connections?: boolean;
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
    ...(request.connections ? await connectionElementTools(caller) : {}),
  };
}

export { ELEMENT_TOOL_NAMES } from "./specs.js";
