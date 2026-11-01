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
    ...(w ? [w.shareToken] : []),
    ...runs.map((r) => r.shareToken).filter((t): t is string => Boolean(t)),
  ]);
  await dropRuns(runs.map((r) => r.id));
}

/**
 * Takes the runs of a client space away with what they made: they belong to it, though their
 * wizards stay the parent's (docs/plans/client-portal.md).
 */
export async function removeClientSpaceRuns(spaceId: string) {
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
