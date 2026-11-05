import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import type { Where } from "./call.js";

/*
 * A stop that holds (docs/plans/capabilities-next.md, 2a): stopping a run is the revoke, there is
 * no other. Every path of the broker (`brokerCall`, `brokerHost`, `brokerSend`, `brokerSecret`)
 * asks here before anything else, whatever the connection: a run that was stopped, is done or
 * failed calls nothing more. The status is read on every call, so a step that is still under way
 * when its run is stopped is refused at its next call. A call already under way finishes: the
 * broker does not take back what has left.
 *
 * A share job is the one caller of a run that is done (`where.share`): the person sends the
 * finished result on. It is refused like any other once the run was stopped or failed.
 */

/** Why a call of a run that is over does not run, by the run's status. */
const OVER: Record<string, string> = {
  cancelled: "The run was stopped.",
  done: "The run is done.",
  failed: "The run failed.",
};

/** A run that is over, as the log names it: the rule `run.<status>` and why in words. */
export interface RunOver {
  rule: string;
  reason: string;
}

/**
 * Why this call's run takes no more calls, or null where it may go on: no run, a run under way
 * (`running`, `waiting_input`, `sleeping`), or a share job of a run that is done. A run this
 * tenant does not have is the grant's to refuse (call.ts, host.ts), not asked here.
 */
export async function runOver(where: Where): Promise<RunOver | null> {
  if (!where.runId) {
    return null;
  }
  const run = await db.query.run.findFirst({
    where: eq(schema.run.id, where.runId),
    columns: { status: true },
  });
  if (!run || (run.status === "done" && where.share)) {
    return null;
  }
  const reason = OVER[run.status];
  return reason ? { rule: `run.${run.status}`, reason } : null;
}
