import { randomBytes } from "node:crypto";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { relative, resolve, sep } from "node:path";
import { featureOn } from "@engenty/wizards-shared/features";
import { and, eq, like, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, knownTenants, migrateControlDb, schema, withTenant } from "../db/client.js";
import { currentFeatures } from "../features.js";
import { addMount } from "../mounts/mounts.js";
import { addressOf, KIND } from "../mounts/source.js";
import { removeOrigin } from "../services/space-data.js";
import { CORE } from "../services/space-sources.js";
import { currentTenant } from "../tenants/tenant.js";

/**
 * `wizards move-folder-sources` — once, when Dateien and the new Wissen are on: the Sources
 * plugin's old sources of the kind `folder` become a mount of Dateien, and where one filled
 * Wissen, a source „Aus Dateien übernehmen“ on it (docs/plans/knowledge-base.md, „What changes
 * in the sources plugin“). What the old source wrote goes, but for what a person took over: that
 * stays as the space's own. The new source reads the folder again once the runtime runs. The
 * plugin's rows of a converted source go; a second run converts only what is left.
 */

interface OldSource {
  id: string;
  space_id: string;
  address: string;
  label: string;
  state: "proposed" | "taken";
  rules: string;
  categories: string;
}

const ORIGIN = "data-sourcer";

export async function moveFolderSources(): Promise<number> {
  await migrateControlDb();
  let failed = 0;
  for (const tenant of await knownTenants()) {
    failed += await withTenant(tenant, moveTenantSources);
  }
  console.log(failed ? "Done; the sources listed stay as they were." : "Done.");
  return failed ? 1 : 0;
}

async function moveTenantSources(): Promise<number> {
  const tenant = currentTenant();
  const table = await db.all<{ name: string }>(
    sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'data_sourcer_source'`,
  );
  if (!table.length) {
    return 0;
  }
  const old = await db.all<OldSource>(
    sql`SELECT * FROM data_sourcer_source WHERE kind = 'folder' ORDER BY created_at`,
  );
  if (!old.length) {
    return 0;
  }
  const features = await currentFeatures();
  if (!(featureOn(features, "dateien") && featureOn(features, "knowledgeTree"))) {
    console.log(
      `${tenant}: ${old.length} folder sources wait: switch on dateien and knowledgeTree first (wizards features).`,
    );
    return old.length;
  }
  let failed = 0;
  for (const source of old) {
    const path = resolve(source.address.replace(/^~(?=$|\/)/, homedir()));
    if (!(await stat(path).catch(() => null))?.isDirectory()) {
      console.log(`${tenant}: “${source.label}”: there is no folder ${path} on this computer.`);
      failed++;
      continue;
    }
    // A mount that holds the folder already takes it; else the folder is mounted, for admins.
    const mounts = await db.query.spaceMount.findMany({
      where: eq(schema.spaceMount.spaceId, source.space_id),
    });
    const folders = mounts.flatMap((m) =>
      m.kind === "folder" ? [{ ...m, path: (m.source as { path: string }).path }] : [],
    );
    const holding = folders.find((m) => path === m.path || path.startsWith(m.path + sep));
    const mount = holding
      ? { slug: holding.slug, name: holding.name }
      : await addMount("local", source.space_id, {
          path,
          see: [],
          wizards: "none",
          agents: "read",
        });
    const folder = holding ? relative(holding.path, path).split(sep).join("/") : "";
    const address = addressOf(mount.slug, folder);
    if (source.state === "taken") {
      await db.insert(schema.spaceSource).values({
        id: nanoid(12),
        tenantId: tenant,
        spaceId: source.space_id,
        kind: KIND,
        plugin: CORE,
        address,
        label: source.label,
        state: "taken",
        rules: JSON.parse(source.rules || "[]"),
        categories: JSON.parse(source.categories || "[]"),
        everyHours: 24,
        token: randomBytes(18).toString("base64url"),
        status: "idle",
        error: null,
        lastRunAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await dropWritten(source);
    }
    await db.run(sql`DELETE FROM data_sourcer_run WHERE source_id = ${source.id}`);
    await db.run(sql`DELETE FROM data_sourcer_entry WHERE source_id = ${source.id}`);
    await db.run(sql`DELETE FROM data_sourcer_source WHERE id = ${source.id}`);
    console.log(
      `${tenant}: “${source.label}” → Dateien › ${mount.name}${
        source.state === "taken" ? `, and Wissen takes ${address} from it` : ""
      }`,
    );
  }
  return failed;
}

/**
 * What the old source wrote, under its keys `<source>:<entry>`: what a person took over becomes
 * the space's own, the rest goes.
 */
async function dropWritten(source: OldSource) {
  const prefix = `${source.id}:%`;
  const keys = new Set<string>();
  for (const t of [schema.spacePage, schema.spaceTable, schema.spaceFile] as const) {
    const rows = await db
      .select({ key: t.originKey })
      .from(t)
      .where(and(eq(t.spaceId, source.space_id), eq(t.origin, ORIGIN), like(t.originKey, prefix)));
    for (const r of rows) {
      if (r.key) {
        keys.add(r.key);
      }
    }
  }
  for (const t of [schema.spacePage, schema.spaceTable] as const) {
    await db
      .update(t)
      .set({ origin: null, originKey: null, originLabel: null })
      .where(
        and(
          eq(t.spaceId, source.space_id),
          eq(t.origin, ORIGIN),
          eq(t.kept, true),
          like(t.originKey, prefix),
        ),
      );
  }
  for (const key of keys) {
    await removeOrigin(ORIGIN, source.space_id, key);
  }
}
