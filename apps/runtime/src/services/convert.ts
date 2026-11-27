import { toKernel } from "@engenty/wizards-shared/convert-kernel";
import { kernelOf, kernelShell } from "@engenty/wizards-shared/kernel-file";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { currentTenant } from "../tenants/tenant.js";
import { ServiceError } from "./errors.js";
import { writeFile } from "./files.js";
import { duplicateWizard, writableWizard } from "./wizards.js";

/**
 * A copy of a wizard, made of step files: the map in the file, each step a file beside it. The
 * wizard it was made from stays as it is. `notes` say what the copy does not carry over.
 */
export async function convertWizard(userId: string, wizardId: string) {
  const from = await writableWizard(userId, wizardId);
  if (kernelOf(from.draft)) {
    throw new ServiceError("invalid", "This wizard is made of step files already.");
  }
  const { file, files, notes } = toKernel(from.draft);
  const { id } = await duplicateWizard(userId, wizardId);
  const draft = kernelShell(file);
  await db
    .update(schema.wizard)
    .set({ draft, title: draft.title })
    .where(and(eq(schema.wizard.id, id), eq(schema.wizard.tenantId, currentTenant())));
  for (const [path, text] of Object.entries(files)) {
    await writeFile(userId, id, path, text, "text/plain");
  }
  return { id, notes };
}
