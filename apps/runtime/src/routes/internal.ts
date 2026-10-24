import { timingSafeEqual } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import { closeTenantDb, tenantDb } from "../db/client.js";
import { logs, runDetail, status, tenantModels } from "../debug.js";
import { env } from "../env.js";
import { declaredFeatures } from "../features.js";
import { removeTenantObjects } from "../files/objects.js";
import { health } from "../health.js";
import { tailQuery } from "../log.js";
import { forgetTenant, managed } from "../manage.js";
import { loadedPlugins } from "../plugins/registry.js";
import { forgetTenantRows, setTenantStatus } from "../tenants/control.js";

function fromManage(header: string | undefined): boolean {
  const given = Buffer.from(header?.replace(/^Bearer\s+/i, "") ?? "");
  const expected = Buffer.from(env.manage.serviceKey);
  return (
    managed &&
    expected.length > 0 &&
    given.length === expected.length &&
    timingSafeEqual(given, expected)
  );
}

/**
 * What the Manage-App tells this runtime about a tenant: suspend, resume, delete. Deleting
 * removes the tenant's files and everything the control database knows; the tenant's database
 * itself is deleted by whoever created it (the Manage-App, or here when it is a file).
 */
export const internalRoutes = new Hono()
  .use(async (c, next) => {
    if (!fromManage(c.req.header("authorization"))) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  })
  // --- a look from afar (docs/plans/remote-debug.md): read-only, never a key -------------
  .get("/debug/status", async (c) => c.json(await status()))
  .get("/debug/health", async (c) => c.json(await health()))
  .get("/debug/logs", (c) => c.json(logs(tailQuery((key) => c.req.query(key)))))
  .get("/debug/runs/:id", async (c) => {
    const found = await runDetail(c.req.param("id"));
    return found ? c.json(found) : c.json({ error: "not found" }, 404);
  })
  .get("/debug/tenants/:id/models", async (c) => {
    const found = await tenantModels(c.req.param("id"));
    return found ? c.json(found) : c.json({ error: "not found" }, 404);
  })
  // The plugins this runtime carries: the Manage-App offers them when a plan's modules are picked.
  .get("/plugins", (c) => {
    return c.json({
      plugins: loadedPlugins().map((p) => ({
        id: p.source.id,
        name: p.source.manifest.name ?? p.source.id,
        description: p.source.manifest.description ?? "",
        version: p.source.manifest.version ?? null,
      })),
      /** Every feature switch this runtime knows: the core's and its plugins' (under their ids). */
      features: declaredFeatures(),
    });
  })
  .post("/tenants/:id", async (c) => {
    const id = c.req.param("id");
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
      return c.json({ error: "bad tenant id" }, 400);
    }
    const { action } = z
      .object({ action: z.enum(["suspend", "resume", "delete", "holds"]) })
      .parse(await c.req.json());
    forgetTenant(id);
    if (action === "delete") {
      closeTenantDb(id);
      await removeTenantObjects(id);
      await forgetTenantRows(id);
      for (const suffix of ["", "-wal", "-shm"]) {
        await rm(join(env.dataDir, "tenants", `${id}.db${suffix}`), { force: true });
      }
      return c.json({ ok: true });
    }
    // The tenant row exists once its database was opened here.
    await tenantDb(id);
    await setTenantStatus(id, action === "suspend" ? "suspended" : "active");
    return c.json({ ok: true });
  });
