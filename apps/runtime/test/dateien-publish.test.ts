import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Dateien's drafts and „Veröffentlichen“ (docs/plans/media-and-files.md, section 3): a mount is
// read only until writing is allowed; an edit is a draft until it is published to the folder
// with the version it was read at; a change in the folder meanwhile is merged where it can be,
// else compared and resolved; only people with `w` on the mount publish, never a wizard.

const dir = mkdtempSync(join(tmpdir(), "wizards-dateien-publish-"));
process.env.DATA_DIR = join(dir, "data");
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.PLUGINS_DIR = join(dir, "plugins");
process.env.PLUGINS_WATCH = "0";
process.env.PLUGIN_JOBS = "0";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.FEATURES = "dateien=on,broker=on";

const folder = join(dir, "Notizen");

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
const json = async (res: Response | Promise<Response>) => (await res).json() as Promise<any>;
const local = <T>(fn: () => T | Promise<T>) => client.withTenant("local", fn);
const scan = () =>
  local(async () => {
    await mounts.scanMount(mountId);
    await mounts.flushMounts();
  });
const onDisk = (path: string) => readFileSync(join(folder, path), "utf8");
/** Changes a file in the folder as someone else would, a moment later (a new time). */
async function change(path: string, text: string) {
  await new Promise((r) => setTimeout(r, 20));
  writeFileSync(join(folder, path), text);
}

const files = () => json(send("GET", `/api/studio/spaces/${spaceId}/mounts/${mountId}/files`));
const fileId = async (path: string) =>
  (await files()).files.find((f: { path: string }) => f.path === path).id as string;
const filePath = (id: string, rest = "") => `/api/studio/spaces/${spaceId}/mount-files/${id}${rest}`;

const TEXT = "# Messe\n\nStand in Halle 4.\n\nAufbau am Montag.\n\nAbbau am Freitag.\n";

beforeAll(async () => {
  mkdirSync(join(folder, "Projekte"), { recursive: true });
  writeFileSync(join(folder, "Projekte/messe.md"), TEXT);
  writeFileSync(join(folder, "logo.png"), Buffer.from([1, 2, 3]));
  client = await import("../src/db/client");
  await client.migrateControlDb();
  await client.openTenantDb("local");
  app = (await import("../src/app")).default;
  mounts = await import("../src/mounts/mounts");
  const entered = await app.fetch(new Request(url("/api/local/enter?k=test-key")));
  cookie = (entered.headers.get("set-cookie") ?? "").split(";")[0];
  const spaces = await import("../src/services/spaces");
  spaceId = (await local(() => spaces.defaultSpace("local"))).id;
  const mount = await json(
    send("POST", `/api/studio/spaces/${spaceId}/mounts`, { path: folder, see: ["team"], wizards: "all" }),
  );
  mountId = mount.id;
  expect(mount.writable).toBe(false);
  await scan();
}, 60_000);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("Dateien: drafts and „Veröffentlichen“", () => {
  it("keeps a mount read only until writing is allowed", async () => {
    const id = await fileId("Projekte/messe.md");
    expect((await send("GET", filePath(id, "/draft"))).status).toBe(403);
    const mount = await json(
      send("PATCH", `/api/studio/spaces/${spaceId}/mounts/${mountId}`, { writable: true }),
    );
    expect(mount.writable).toBe(true);
    const rules = await local(() => client.db.query.rwxRule.findMany());
    const ofMount = rules.filter((r) => r.resourceId === mountId);
    expect(ofMount.filter((r) => r.subjectKind === "role").every((r) => r.w === "allow")).toBe(true);
    expect(ofMount.filter((r) => r.subjectKind === "wizard").every((r) => r.w === null)).toBe(true);
  });

  it("keeps an edit as a draft, and writes it to the folder on „Veröffentlichen“", async () => {
    const id = await fileId("Projekte/messe.md");
    const opened = await json(send("GET", filePath(id, "/draft")));
    expect(opened).toMatchObject({ edit: "text", draft: false, text: TEXT });
    const edited = TEXT.replace("Halle 4", "Halle 5");
    const saved = await json(
      send("PUT", filePath(id, "/draft"), { text: edited, base: opened.base, baseText: opened.text }),
    );
    expect(saved.draft).toMatchObject({ draft: true, text: edited });
    expect(onDisk("Projekte/messe.md")).toBe(TEXT);
    const drafts = await json(send("GET", `/api/studio/spaces/${spaceId}/mounts/${mountId}/drafts`));
    expect(drafts.drafts).toMatchObject([{ fileId: id, path: "Projekte/messe.md", conflict: false }]);
    expect(await json(send("POST", filePath(id, "/publish")))).toEqual({ ok: true, merged: false });
    expect(onDisk("Projekte/messe.md")).toBe(edited);
    expect((await json(send("GET", filePath(id, "/draft")))).draft).toBe(false);
    // The index reads it again.
    await local(() => mounts.flushMounts());
    const file = (await files()).files.find((f: { id: string }) => f.id === id);
    expect(file.status).toBe("ready");
    expect(file.size).toBe(Buffer.byteLength(edited));
  });

  it("merges a change in the folder that touched other lines", async () => {
    const id = await fileId("Projekte/messe.md");
    const opened = await json(send("GET", filePath(id, "/draft")));
    const mine = opened.text.replace("Montag", "Dienstag");
    await send("PUT", filePath(id, "/draft"), { text: mine, base: opened.base, baseText: opened.text });
    await change("Projekte/messe.md", opened.text.replace("Freitag", "Samstag"));
    expect(await json(send("POST", filePath(id, "/publish")))).toEqual({ ok: true, merged: true });
    expect(onDisk("Projekte/messe.md")).toBe(
      "# Messe\n\nStand in Halle 5.\n\nAufbau am Dienstag.\n\nAbbau am Samstag.\n",
    );
  });

  it("catches a change to the same lines: keep mine, or take theirs", async () => {
    const id = await fileId("Projekte/messe.md");
    const opened = await json(send("GET", filePath(id, "/draft")));
    const mine = opened.text.replace("Halle 5", "Halle 6");
    await send("PUT", filePath(id, "/draft"), { text: mine, base: opened.base, baseText: opened.text });
    const theirs = opened.text.replace("Halle 5", "Halle 7");
    await change("Projekte/messe.md", theirs);
    const result = await json(send("POST", filePath(id, "/publish")));
    expect(result).toEqual({ ok: false, conflict: { text: theirs } });
    expect(onDisk("Projekte/messe.md")).toBe(theirs);
    const drafts = await json(send("GET", `/api/studio/spaces/${spaceId}/mounts/${mountId}/drafts`));
    expect(drafts.drafts[0].conflict).toBe(true);
    // „Meine behalten“
    expect(await json(send("POST", filePath(id, "/keep-mine")))).toEqual({ ok: true, merged: false });
    expect(onDisk("Projekte/messe.md")).toBe(mine);
    // Again, and „Ihre übernehmen“: the draft goes, the folder's file stays.
    const again = await json(send("GET", filePath(id, "/draft")));
    await send("PUT", filePath(id, "/draft"), {
      text: mine.replace("Halle 6", "Halle 8"),
      base: again.base,
      baseText: again.text,
    });
    await change("Projekte/messe.md", mine.replace("Halle 6", "Halle 9"));
    expect((await json(send("POST", filePath(id, "/publish")))).ok).toBe(false);
    await send("DELETE", filePath(id, "/draft"));
    expect((await json(send("GET", filePath(id, "/draft")))).draft).toBe(false);
    expect(onDisk("Projekte/messe.md")).toContain("Halle 9");
  });

  it("catches a change that kept the file's size and time", async () => {
    const id = await fileId("Projekte/messe.md");
    const opened = await json(send("GET", filePath(id, "/draft")));
    await send("PUT", filePath(id, "/draft"), {
      text: opened.text.replace("Halle 9", "Halle 1"),
      base: opened.base,
      baseText: opened.text,
    });
    const { utimesSync } = await import("node:fs");
    writeFileSync(join(folder, "Projekte/messe.md"), opened.text.replace("Halle 9", "Halle 2"));
    utimesSync(join(folder, "Projekte/messe.md"), new Date(), new Date(opened.base.modified));
    expect((await json(send("POST", filePath(id, "/publish")))).ok).toBe(false);
    await send("DELETE", filePath(id, "/draft"));
  });

  it("replaces another file by an upload, as a draft", async () => {
    const id = await fileId("logo.png");
    const opened = await json(send("GET", filePath(id, "/draft")));
    expect(opened).toMatchObject({ edit: "replace", draft: false });
    const form = new FormData();
    form.set("file", new File([new Uint8Array([9, 8, 7, 6])], "logo.png", { type: "image/png" }));
    const res = await app.fetch(
      new Request(url(filePath(id, "/draft/replace")), {
        method: "POST",
        headers: { cookie, origin: "http://localhost:5181" },
        body: form,
      }),
    );
    expect(await json(res)).toMatchObject({ edit: "replace", draft: true });
    expect([...readFileSync(join(folder, "logo.png"))]).toEqual([1, 2, 3]);
    const all = await json(send("POST", `/api/studio/spaces/${spaceId}/mounts/${mountId}/publish`));
    expect(all).toEqual({ published: 1, conflicts: [] });
    expect([...readFileSync(join(folder, "logo.png"))]).toEqual([9, 8, 7, 6]);
  });

  it("never lets a wizard or a reader without w publish", async () => {
    const drafts = await import("../src/mounts/drafts");
    const id = await fileId("Projekte/messe.md");
    const wizard = [
      { kind: "person" as const, id: "local" },
      { kind: "role" as const, id: "owner" },
      { kind: "wizard" as const, id: "w1" },
    ];
    await expect(local(() => drafts.openDraft(spaceId, id, wizard))).rejects.toMatchObject({
      code: "forbidden",
    });
    const member = [
      { kind: "person" as const, id: "m1" },
      { kind: "role" as const, id: "member" },
    ];
    expect((await local(() => drafts.openDraft(spaceId, id, member))).edit).toBe("text");
    await send("PATCH", `/api/studio/spaces/${spaceId}/mounts/${mountId}`, { writable: false });
    await expect(local(() => drafts.openDraft(spaceId, id, member))).rejects.toMatchObject({
      code: "read_only",
    });
    expect(await local(() => drafts.mountDrafts(spaceId, mountId, member))).toEqual([]);
  });
});
