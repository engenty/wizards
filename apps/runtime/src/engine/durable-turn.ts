import type { StepContext } from "@engenty/wizards-engine/types";
import { tenantClient } from "../db/client.js";
import { currentTenant } from "../tenants/tenant.js";

/*
 * What is left of the runtime's part in an agent step's turn: the engine runs and saves the turn
 * (packages/engine/src/steps/agent-turn.ts), its tools work in the context made here. The sweep of
 * the snapshots an earlier Mastra turn left goes with the `mastra_workflow_*` tables (package 2.5).
 */

/** Aborts when `signal` does, except for a deploy's stop (`abort("stop")` in `stopRunner`). */
function turnSignal(signal: AbortSignal): AbortSignal {
  const own = new AbortController();
  const pass = () => {
    if (signal.reason !== "stop") {
      own.abort(signal.reason);
    }
  };
  if (signal.aborted) {
    pass();
  } else {
    signal.addEventListener("abort", pass, { once: true });
  }
  return own.signal;
}

/**
 * What a turn's tools work with. A cancel reaches them. A deploy's stop does not: what a tool would
 * make of it (an error, a person's "no") would stay in the conversation for the next runner, which
 * goes on at that call as if nothing had stopped.
 */
export function turnContext<C extends StepContext>(ctx: C, turn: string): C {
  return {
    ...ctx,
    turn,
    signal: turnSignal(ctx.signal),
    ask: async (ask) => {
      const answer = await ctx.ask(ask);
      // The wait ended because this process stops: nobody said no, the next runner asks again.
      if (ctx.signal.aborted && ctx.signal.reason === "stop") {
        await new Promise(() => undefined);
      }
      return answer;
    },
  };
}

/** Mastra's tables that hold a turn by its id, with the column it is in. */
const TURN_TABLES = [
  ["mastra_workflow_snapshot", "run_id"],
  ["mastra_workflow_run_owners", '"runId"'],
] as const;

/**
 * What a run left in Mastra's store: a turn is dropped when it ends, but a run deleted, gone back
 * from or failed in the middle of one leaves its row. Only a turn's rows carry a run's id and a dot.
 */
export async function sweepTurnSnapshots(): Promise<void> {
  const client = await tenantClient(currentTenant());
  for (const [table, column] of TURN_TABLES) {
    const there = await client.execute({
      sql: "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
      args: [table],
    });
    if (there.rows.length) {
      await client.execute(
        `DELETE FROM ${table}
          WHERE instr(${column}, '.') > 0
            AND substr(${column}, 1, instr(${column}, '.') - 1) NOT IN (SELECT id FROM run)`,
      );
    }
  }
}
