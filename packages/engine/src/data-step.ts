import type { StepData } from "@engenty/wizards-shared/definition";
import type { DataStatementRequest } from "@engenty/wizards-shared/run-services";
import { isReadSql } from "@engenty/wizards-shared/wizard-data";
import { codeInput } from "./code-step.js";
import { visitEffect } from "./ids.js";
import type { StepContext } from "./types.js";

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
  const request: DataStatementRequest = {
    stepId: ctx.stepId,
    by: "wizard",
    scope: data.scope,
    sql: data.sql,
    // A path binds the run's raw value as it is.
    params: codeInput(data.params, ctx) as DataStatementRequest["params"],
  };
  // A write happens once per visit of the step: a restart finds what it wrote.
  const r = isReadSql(data.sql)
    ? await ctx.services.data.query(request)
    : await ctx.services.data.exec({ ...request, effect: visitEffect(ctx) });
  return {
    rows: r.rows,
    count: r.rows.length,
    changes: r.changes,
    lastId: r.lastId,
    ...(r.truncated ? { truncated: true as const } : {}),
  };
}
