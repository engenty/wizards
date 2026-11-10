import type { ListWriteInput } from "@engenty/wizards-shared/definition";
import { allFields } from "@engenty/wizards-shared/definition";
import { renderTemplate, resolveRef } from "../template.js";
import type { StepContext } from "../types.js";

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

/** A tool step's `list_write` input, filled in from the run: what the service writes. */
export function listWriteInput(input: ListWriteInput, ctx: StepContext): ListWriteInput {
  return {
    list: input.list,
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
