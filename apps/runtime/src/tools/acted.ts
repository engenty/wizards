import { outsideReaches } from "../broker/index.js";
import type { RunResources } from "../engine/resources.js";

/** The tools that only look. A tool not named here, of any origin, counts as acting. */
const ONLY_READS = new Set([
  "web_search",
  "web_fetch",
  "read_workspace_file",
  "read_document",
  "scan_documents",
  "files_list",
  "list_read",
  "page_read",
  "mail_search",
  "mail_read",
  "skill_list",
  "skill_load",
  "skill_read",
]);

/**
 * Notes when a step's model uses a tool that may have done something. A retry starts the step from
 * the top, and such a step would do it again: a mail twice, an order twice. Nothing else tells:
 * outside a durable turn tool call ids change with every try, so `run_effect` can't match them.
 */
export function watchActions(
  tools: Record<string, unknown>,
  resources: Pick<RunResources, "acted">,
) {
  for (const [name, tool] of Object.entries(tools)) {
    const reach = outsideReaches().get(name);
    if (reach ? reach.every((r) => r.kind === "read") : ONLY_READS.has(name)) {
      continue;
    }
    const t = tool as { execute?: (...args: unknown[]) => unknown };
    const execute = t.execute;
    if (typeof execute === "function") {
      t.execute = (...args: unknown[]) => {
        resources.acted = true;
        return execute.apply(t, args);
      };
    }
  }
}
