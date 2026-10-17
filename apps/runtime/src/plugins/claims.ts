import type { PluginServerApi } from "@engenty/wizards/plugin";
import { and, eq } from "drizzle-orm";
import { control, controlDb } from "../db/client.js";
import { currentTenant } from "../tenants/tenant.js";
import { publicRefOf } from "./public.js";

/**
 * `server.claims`: keys a plugin holds across the runtime's tenants, each for one tenant at a
 * time (control `plugin_claim`). A key is the plugin's own; another plugin's of the same name is
 * another key.
 */

const MAX_KEY = 200;

function checked(key: string): string {
  if (!key || key.length > MAX_KEY) {
    throw Object.assign(new Error(`A key is 1 to ${MAX_KEY} characters.`), {
      status: 400,
      code: "invalid",
    });
  }
  return key;
}

export function claimsApiFor(plugin: string): PluginServerApi["claims"] {
  const where = (key: string) =>
    and(eq(control.pluginClaim.plugin, plugin), eq(control.pluginClaim.key, checked(key)));
  const holderOf = async (key: string) =>
    (await controlDb.query.pluginClaim.findFirst({ where: where(key) }))?.tenantId ?? null;
  return {
    async take(key) {
      const tenantId = currentTenant();
      await controlDb
        .insert(control.pluginClaim)
        .values({ plugin, key: checked(key), tenantId, updatedAt: new Date() })
        .onConflictDoNothing();
      return (await holderOf(key)) === tenantId;
    },
    async put(key) {
      const tenantId = currentTenant();
      const updatedAt = new Date();
      await controlDb
        .insert(control.pluginClaim)
        .values({ plugin, key: checked(key), tenantId, updatedAt })
        .onConflictDoUpdate({
          target: [control.pluginClaim.plugin, control.pluginClaim.key],
          set: { tenantId, updatedAt },
        });
    },
    async drop(key) {
      await controlDb
        .delete(control.pluginClaim)
        .where(and(where(key), eq(control.pluginClaim.tenantId, currentTenant())));
    },
    async holder(key) {
      const tenantId = await holderOf(key);
      return tenantId ? publicRefOf(plugin, tenantId) : null;
    },
    async mine(key) {
      return (await holderOf(key)) === currentTenant();
    },
  };
}
