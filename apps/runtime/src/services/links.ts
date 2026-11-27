import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { removeAssetFiles } from "../files/storage.js";
import { dropLinks, dropRuns } from "../tenants/control.js";

/** Takes a wizard's public tokens and its runs out of the control database. */
export async function forgetWizardLinks(wizardId: string) {
  const w = await db.query.wizard.findFirst({ where: eq(schema.wizard.id, wizardId) });
  const runs = await db
    .select({ id: schema.run.id, shareToken: schema.run.shareToken })
    .from(schema.run)
    .where(eq(schema.run.wizardId, wizardId));
  await dropLinks([
    ...(w ? [w.shareToken, ...(w.signalToken ? [w.signalToken] : [])] : []),
    ...runs.map((r) => r.shareToken).filter((t): t is string => Boolean(t)),
  ]);
  await dropRuns(runs.map((r) => r.id));
}

/**
 * Takes the runs a space carries away with what they made: a client's, and those of the root's
 * wizards started in it. They belong to it, though their wizards are elsewhere.
 */
export async function removeRunsIn(spaceId: string) {
  const runs = await db
    .select({ id: schema.run.id, shareToken: schema.run.shareToken })
    .from(schema.run)
    .where(eq(schema.run.clientSpaceId, spaceId));
  for (const { id } of runs) {
    await removeAssetFiles(id);
  }
  await db.delete(schema.run).where(eq(schema.run.clientSpaceId, spaceId));
  await dropLinks(runs.map((r) => r.shareToken).filter((t): t is string => Boolean(t)));
  await dropRuns(runs.map((r) => r.id));
}
