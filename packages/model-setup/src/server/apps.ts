import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ClientEntry } from "../catalog.js";

const APP_ROOTS = ["/Applications", join(homedir(), "Applications")];

/** Whether `<name>.app` is in one of the Mac's Applications folders. */
export function macAppPresent(name: string, roots = APP_ROOTS): boolean {
  return roots.some((root) => existsSync(join(root, `${name}.app`)));
}

/** The client's desktop app, when it is on this Mac: its name, e.g. "Claude". */
export function vendorApp(client: ClientEntry, roots = APP_ROOTS): string | null {
  if (process.platform !== "darwin" || !client.app) {
    return null;
  }
  return macAppPresent(client.app, roots) ? client.app : null;
}

/**
 * The client the setup suggests among those not installed: the one whose app is on this Mac,
 * as its subscription is most likely already paid for, else the first.
 */
export function suggestedClient<T extends { client: ClientEntry }>(missing: T[]): T | null {
  return missing.find((state) => vendorApp(state.client)) ?? missing[0] ?? null;
}
