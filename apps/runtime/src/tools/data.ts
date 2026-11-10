import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { stepCaller } from "../elements/caller.js";
import type { StepContext } from "../engine/types.js";
import { getBlob } from "../files/blobs.js";
import { prompt } from "../prompts.js";
import type { DataResult } from "../store/data.js";
import { runData } from "../store/data-access.js";
import { attempt, clip } from "./shared.js";

/**
 * `data_query` and `data_exec`: an agent step's way to the wizard's own database, given when the
 * wizard declares `data` (docs/plans/wizard-data.md). Each call names its scope and goes through
 * the broker (store/data-access.ts). In a guest's run the shared database is not offered.
 */
export async function dataTools(ctx: StepContext): Promise<Record<string, any>> {
  const data = ctx.def.data;
  if (!data) {
    return {};
  }
  const guest = ctx.holder.kind === "guest";
  const scopes =
    data.scope === "shared" && !guest ? (["person", "shared"] as const) : (["person"] as const);
  const schemaFile = ctx.files.find((f) => f.path === data.schema);
  const schema = schemaFile ? clip((await getBlob(schemaFile.hash)).toString("utf8"), 6000) : "";
  const where =
    scopes.length > 1 ? prompt("tools", "note.data_scopes") : prompt("tools", "note.data_person");
  const input = z.object({
    scope: z.enum(scopes).default("person"),
    sql: z.string().min(1).max(20_000).describe("One SQL statement (SQLite)."),
    params: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .optional()
      .describe("Values for :name in the statement, bound, never written into it."),
  });
  const caller = stepCaller(ctx);
  const target = { def: ctx.def, files: ctx.files, store: ctx.store };
  const answer = (r: DataResult) => ({
    columns: r.columns,
    rows: r.rows,
    ...(r.truncated ? { truncated: true } : {}),
    ...(r.changes ? { changes: r.changes } : {}),
    ...(r.lastId !== null && r.changes ? { lastId: r.lastId } : {}),
  });
  return {
    data_query: createTool({
      id: "data_query",
      description: prompt("tools", "tool.data_query", { where, schema }),
      inputSchema: input,
      execute: ({ scope, sql, params }) =>
        attempt(async () =>
          answer(
            await runData(caller, target, {
              action: "data_query",
              by: "model",
              scope,
              sql,
              params,
              mode: "read",
            }),
          ),
        ),
    }),
    data_exec: createTool({
      id: "data_exec",
      description: prompt("tools", "tool.data_exec", { where, schema }),
      inputSchema: input,
      execute: ({ scope, sql, params }) =>
        attempt(async () => {
          const result = await runData(caller, target, {
            action: "data_exec",
            by: "model",
            scope,
            sql,
            params,
            mode: "write",
          });
          await ctx.emit("tool", { code: "remembers", params: { title: ctx.def.title } });
          return answer(result);
        }),
    }),
  };
}
