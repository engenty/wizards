import { EventEmitter } from "node:events";
import type { WizardDefinition } from "@engenty/wizards-shared/definition";

/** A change to a wizard's draft or workspace, for every studio tab that has it open. */
export interface DraftChange {
  wizardId: string;
  kind: "draft" | "files";
  revision: number;
  /** "mcp": the admin's own client, named in `client`. */
  source: "studio" | "mcp";
  client: string | null;
  note: string | null;
  /** Step ids added or changed (draft), or file paths (files). */
  touched: string[];
}

const bus = new EventEmitter();
bus.setMaxListeners(0);

export function emitDraftChanged(change: DraftChange) {
  bus.emit(change.wizardId, change);
}

export function subscribeDraft(
  wizardId: string,
  listener: (change: DraftChange) => void,
): () => void {
  bus.on(wizardId, listener);
  return () => bus.off(wizardId, listener);
}

/** Steps that are new or differ in `after`. */
export function changedSteps(before: WizardDefinition, after: WizardDefinition): string[] {
  const old = new Map(before.steps.map((s) => [s.id, JSON.stringify(s)]));
  return after.steps.filter((s) => old.get(s.id) !== JSON.stringify(s)).map((s) => s.id);
}

/** A workspace file was written or removed. Files carry no revision; the draft's is passed along. */
export function filesChanged(w: { id: string; revision: number }, path: string): DraftChange {
  return {
    wizardId: w.id,
    kind: "files",
    revision: w.revision,
    source: "studio",
    client: null,
    note: null,
    touched: [path],
  };
}
