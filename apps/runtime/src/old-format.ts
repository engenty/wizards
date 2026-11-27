import { kernelOf } from "@engenty/wizards-shared/kernel-file";
import { feature, remoteFeatures } from "./features.js";

// Version 0.3.0 is the format (docs/plans/kernel.md). A wizard in version 0.2.0 loads only where
// the switch `version020` is on, for a tenant that still needs one; off, nothing of it is listed,
// opened, saved or run, so no flow of the old engine runs untested.

/** Whether wizards in version 0.2.0 load for the tenant at hand. */
export async function oldFormatOn(): Promise<boolean> {
  return feature("version020", await remoteFeatures().catch(() => null));
}

/** A definition in version 0.2.0: one without the file a wizard in version 0.3.0 is. */
export const isOldFormat = (definition: { kernel?: unknown } | null | undefined): boolean =>
  !kernelOf(definition as Parameters<typeof kernelOf>[0]);

/** Whether this definition is shut out here: version 0.2.0 while its switch is off. */
export async function shutOut(definition: { kernel?: unknown } | null | undefined) {
  return isOldFormat(definition) && !(await oldFormatOn());
}
