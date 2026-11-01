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
    send("POST", `/api/studio/spaces/${spaceId}/mounts`, { path: folder, see: "all", wizards: "all" }),
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
});
