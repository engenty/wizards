import type { Manifest } from "@engenty/wizards-shared/wizard-package";
import * as read from "@engenty/wizards-shared/wizard-package-read";
import { ServiceError } from "./errors.js";

/**
 * Reading a `.wizard` package (`@engenty/wizards-shared/wizard-package-read`), with a package
 * that can't be read refused as a service refuses: the studio's import and `wizards validate`
 * both start here.
 */

function refused<T>(work: () => T): T {
  try {
    return work();
  } catch (err) {
    throw err instanceof read.PackageUnreadable ? new ServiceError("invalid", err.said) : err;
  }
}

export const json = (data: Uint8Array): unknown => refused(() => read.packageJson(data));

/** A manifest, or a bare definition: a wizard without workspace is fully told by its JSON. */
export const readManifest = (raw: unknown): Manifest => refused(() => read.readManifest(raw));

/** The package's content, checked against the workspace limits before anything is unpacked. */
export const readPackage = (data: Uint8Array): ReturnType<typeof read.readPackage> =>
  refused(() => read.readPackage(data));
