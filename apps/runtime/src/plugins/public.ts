import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { control, controlDb } from "../db/client.js";
import { env } from "../env.js";
import { currentTenant } from "../tenants/tenant.js";

/**
 * Public addresses of plugins (`server.publicUrl`): `/api/public/plugins/<plugin>/<ref>/…`. The
 * ref names the tenant without giving its id away; one per tenant and plugin, kept for good.
 * A shared route (`server.sharedUrl`) is `/api/public/plugins/<plugin>/shared/…` for every
 * tenant: a ref is 24 characters, so it is never `shared`.
 */

export const SHARED = "shared";

const rest = (path: string) => {
  const p = path.startsWith("/") ? path : `/${path}`;
  return p === "/" ? "" : p;
};

/** The full address of a plugin's public route for the current tenant. */
export async function publicUrlOf(plugin: string, path: string): Promise<string> {
  return `${env.publicUrl}/api/public/plugins/${plugin}/${await publicRefOf(plugin)}${rest(path)}`;
}

/** The full address of a plugin's shared route. */
export function sharedUrlOf(plugin: string, path: string): string {
  return `${env.publicUrl}/api/public/plugins/${plugin}/${SHARED}${rest(path)}`;
}

/** The ref of a tenant's public address for a plugin (the current tenant's by default), made the first time. */
export async function publicRefOf(plugin: string, tenantId = currentTenant()): Promise<string> {
  const where = and(
    eq(control.pluginAddress.tenantId, tenantId),
    eq(control.pluginAddress.plugin, plugin),
  );
  let row = await controlDb.query.pluginAddress.findFirst({ where });
  if (!row) {
    await controlDb
      .insert(control.pluginAddress)
      .values({ ref: nanoid(24), tenantId, plugin })
      .onConflictDoNothing();
    row = (await controlDb.query.pluginAddress.findFirst({ where }))!;
  }
  return row.ref;
}

/** The tenant a plugin's public address belongs to. */
export async function tenantOfAddress(plugin: string, ref: string): Promise<string | null> {
  const row = await controlDb.query.pluginAddress.findFirst({
    where: eq(control.pluginAddress.ref, ref),
  });
  return row?.plugin === plugin ? row.tenantId : null;
}
