import { ENGENTY_KINDS, type WizardDefinition } from "@engenty/wizards-shared/definition";
import { z } from "zod";

const position = {
  /** Place the step directly before this step id. */
  before: z.string().optional(),
  /** Place the step directly after this step id. */
  after: z.string().optional(),
};

export const wizardOpSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("set_meta"),
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    avatar: z.enum(ENGENTY_KINDS).optional(),
    /** null removes the intro. */
    intro: z.string().nullable().optional(),
  }),
  z.object({
    op: z.literal("upsert_step"),
    /** The complete step. Replaces the step with the same id, otherwise inserts it. */
    step: z.looseObject({ id: z.string(), type: z.string() }),
    ...position,
  }),
  /** The wizard's lists, all of them: what it keeps between runs. An empty array removes them. */
  z.object({ op: z.literal("set_lists"), lists: z.array(z.looseObject({ id: z.string() })) }),
  /** The wizard's connections, all of them: accounts the person connects. */
  z.object({
    op: z.literal("set_connections"),
    connections: z.array(z.looseObject({ id: z.string() })),
  }),
  z.object({ op: z.literal("remove_step"), stepId: z.string() }),
  z.object({ op: z.literal("move_step"), stepId: z.string(), ...position }),
]);
export type WizardOp = z.infer<typeof wizardOpSchema>;

export class OpError extends Error {}

type LooseStep = Record<string, unknown> & { id: string };

function anchorIndex(steps: LooseStep[], op: { before?: string; after?: string }, at: string) {
  if (op.before && op.after) {
    throw new OpError(`${at}: give "before" or "after", not both.`);
  }
  const ref = op.before ?? op.after;
  if (!ref) {
    return null;
  }
  const i = steps.findIndex((s) => s.id === ref);
  if (i === -1) {
    throw new OpError(`${at}: there is no step "${ref}".`);
  }
  return op.before ? i : i + 1;
}

/**
 * Applies ops in order to a copy of the draft. The result is checked against the schema by the
 * caller; here only the ops themselves can fail (unknown step, both anchors).
 */
export function applyOps(def: WizardDefinition, ops: WizardOp[]): unknown {
  const next = structuredClone(def) as Omit<WizardDefinition, "steps"> & { steps: LooseStep[] };
  ops.forEach((op, n) => {
    const at = `op ${n + 1} (${op.op})`;
    const steps = next.steps;
    switch (op.op) {
      case "set_meta": {
        const { op: _, intro, ...meta } = op;
        Object.assign(
          next,
          Object.fromEntries(Object.entries(meta).filter(([, v]) => v !== undefined)),
        );
        if (intro === null) {
          delete next.intro;
        } else if (intro !== undefined) {
          next.intro = intro;
        }
        return;
      }
      case "set_lists":
        Object.assign(next, { lists: op.lists.length ? op.lists : undefined });
        return;
      case "set_connections":
        Object.assign(next, { connections: op.connections.length ? op.connections : undefined });
        return;
      case "upsert_step": {
        const existing = steps.findIndex((s) => s.id === op.step.id);
        const anchor = anchorIndex(steps, op, at);
        if (existing !== -1 && anchor === null) {
          steps[existing] = op.step;
          return;
        }
        if (existing !== -1) {
          steps.splice(existing, 1);
        }
        const target = anchorIndex(steps, op, at);
        // New steps go before the closing result step unless placed explicitly.
        const last = steps.length - 1;
        const fallback = last >= 0 && steps[last].type === "result" ? last : steps.length;
        steps.splice(target ?? fallback, 0, op.step);
        return;
      }
      case "remove_step": {
        const i = steps.findIndex((s) => s.id === op.stepId);
        if (i === -1) {
          throw new OpError(`${at}: there is no step "${op.stepId}".`);
        }
        steps.splice(i, 1);
        return;
      }
      case "move_step": {
        const i = steps.findIndex((s) => s.id === op.stepId);
        if (i === -1) {
          throw new OpError(`${at}: there is no step "${op.stepId}".`);
        }
        if (!op.before && !op.after) {
          throw new OpError(`${at}: give "before" or "after".`);
        }
        const [step] = steps.splice(i, 1);
        steps.splice(anchorIndex(steps, op, at)!, 0, step);
        return;
      }
    }
  });
  return next;
}
