import type { StepData } from "@engenty/wizards-shared/definition";
import { isReadSql } from "@engenty/wizards-shared/wizard-data";
import { stepCaller } from "../elements/caller.js";
import { NotedError } from "../model-errors.js";
import { runData } from "../store/data-access.js";
import { codeInput } from "./code-step.js";
import { type StepContext, StepError } from "./types.js";

/**
 * A fixed step's statement on the wizard's own database (`data` on a tool or code step): SQL the
 * wizard wrote, its parameters bound from the run's values (a path for the raw value, a template
 * for text), never spliced. It runs as the wizard, so in a guest's run it may reach the shared
 * database (docs/plans/wizard-data.md, decision 4); the broker decides it and logs it.
 */
export async function runStepData(
  data: StepData,
  ctx: StepContext,
): Promise<{
  rows: Record<string, unknown>[];
  count: number;
  changes: number;
  lastId: number | null;
  truncated?: true;
}> {
  const mode = isReadSql(data.sql) ? "read" : "write";
  if (mode === "write") {
    // What a write did, a later try of the step would do again.
    ctx.resources.acted = true;
  }
  try {
    const r = await runData(
      stepCaller(ctx),
      { def: ctx.def, files: ctx.files, store: ctx.store },
      {
        action: "data_step",
        by: "wizard",
        scope: data.scope,
        sql: data.sql,
        params: codeInput(data.params, ctx),
        mode,
      },
    );
    return {
      rows: r.rows,
      count: r.rows.length,
      changes: r.changes,
      lastId: r.lastId,
      ...(r.truncated ? { truncated: true as const } : {}),
    };
  } catch (err) {
    if (err instanceof NotedError && !(err instanceof StepError)) {
      throw new StepError(err.note ?? err.message);
    }
    throw err;
  }
}
