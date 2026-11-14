import type { Step, WizardDefinition } from "@engenty/wizards-shared/definition";
import type { ConnectionDef } from "@engenty/wizards-shared/store";
import { candidates, open } from "../connectors/index.js";
import { connectionsFor } from "../connectors/person-connections.js";
import type { StoreScope } from "../store/index.js";
import { unavoidableFrom } from "./requirements.js";

/*
 * The accounts a run asks for before it goes on (docs/plans/run-connections.md, „One card, two
 * moments“): at its start the needs of the steps every run passes, later the need of the step it
 * stands at. A need the run already has an account for asks nothing.
 */

/** The wizard's needs a step uses: an agent step lists them, a tool step calls one, a page connects one. */
export function needsOfStep(def: WizardDefinition, step: Step): ConnectionDef[] {
  const ids = new Set<string>();
  if (step.type === "agent") {
    for (const id of step.connections ?? []) {
      ids.add(id);
    }
  } else if (
    step.type === "tool" &&
    step.call &&
    "connection" in step.call &&
    step.call.connection
  ) {
    ids.add(step.call.connection);
  } else if (step.type === "form") {
    for (const field of step.fields) {
      if (field.kind === "connection" && field.connection) {
        ids.add(field.connection);
      }
    }
  }
  return (def.connections ?? []).filter((c) => ids.has(c.id));
}

/** The needs of the steps every path from `from` passes, with what is known of the answers. */
export function needsAhead(
  def: WizardDefinition,
  from: string,
  known: Record<string, unknown>,
): ConnectionDef[] {
  const ahead = unavoidableFrom(def, from, known);
  const ids = new Set(
    def.steps.filter((s) => ahead.has(s.id)).flatMap((s) => needsOfStep(def, s).map((c) => c.id)),
  );
  return (def.connections ?? []).filter((c) => ids.has(c.id));
}

/**
 * Of these needs, the ones the run has no account to use for: none, or several and none chosen.
 * A connection the definition names (`spaceConnection`) is the space's and asks here never; its
 * sign-in is the wait card's. Nor does a connector with nothing to connect.
 */
export async function unconnected(
  scope: StoreScope,
  spaceId: string,
  needs: ConnectionDef[],
): Promise<ConnectionDef[]> {
  const out: ConnectionDef[] = [];
  for (const need of needs) {
    if (need.spaceConnection || need.target) {
      continue;
    }
    const connectors = await candidates(need, spaceId);
    if (connectors.length && connectors.every(open)) {
      continue;
    }
    if (!(await connectionsFor(scope, spaceId, need)).chosen) {
      out.push(need);
    }
  }
  return out;
}
