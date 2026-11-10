import { StepError } from "@engenty/wizards-engine/types";
import { note } from "@engenty/wizards-shared/run";
import {
  type DataAnswer,
  type DataService,
  type DataStatementRequest,
  ServiceError,
} from "@engenty/wizards-shared/run-services";
import { actOnce, effectOn } from "../broker/effect.js";
import { subjectsOf } from "../broker/rwx.js";
import { stepCaller } from "../elements/caller.js";
import type { RunRow } from "../engine/types.js";
import { NotedError } from "../model-errors.js";
import { runData } from "../store/data-access.js";
import { listRows } from "../store/index.js";
import { askOf } from "../tools/code.js";
import type { InProcessContext } from "./in-process.js";

/**
 * The wizard's own database and its stored lists inside the runtime, as the run's holder may read
 * and write them. `at`: the step context under a step's id.
 */
export function dataService(
  run: RunRow,
  ctx: () => InProcessContext,
  at: (stepId: string) => InProcessContext,
): DataService {
  return {
    query: (request) => statement(at(request.stepId), request, "read"),
    exec: (request) => statement(at(request.stepId), request, "write"),
    async rows(listId) {
      const c = ctx();
      const def = run.definition.lists?.find((l) => l.id === listId);
      if (!def) {
        throw new ServiceError({ class: "final" }, `No list ${listId} in this wizard.`);
      }
      return { def, rows: await listRows(c.store, def, subjectsOf(c)) };
    },
    async counts() {
      const c = ctx();
      const who = subjectsOf(c);
      const counts: Record<string, number> = {};
      for (const def of run.definition.lists ?? []) {
        counts[def.id] = (await listRows(c.store, def, who)).length;
      }
      return counts;
    },
  };
}

/**
 * One statement on the wizard's own database, as the data tools and the data step run it. A
 * write under an effect id happens once: a repeat answers with what it wrote. Any other write
 * marks the step as having acted: what it did, a later try of the step would do again. A refusal
 * with a note fails the step with that note.
 */
async function statement(
  c: InProcessContext,
  request: DataStatementRequest,
  mode: "read" | "write",
): Promise<DataAnswer> {
  const id = mode === "write" ? await effectOn(request.effect) : null;
  if (!id) {
    if (mode === "write") {
      c.resources.acted = true;
    }
    return run(c, request, mode);
  }
  const what = c.def.steps.find((s) => s.id === request.stepId)?.title ?? request.stepId;
  const wrote = await actOnce(
    { id, runId: c.runId, stepId: request.stepId, tool: "data:exec" },
    () => run(c, request, mode),
    { ask: askOf(c), summary: what, service: c.def.title, input: { sql: request.sql } },
  );
  if ("unsure" in wrote) {
    throw new StepError(note("stepMayHaveHappened", { what }));
  }
  return wrote.done;
}

async function run(
  c: InProcessContext,
  request: DataStatementRequest,
  mode: "read" | "write",
): Promise<DataAnswer> {
  try {
    return await runData(
      stepCaller(c),
      { def: c.def, files: c.files, store: c.store },
      {
        action:
          request.by === "wizard" ? "data_step" : mode === "read" ? "data_query" : "data_exec",
        by: request.by,
        scope: request.scope,
        sql: request.sql,
        params: request.params,
        mode,
      },
    );
  } catch (err) {
    if (err instanceof NotedError) {
      throw new StepError(err.note ?? err.message);
    }
    throw err;
  }
}
