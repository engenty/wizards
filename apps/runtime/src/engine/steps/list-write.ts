import type { ListWriteInput } from "@engenty/wizards-shared/definition";
import { allFields } from "@engenty/wizards-shared/definition";
import { note } from "@engenty/wizards-shared/run";
import { whereOf } from "../../broker/call.js";
import {
  effectDone,
  effectIdOf,
  effectThrew,
  findEffect,
  startEffect,
} from "../../broker/effect.js";
import { writeList } from "../../tools/store.js";
import { renderTemplate, resolveRef } from "../template.js";
import { type StepContext, StepError } from "../types.js";

const ALONE = /^\s*\{\{([^{}]+)\}\}\s*$/;

/**
 * A cell as the step's answers fill it. A single {{ref}} is its value as it is, for the column to
 * read: a number stays one, a choice of several a list, a toggle true or false. Any other text is
 * text ("0664…" keeps its zero); empty is left out.
 */
function cell(value: unknown, ctx: StepContext): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const ref = ALONE.exec(value)?.[1]?.trim();
  if (ref) {
    const field = allFields(ctx.def).find((f) => f.id === ref);
    const raw =
      field?.kind === "toggle" ? Boolean(ctx.state.values[ref]) : resolveRef(ref, ctx.scope);
    const plain =
      typeof raw === "number" ||
      typeof raw === "boolean" ||
      (Array.isArray(raw) && raw.every((v) => typeof v === "string"));
    if (plain) {
      return raw;
    }
  }
  const text = renderTemplate(value, ctx.scope).trim();
  return text || undefined;
}

function filled(input: ListWriteInput, ctx: StepContext) {
  return {
    rows: input.rows?.map((row) =>
      Object.fromEntries(
        Object.entries(row)
          .map(([k, v]) => [k, cell(v, ctx)] as const)
          .filter(([, v]) => v !== undefined),
      ),
    ),
    delete: input.delete
      ?.map((key) => renderTemplate(key, ctx.scope).trim())
      .filter((key) => key.length > 0),
  };
}

/**
 * A tool step's `list_write`: the same write as an AI step's tool, with the wizard's input. It
 * writes once per visit of the step: a restart finds the visit's row in `run_effect` and answers
 * what the write answered. Where runs keep no such row, the step counts as acted, so a failure is
 * not tried again by itself.
 */
export async function runListWrite(input: ListWriteInput, ctx: StepContext): Promise<unknown> {
  const def = ctx.def.lists?.find((l) => l.id === input.list);
  if (!def) {
    throw new StepError(note("listWriteNoList", { list: input.list }));
  }
  const write = () => writeList(ctx, def, filled(input, ctx));
  const effectId = await effectIdOf(whereOf(ctx), { visit: ctx.state.visits?.[ctx.stepId] });
  if (!effectId) {
    ctx.resources.acted = true;
    return write();
  }
  const found = await findEffect(effectId);
  if (found?.state === "done") {
    return found.output;
  }
  const taken = await startEffect({
    id: effectId,
    runId: ctx.runId,
    stepId: ctx.stepId,
    tool: "list_write",
  });
  // Broken off between the row and the write: a row with a key is only saved again, any other
  // may be there already.
  if (!(taken || def.key)) {
    throw new StepError(note("listWriteMayHaveHappened", { title: def.title }));
  }
  const answer = await write().catch(async (err) => {
    await effectThrew(effectId, err);
    throw err;
  });
  if (answer && typeof answer === "object" && "error" in answer) {
    await effectThrew(effectId, new Error(String(answer.error)));
  } else {
    await effectDone(effectId, answer);
  }
  return answer;
}
