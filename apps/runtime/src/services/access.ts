import { AsyncLocalStorage } from "node:async_hooks";
import { note } from "@engenty/wizards-shared/run";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { managed, type Role, tenantInfo } from "../manage.js";
import { currentTenant } from "../tenants/tenant.js";
import { ServiceError } from "./errors.js";

/**
 * Who may change what on this runtime. A space a local install synced (`origin: "local"`) is
 * changed only by that install's next sync: here it is shown and run. And a tenant the
 * Manage-App gives no building (`limits.build: false`) makes and changes nothing on this
 * runtime. Every write of a space or a wizard asks here, whichever way it came in: studio,
 * MCP client or API.
 */

const sync = new AsyncLocalStorage<true>();

/** Runs the writes of a sync: they are the one way a synced space changes. */
export function asSync<T>(fn: () => T): T {
  return sync.run(true, fn);
}

const syncing = () => sync.getStore() === true;

// --- roles -----------------------------------------------------------------------------
// In an organization, an owner or admin makes and deletes (wizards, spaces, connectors); a member edits
// the wizards there are. A runtime that runs alone has one person, who does everything.

const actor = new AsyncLocalStorage<Role>();

/** Runs a request as the person's role in the tenant; set once per entry, like the tenant. */
export function asRole<T>(role: Role, fn: () => T): T {
  return actor.run(role, fn);
}

/** The role of who acts now. A context without one (a job, a sync) acts as the owner. */
export function currentRole(): Role {
  return actor.getStore() ?? "owner";
}

export const isAdminRole = (role: Role): boolean => role === "owner" || role === "admin";

export const MEMBERS_EDIT_ONLY = note("onlyOrganizationAdmins");

/** Refuses a member: making and deleting is for the owner and the admins of the organization. */
export async function requireAdmin(): Promise<void> {
  if (syncing() || !managed || isAdminRole(currentRole())) {
    return;
  }
  throw new ServiceError("forbidden", MEMBERS_EDIT_ONLY);
}

/** Whether the person makes and deletes here: builds at all, and is no mere member. */
export async function mayCreate(): Promise<boolean> {
  return (await mayBuild()) && (!managed || isAdminRole(currentRole()));
}

/** Whether the tenant builds wizards on this runtime. A runtime that runs alone always does. */
export async function mayBuild(): Promise<boolean> {
  if (!managed) {
    return true;
  }
  const info = await tenantInfo(currentTenant()).catch(() => null);
  // An older Manage-App does not say: then it builds. One that cannot be reached: nothing changes.
  return info ? info.limits.build !== false : false;
}

export const READ_ONLY_SPACE = note("spaceEditedLocally");
export const READ_ONLY_TENANT = note("wizardsRunOncePublished");

/** Refuses when the tenant builds nothing here. */
export async function requireBuild(): Promise<void> {
  if (syncing() || (await mayBuild())) {
    return;
  }
  throw new ServiceError("read_only", READ_ONLY_TENANT);
}

/** Refuses a change of a synced space, and any change by a tenant that builds nothing here. */
export async function requireWritable(space: { origin: string | null }): Promise<void> {
  if (syncing()) {
    return;
  }
  if (space.origin === "local") {
    throw new ServiceError("read_only", READ_ONLY_SPACE);
  }
  await requireBuild();
}

export async function requireWritableSpace(spaceId: string): Promise<void> {
  if (syncing()) {
    return;
  }
  const space = await db.query.space.findFirst({
    where: and(eq(schema.space.id, spaceId), eq(schema.space.tenantId, currentTenant())),
    columns: { origin: true },
  });
  // A space that is not there is the caller's "not found", not ours.
  await requireWritable(space ?? { origin: null });
}

/** Whether the person may change this space's wizards and settings here. */
export async function spaceWritable(space: { origin: string | null }): Promise<boolean> {
  return space.origin !== "local" && (await mayBuild());
}
