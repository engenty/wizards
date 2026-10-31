import { and, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { guestRun } from "../safety.js";

/*
 * Results that stay in the space (docs/plans/capabilities.md, A6; rule 5 of the connections
 * plan): a step of a guest's run that read a connection the space keeps for its members or admins
 * made its output with the space's data. The output is kept with the run — Ergebnisse in the
 * studio shows it — and the guest's result page and share link show a note in its place. The
 * broker's log says which step read which connection; the connection's audience is read as it is
 * now, so narrowing it afterwards keeps the results too.
 */

/** The steps of this run whose output stays in the space; empty for a member's run. */
export async function keptStepIds(run: {
  id: string;
  mode: string;
  userId: string | null;
}): Promise<Set<string>> {
  if (!guestRun(run)) {
    return new Set();
  }
  const reads = await db
    .select({ stepId: schema.brokerLog.stepId, connectionId: schema.brokerLog.connectionId })
    .from(schema.brokerLog)
    .where(
      and(
        eq(schema.brokerLog.runId, run.id),
        eq(schema.brokerLog.outcome, "allow"),
        eq(schema.brokerLog.result, "ok"),
        isNotNull(schema.brokerLog.stepId),
      ),
    );
  const connectionIds = [...new Set(reads.map((r) => r.connectionId))];
  if (!connectionIds.length) {
    return new Set();
  }
  const members = await db
    .select({ id: schema.spaceConnection.id })
    .from(schema.spaceConnection)
    .where(
      and(
        inArray(schema.spaceConnection.id, connectionIds),
        ne(schema.spaceConnection.audience, "all"),
      ),
    );
  const kept = new Set(members.map((c) => c.id));
  return new Set(reads.filter((r) => kept.has(r.connectionId)).map((r) => r.stepId as string));
}
