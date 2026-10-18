import type { WizardDefinition } from "./definition.js";

const META = ["title", "description", "avatar", "intro", "lists", "connections", "style"] as const;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Three-way merge, step by step, of a draft edited in the studio (`local`) with one written
 * elsewhere meanwhile (`remote`), both starting from `base`. What the studio changed, added or
 * removed wins; everything else is taken from `remote`.
 */
export function mergeDrafts(
  base: WizardDefinition,
  local: WizardDefinition,
  remote: WizardDefinition,
): WizardDefinition {
  const merged: WizardDefinition = { ...remote };
  for (const key of META) {
    if (!same(local[key], base[key])) {
      Object.assign(merged, { [key]: local[key] });
    }
  }
  const baseSteps = new Map(base.steps.map((s) => [s.id, s]));
  const localIds = new Set(local.steps.map((s) => s.id));
  // Removed in the studio: gone, unless the other side changed it meanwhile.
  const steps = remote.steps.filter((s) => {
    const before = baseSteps.get(s.id);
    return localIds.has(s.id) || !before || !same(before, s);
  });
  local.steps.forEach((step, i) => {
    const before = baseSteps.get(step.id);
    if (before && same(before, step)) {
      return;
    }
    const at = steps.findIndex((s) => s.id === step.id);
    if (at !== -1) {
      steps[at] = step;
      return;
    }
    // New in the studio: after the step it follows there.
    const prev = local.steps
      .slice(0, i)
      .reverse()
      .find((p) => steps.some((s) => s.id === p.id));
    steps.splice(prev ? steps.findIndex((s) => s.id === prev.id) + 1 : 0, 0, step);
  });
  return { ...merged, steps };
}
