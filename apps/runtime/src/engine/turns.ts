import type { TurnStore } from "@engenty/wizards-engine/types";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";

/** A run's agent turns in the tenant's database (`run_turn`); they go with the run. */
export function runTurns(runId: string): TurnStore {
  return {
    async load(id) {
      const row = await db.query.runTurn.findFirst({ where: eq(schema.runTurn.id, id) });
      return row?.runId === runId ? row.data : null;
    },
    async save(turn) {
      const at = new Date();
      await db
        .insert(schema.runTurn)
        .values({ id: turn.id, runId, stepId: turn.stepId, data: turn, at })
        .onConflictDoUpdate({ target: schema.runTurn.id, set: { data: turn, at } });
    },
    async drop(stepId) {
      await db
        .delete(schema.runTurn)
        .where(and(eq(schema.runTurn.runId, runId), eq(schema.runTurn.stepId, stepId)));
    },
  };
}
