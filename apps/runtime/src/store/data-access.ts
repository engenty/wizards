import type { DataScope, WizardDefinition } from "@engenty/wizards-shared/definition";
import type { WorkspaceFile } from "@engenty/wizards-shared/workspace";
import type { ElementCaller } from "../elements/caller.js";
import { elementCall, refuseCall } from "../elements/gate.js";
import { type DataResult, execData } from "./data.js";
import type { StoreScope } from "./index.js";

/**
 * The one way to a wizard's own database (docs/plans/wizard-data.md): every caller (an agent
 * step's `data_query` and `data_exec`, a fixed step's statement, and later a function tool's `db`
 * and the sandbox's API) hands its statement here with the caller the broker knows. The broker
 * decides `r` or `w` on the wizard's data, and each call is one line of its log, allowed or not.
 *
 * The guest rule (decision 4): in a guest's run a statement the model wrote reaches only that
 * person's database. The shared one is reached in a guest's run only by SQL the wizard wrote
 * (`by: "wizard"`): a sign-up can be saved, and no guest's data reaches another guest's model.
 */

/** Whose SQL it is: the model's, or the wizard's own (a fixed step, a function of its files). */
export type DataAuthor = "model" | "wizard";

export interface DataCall {
  /** The action the log names: `data_query`, `data_exec`, `data_step`. */
  action: string;
  by: DataAuthor;
  scope: DataScope;
  sql: string;
  params?: Record<string, unknown>;
  mode: "read" | "write";
}

/** The wizard whose database it is, as the run has it: its definition, files and store. */
export interface DataTarget {
  def: WizardDefinition;
  files: WorkspaceFile[];
  store: StoreScope;
}

export async function runData(
  caller: ElementCaller,
  target: DataTarget,
  call: DataCall,
): Promise<DataResult> {
  const gate = {
    action: call.action,
    resource: { kind: "data" as const, id: target.store.wizardId },
    perm: call.mode === "read" ? ("r" as const) : ("w" as const),
    // The log keeps the statement's start and the sizes of the rest, never a parameter's value.
    input: { sql: call.sql, scope: call.scope, params: call.params ?? {} },
  };
  if (call.by === "model" && call.scope === "shared" && caller.who.kind === "guest") {
    return refuseCall(caller, gate, "a guest's AI step reaches the person's own data alone");
  }
  return elementCall(caller, gate, () =>
    execData(
      { ...target, scope: call.scope },
      { sql: call.sql, params: call.params, mode: call.mode },
    ),
  );
}
