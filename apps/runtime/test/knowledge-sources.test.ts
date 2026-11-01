import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginKnowledgeSource, PluginSourceFound } from "@engenty/wizards/plugin";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Sources of Knowledge: a plugin's kind proposes a source, a person takes it, and the core reads
// it into a folder of its own — a website's paths as sub-folders, a page whose path is a folder
// as that folder's text. What a person leaves out or what went away leaves Knowledge; what a
// person took over stays when the source goes.

const dir = mkdtempSync(join(tmpdir(), "wizards-sources-"));
process.env.DATA_DIR = join(dir, "data");
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.PLUGINS_DIR = join(dir, "plugins");
process.env.PLUGINS_WATCH = "0";
process.env.PLUGIN_JOBS = "0";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";

type App = { fetch: (req: Request) => Response | Promise<Response> };
let app: App;
let cookie = "";
let spaceId = "";

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

/** What the site holds now: address → its page. */
const site = new Map<string, { title: string; text: string }>([
  ["https://ex.at/", { title: "Start", text: "Willkommen bei Ex, wir fördern Gründer." }],
  ["https://ex.at/impressum", { title: "Impressum", text: "Ex GmbH, Graz." }],
  ["https://ex.at/foerderungen/", { title: "Förderungen", text: "Alle Programme im Überblick." }],
  [
    "https://ex.at/foerderungen/start-klar",
    { title: "Start!Klar", text: "Start!Klar fördert Gründungen bis 50.000 Euro." },
  ],
  [
    "https://ex.at/foerderungen/gruendung/basis",
    { title: "Basis", text: "Basisförderung für die ersten zwei Jahre." },
  ],
]);
let reads = 0;

const website: PluginKnowledgeSource = {
  kind: "website",
  match: (address) => (/^https?:\/\//.test(address) ? address : null),
  rules: [{ pattern: "impressum", reason: "Impressum" }],
  everyHours: 24,
  reader: {
    async list() {
      return [...site.keys()].map(
        (address): PluginSourceFound => ({
          address,
          title: site.get(address)?.title,
          path: new URL(address).pathname.split("/").filter(Boolean),
        }),
      );
    },
    async read(_source, entry) {
      reads++;
      const page = site.get(entry.address);
      if (!page) {
        throw new Error("gone");
      }
      return { kind: "page", title: page.title, markdown: page.text };
    },
    async propose() {
      return {
        label: "Förderungen Ex",
        leaveOut: [{ address: "https://ex.at/", reason: "Startseite" }],
      };
    },
  },
};

beforeAll(async () => {
  const client = await import("../src/db/client");
  await client.migrateControlDb();
  await client.openTenantDb("local");
  const registry = await import("../src/plugins/registry");
  const record = registry.emptyRecord({
    id: "sourcer",
    root: dir,
    manifest: { id: "sourcer", name: "Sourcer", version: "0.1.0", kind: "module" },
  } as never);
  record.knowledgeSources.set("website", website);
  registry.setPlugin(record);
  app = (await import("../src/app")).default;
  const entered = await app.fetch(new Request(url("/api/local/enter?k=test-key")));
  cookie = (entered.headers.get("set-cookie") ?? "").split(";")[0];
  const spaces = await import("../src/services/spaces");
  spaceId = (await client.withTenant("local", () => spaces.defaultSpace("local"))).id;
}, 60_000);

afterAll(async () => {
  const registry = await import("../src/plugins/registry");
  registry.dropPlugin("sourcer");
});

/** Waits until no source of the space reads any more. */
async function settled() {
  for (let i = 0; i < 200; i++) {
    const { sources } = await json(send("GET", `/api/studio/spaces/${spaceId}/sources`));
    if (!sources.some((s: { running: boolean }) => s.running)) {
      return sources;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("still running");
}

const knowledge = async () =>
  (await json(send("GET", `/api/studio/spaces/${spaceId}/knowledge`))).items as {
    key: string;
    id: string;
    title: string;
    parentId: string | null;
    origin: string | null;
    kept: boolean;
    blank: boolean;
  }[];

describe("sources of Knowledge", () => {
  let sourceId = "";

  it("lists the kinds and proposes a source by its address", async () => {
    const { kinds } = await json(send("GET", `/api/studio/spaces/${spaceId}/sources`));
    expect(kinds).toEqual([{ kind: "website", plugin: "sourcer", manual: false }]);
    const proposal = await json(
      send("POST", `/api/studio/spaces/${spaceId}/sources`, { address: "https://ex.at/" }),
    );
    sourceId = proposal.id;
    expect(proposal).toMatchObject({
      label: "Förderungen Ex",
      kind: "website",
      state: "proposed",
      found: 5,
      included: 3,
      folderId: null,
    });
    expect(proposal.leftOut.map((l: { reason: string }) => l.reason).sort()).toEqual([
      "Impressum",
      "Startseite",
    ]);
    // Nothing is written before it is taken.
    expect((await knowledge()).length).toBe(0);
  });

  it("fills a folder of its own, a website's paths as sub-folders", async () => {
    const taken = await json(
      send("POST", `/api/studio/spaces/${spaceId}/sources/${sourceId}/take`, {}),
    );
    expect(taken.state).toBe("taken");
    const [source] = await settled();
    expect(source).toMatchObject({ status: "idle", counts: { included: 3, done: 3 } });
    expect(source.lastRun).toMatchObject({ status: "done", written: 3 });
    const items = await knowledge();
    const by = (title: string) => items.find((i) => i.title === title);
    const root = by("Förderungen Ex");
    expect(root).toMatchObject({ parentId: null, origin: `source:${sourceId}`, blank: true });
    // `/foerderungen/` is the folder of the others: it is that folder, with its text.
    expect(by("Förderungen")).toMatchObject({ parentId: root?.id, blank: false });
    expect(by("Start!Klar")?.parentId).toBe(by("Förderungen")?.id);
    expect(by("Gruendung")).toMatchObject({ parentId: by("Förderungen")?.id, blank: true });
    expect(by("Basis")?.parentId).toBe(by("Gruendung")?.id);
    expect(by("Impressum")).toBeUndefined();
  });

  it("reads again only what changed, and takes out what went away", async () => {
    reads = 0;
    site.delete("https://ex.at/foerderungen/gruendung/basis");
    await json(send("POST", `/api/studio/spaces/${spaceId}/sources/${sourceId}/run`));
    const [source] = await settled();
    expect(source.lastRun).toMatchObject({ written: 0, unchanged: 2 });
    expect(reads).toBe(2);
    const items = await knowledge();
    expect(items.find((i) => i.title === "Basis")).toBeUndefined();
    // The folder that stood empty went with it.
    expect(items.find((i) => i.title === "Gruendung")).toBeUndefined();
  });

  it("leaves out an entry a person closes the eye on", async () => {
    const { entries } = await json(send("GET", `/api/studio/spaces/${spaceId}/sources/${sourceId}`));
    const start = entries.find((e: { address: string }) => e.address.endsWith("start-klar"));
    await json(
      send("PATCH", `/api/studio/spaces/${spaceId}/sources/${sourceId}/entries/${start.id}`, {
        included: false,
      }),
    );
    await settled();
    expect((await knowledge()).find((i) => i.title === "Start!Klar")).toBeUndefined();
    await json(
      send("PATCH", `/api/studio/spaces/${spaceId}/sources/${sourceId}/entries/${start.id}`, {
        included: true,
      }),
    );
    await settled();
    expect((await knowledge()).find((i) => i.title === "Start!Klar")).toBeDefined();
  });

  it("removes what it wrote, but a page a person took over", async () => {
    const items = await knowledge();
    const page = items.find((i) => i.title === "Start!Klar");
    await json(send("POST", `/api/studio/spaces/${spaceId}/knowledge/keep`, { key: page?.key }));
    expect((await knowledge()).find((i) => i.key === page?.key)?.kept).toBe(true);
    await json(send("DELETE", `/api/studio/spaces/${spaceId}/sources/${sourceId}`));
    const after = await knowledge();
    expect(after.map((i) => i.title)).toEqual(["Start!Klar"]);
    expect(after[0]).toMatchObject({ parentId: null, origin: null });
    const { sources } = await json(send("GET", `/api/studio/spaces/${spaceId}/sources`));
    expect(sources).toEqual([]);
  });
});
