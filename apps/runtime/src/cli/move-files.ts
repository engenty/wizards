import { eq, isNull } from "drizzle-orm";
import { db, knownTenants, migrateControlDb, schema, withTenant } from "../db/client.js";
import { blobThumb, putBlob } from "../files/blobs.js";
import { objects } from "../files/objects.js";

/**
 * `wizards move-files` — once, after the update to 0.16: a space file's bytes move from the
 * asset it lived in (`assets/<id>.<ext>`) to the blob store by their hash (`blobs/`), with the
 * thumbnail of a picture or PDF, for every tenant this runtime knows. Until then such a file
 * doesn't open. What moved is not moved again, so a second run moves only what the first could
 * not reach. In the cloud it runs as `node apps/runtime/dist/move-files.js`, with the runtime's
 * environment.
 */
export async function moveFiles(): Promise<number> {
  await migrateControlDb();
  let failed = 0;
  for (const tenant of await knownTenants()) {
    const { moved, missing } = await withTenant(tenant, moveTenantFiles);
    if (moved || missing.length) {
      console.log(
        `${tenant}: ${moved} moved${missing.length ? `, ${missing.length} without their bytes` : ""}`,
      );
    }
    for (const file of missing) {
      console.log(`  ${file}`);
    }
    failed += missing.length;
  }
  console.log(failed ? "Done; the files listed have no bytes to move." : "Done.");
  return failed ? 1 : 0;
}

async function moveTenantFiles() {
  const rows = await db.query.spaceFile.findMany({ where: isNull(schema.spaceFile.hash) });
  let moved = 0;
  const missing: string[] = [];
  for (const row of rows) {
    const asset = await db.query.asset.findFirst({ where: eq(schema.asset.id, row.id) });
    const bytes = asset ? await objects.get(`assets/${asset.path}`) : null;
    if (!asset || !bytes) {
      missing.push(`${row.name} (${row.id}, space ${row.spaceId})`);
      continue;
    }
    const hash = await putBlob(bytes);
    await db.update(schema.spaceFile).set({ hash }).where(eq(schema.spaceFile.id, row.id));
    // The file reads from the blob now; its asset goes.
    await db.delete(schema.asset).where(eq(schema.asset.id, asset.id));
    await objects.remove(`assets/${asset.path}`);
    await blobThumb(hash, row.mime);
    moved++;
  }
  return { moved, missing };
}
