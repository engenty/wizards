import type { WizardDefinition } from "./definition.js";
import type { WorkspaceFile } from "./workspace.js";

/**
 * What changed in a draft since the version people run: the wizard's own settings, each step
 * by its title, the steps' order, the workspace's files. "Änderungen live schalten" lists it.
 */
export interface VersionChange {
  kind: "wizard" | "step" | "order" | "file";
  change: "added" | "removed" | "changed";
  /** The step's title or the file's path. */
  name?: string;
  /** What of a changed step or of the wizard itself: the definition's keys (`instructions`, `fields`). */
  parts?: string[];
}

/** A version as it runs: its definition and its workspace. */
interface Version {
  definition: WizardDefinition;
  files: Pick<WorkspaceFile, "path" | "hash">[];
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The keys whose values differ, in the order the newer one has them. */
function keysChanged(before: object, after: object): string[] {
  const was = before as Record<string, unknown>;
  const now = after as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(now), ...Object.keys(was)])];
  return keys.filter((k) => !same(was[k], now[k]));
}

/** What `after` changes of `before`: the wizard first, then its steps in their new order, then its files. */
export function versionChanges(before: Version, after: Version): VersionChange[] {
  const changes: VersionChange[] = [];
  const { steps: oldSteps, ...oldWizard } = before.definition;
  const { steps: newSteps, ...newWizard } = after.definition;
  const parts = keysChanged(oldWizard, newWizard);
  if (parts.length) {
    changes.push({ kind: "wizard", change: "changed", parts });
  }
  const old = new Map(oldSteps.map((s) => [s.id, s]));
  const now = new Set(newSteps.map((s) => s.id));
  for (const step of newSteps) {
    const was = old.get(step.id);
    if (!was) {
      changes.push({ kind: "step", change: "added", name: step.title });
    } else if (!same(was, step)) {
      changes.push({
        kind: "step",
        change: "changed",
        name: step.title,
        parts: keysChanged(was, step).filter((k) => k !== "id"),
      });
    }
  }
  for (const step of oldSteps) {
    if (!now.has(step.id)) {
      changes.push({ kind: "step", change: "removed", name: step.title });
    }
  }
  // The steps both have, in each one's order: a move is one change, however many steps moved.
  const kept = (steps: { id: string }[]) =>
    steps.map((s) => s.id).filter((id) => old.has(id) && now.has(id));
  if (!same(kept(oldSteps), kept(newSteps))) {
    changes.push({ kind: "order", change: "changed" });
  }
  const oldFiles = new Map(before.files.map((f) => [f.path, f.hash]));
  const newFiles = new Map(after.files.map((f) => [f.path, f.hash]));
  for (const [path, hash] of newFiles) {
    const was = oldFiles.get(path);
    if (was === undefined) {
      changes.push({ kind: "file", change: "added", name: path });
    } else if (was !== hash) {
      changes.push({ kind: "file", change: "changed", name: path });
    }
  }
  for (const path of oldFiles.keys()) {
    if (!newFiles.has(path)) {
      changes.push({ kind: "file", change: "removed", name: path });
    }
  }
  return changes;
}
