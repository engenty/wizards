import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// „Aus Dateien übernehmen“ (docs/plans/media-and-files.md, step 8): a folder of a mount taken into
// a folder of Knowledge through the mount's reader, read as uploads are, a README as its folder's
// text; a change in the mounted folder shows in Knowledge, a file gone leaves it.

const dir = mkdtempSync(join(tmpdir(), "wizards-from-dateien-"));
process.env.DATA_DIR = join(dir, "data");
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.PLUGINS_DIR = join(dir, "plugins");
process.env.PLUGINS_WATCH = "0";
process.env.PLUGIN_JOBS = "0";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.FEATURES = "dateien=on,knowledgeTree=on";

const folder = join(dir, "Kunden");

type App = { fetch: (req: Request) => Response | Promise<Response> };
let app: App;
let cookie = "";
let spaceId = "";
let mountId = "";
let client: typeof import("../src/db/client");
let mounts: typeof import("../src/mounts/mounts");

const url = (path: string) => `http://localhost:5181${path}`;
const send = (method: string, path: string, body?: unknown) =>
  app.fetch(
    new Request(url(path), {
      method,
      headers: { cookie, "content-type": "application/json", origin: "http://localhost:5181" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
const json = async (res: Response | Promise<Response>) => {
  const r = await res;
  const body = (await r.json()) as any;
  if (!r.ok) {
    throw new Error(`${r.status} ${JSON.stringify(body)}`);
  }
  return body;
};
const local = <T>(fn: () => T | Promise<T>) => client.withTenant("local", fn);
const scan = () =>
  local(async () => {
    await mounts.scanMount(mountId);
    await mounts.flushMounts();
  });

function write(path: string, text: string) {
  mkdirSync(join(folder, path, ".."), { recursive: true });
  writeFileSync(join(folder, path), text);
}

/** Waits until no source of the space reads any more. */
async function settled() {
  for (let i = 0; i < 200; i++) {
    const { sources } = await json(send("GET", `/api/studio/spaces/${spaceId}/sources`));
    if (!sources.some((s: { running: boolean }) => s.running)) {
      return sources;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("still running");
}

const knowledge = async () =>
  (await json(send("GET", `/api/studio/spaces/${spaceId}/knowledge`))) as {
    items: { key: string; title: string; parentId: string | null; origin: string | null }[];
  };

beforeAll(async () => {
  write("Referenzen/README.md", "# Referenzen\n\nUnsere besten Projekte.");
  write("Referenzen/A1 Telekom/projekt.md", "# Glasfaser Linz\n\nAusbau für A1, 4200 Euro.");
  write("Referenzen/A1 Telekom/README.md", "Der Kunde A1 Telekom.");
  write("Referenzen/notizen.txt", "Rahmenvertrag WIN-6.");
  write("Referenzen/preise.csv", "Produkt;Preis\nGlasfaser;4200\nKupfer;900\n");
  write("Intern/geheim.md", "# Geheim\n\nNicht für Wissen.");
  client = await import("../src/db/client");
  await client.migrateControlDb();
  await client.openTenantDb("local");
  app = (await import("../src/app")).default;
  mounts = await import("../src/mounts/mounts");
  (await import("../src/mounts/source")).startFileSources();
  const entered = await app.fetch(new Request(url("/api/local/enter?k=test-key")));
  cookie = (entered.headers.get("set-cookie") ?? "").split(";")[0];
  const spaces = await import("../src/services/spaces");
  spaceId = (await local(() => spaces.defaultSpace("local"))).id;
  const mount = await json(
    send("POST", `/api/studio/spaces/${spaceId}/mounts`, { path: folder, see: ["team"], wizards: "all" }),
  );
  mountId = mount.id;
  await scan();
}, 60_000);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("Aus Dateien übernehmen", () => {
  let sourceId = "";
  let folderId = "";

  it("is a kind of the core while Dateien is on", async () => {
    const { kinds } = await json(send("GET", `/api/studio/spaces/${spaceId}/sources`));
    expect(kinds).toContainEqual({ kind: "dateien", plugin: "core", manual: false });
  });

  it("takes a folder of a mount into a folder of Knowledge", async () => {
    const proposal = await json(
      send("POST", `/api/studio/spaces/${spaceId}/sources`, {
        address: "dateien/kunden/Referenzen",
      }),
    );
    expect(proposal).toMatchObject({
      kind: "dateien",
      plugin: "core",
      address: "dateien/kunden/Referenzen",
      label: "Referenzen",
      found: 5,
      included: 5,
    });
    sourceId = proposal.id;
    const taken = await json(send("POST", `/api/studio/spaces/${spaceId}/sources/${sourceId}/take`));
    folderId = taken.folderId;
    const [source] = await settled();
    expect(source.counts).toMatchObject({ included: 5, done: 5, failed: 0 });
    const { items } = await knowledge();
    const own = items.filter((i) => i.origin === `source:${sourceId}`);
    const root = own.find((i) => i.key === `p:${folderId}`);
    expect(root?.title).toBe("Referenzen");
    const a1 = own.find((i) => i.title === "A1 Telekom");
    expect(a1?.parentId).toBe(folderId);
    expect(own.find((i) => i.title === "Glasfaser Linz")?.parentId).toBe(a1?.key.slice(2));
    expect(own.find((i) => i.key.startsWith("t:"))).toMatchObject({ title: "preise", parentId: folderId });
    expect(own.some((i) => i.title === "Geheim")).toBe(false);
    // The READMEs are their folders' texts.
    const page = async (id: string) =>
      json(send("GET", `/api/studio/pages/${id}`));
    expect((await page(folderId)).markdown).toContain("Unsere besten Projekte");
    expect((await page(a1?.key.slice(2) ?? "")).markdown).toContain("Der Kunde A1 Telekom");
  });

  it("follows a change in the mounted folder", async () => {
    write("Referenzen/A1 Telekom/projekt.md", "# Glasfaser Linz\n\nAusbau für A1, jetzt 5100 Euro.");
    write("Referenzen/neu.md", "# Neu\n\nEin neues Projekt.");
    await scan();
    await new Promise((r) => setTimeout(r, 100));
    await settled();
    const { items } = await knowledge();
    const own = items.filter((i) => i.origin === `source:${sourceId}`);
    expect(own.find((i) => i.title === "Neu")?.parentId).toBe(folderId);
    const project = own.find((i) => i.title === "Glasfaser Linz");
    const page = await json(
      send("GET", `/api/studio/pages/${project?.key.slice(2)}`),
    );
    expect(page.markdown).toContain("5100 Euro");
    rmSync(join(folder, "Referenzen/neu.md"));
    await scan();
    await new Promise((r) => setTimeout(r, 100));
    await settled();
    expect((await knowledge()).items.some((i) => i.title === "Neu")).toBe(false);
  });

  it("leaves a change outside its folder alone", async () => {
    const { source } = await json(send("GET", `/api/studio/spaces/${spaceId}/sources/${sourceId}`));
    write("Intern/geheim.md", "# Geheim\n\nImmer noch nicht.");
    await scan();
    await new Promise((r) => setTimeout(r, 100));
    await settled();
    const after = await json(send("GET", `/api/studio/spaces/${spaceId}/sources/${sourceId}`));
    expect(after.source.lastRunAt).toBe(source.lastRunAt);
  });

  it("renames the source with its folder, and the folder stays the source's", async () => {
    await json(send("PATCH", `/api/studio/pages/${folderId}`, { title: "Projekte" }));
    const { items } = (await knowledge()) as unknown as {
      items: { key: string; kept: boolean; originLabel: string | null }[];
    };
    expect(items.find((i) => i.key === `p:${folderId}`)).toMatchObject({
      kept: false,
      originLabel: "Projekte",
    });
    const { source } = await json(send("GET", `/api/studio/spaces/${spaceId}/sources/${sourceId}`));
    expect(source.label).toBe("Projekte");
  });

  it("copies one file into Knowledge, read as an upload is", async () => {
    const { files } = await json(send("GET", `/api/studio/spaces/${spaceId}/mounts/${mountId}/files`));
    const file = files.find((f: { path: string }) => f.path === "Intern/geheim.md");
    const copy = await json(
      send("POST", `/api/studio/spaces/${spaceId}/mount-files/${file.id}/knowledge`, {
        parentId: folderId,
      }),
    );
    expect(copy.name).toBe("geheim.md");
    for (let i = 0; i < 100; i++) {
      const page = (await knowledge()).items.find((x) => x.title === "Geheim");
      if (page) {
        // The space's own, in the folder it was put in.
        expect(page).toMatchObject({ origin: null, parentId: folderId });
        return;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("not read");
  });

  it("converts the Sources plugin's old folder sources by command", async () => {
    write("../Alt/handbuch.md", "# Handbuch\n\nSo geht es.");
    await local(async () => {
      const { sql } = await import("drizzle-orm");
      await client.db.run(sql`CREATE TABLE data_sourcer_source (id text PRIMARY KEY, space_id text,
        kind text, address text, label text, state text, rules text, categories text,
        every_hours integer, token text, status text, error text, last_run_at integer,
        created_at integer, updated_at integer)`);
      await client.db.run(sql`CREATE TABLE data_sourcer_entry (id text, source_id text)`);
      await client.db.run(sql`CREATE TABLE data_sourcer_run (id text, source_id text)`);
      await client.db.run(sql`INSERT INTO data_sourcer_source VALUES ('old1', ${spaceId}, 'folder',
        ${join(dir, "Alt")}, 'Altes Handbuch', 'taken', '[]', '[]', NULL, 't', 'idle', NULL, NULL,
        0, 0)`);
      await client.db.run(sql`INSERT INTO data_sourcer_entry VALUES ('e1', 'old1')`);
      const { putOriginPage } = await import("../src/services/space-data");
      await putOriginPage("data-sourcer", {
        space: spaceId,
        key: "old1:e1",
        label: "Altes Handbuch",
        title: "Handbuch alt",
        markdown: "Alt.",
      });
      await putOriginPage("data-sourcer", {
        space: spaceId,
        key: "old1:e2",
        label: "Altes Handbuch",
        title: "Behalten",
        markdown: "Von Hand geändert.",
      });
      await client.db.run(sql`UPDATE space_page SET kept = 1 WHERE title = 'Behalten'`);
    });
    const { moveFolderSources } = await import("../src/cli/move-folder-sources");
    expect(await moveFolderSources()).toBe(0);
    const { sources } = await json(send("GET", `/api/studio/spaces/${spaceId}/sources`));
    const moved = sources.find((s: { label: string }) => s.label === "Altes Handbuch");
    expect(moved).toMatchObject({ kind: "dateien", plugin: "core", address: "dateien/alt", state: "taken" });
    const { mounts: list } = await json(send("GET", `/api/studio/spaces/${spaceId}/mounts`));
    expect(list.map((m: { name: string }) => m.name)).toContain("Alt");
    let items = (await knowledge()).items;
    expect(items.some((i) => i.title === "Handbuch alt")).toBe(false);
    expect(items.find((i) => i.title === "Behalten")?.origin).toBe(null);
    // Read again by the new source.
    await local(async () => {
      const { runSource } = await import("../src/services/space-sources");
      await runSource(moved.id);
    });
    items = (await knowledge()).items;
    expect(items.find((i) => i.title === "Handbuch")?.origin).toBe(`source:${moved.id}`);
    const left = await local(async () => {
      const { sql } = await import("drizzle-orm");
      return client.db.all<{ n: number }>(sql`SELECT count(*) AS n FROM data_sourcer_source`);
    });
    expect(left[0].n).toBe(0);
  });
});
