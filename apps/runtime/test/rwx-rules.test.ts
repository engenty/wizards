import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RWX_ASKED, RWX_RESOURCE_KINDS } from "@engenty/wizards-shared/rwx";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The rules as Fähigkeiten › Rechte writes and reads them (docs/plans/capabilities-next.md, piece
// 3): one rule added, changed and removed with no other rule touched; a rule no reader would ask
// refused in words; where each writer's rules are set; a mount's rules left alone; and „Was darf
// …?“ for content, for a guest and a member against a folder closed to guests.

// This runtime has one person, its owner. `m1` is asked about as a member of the organization.
vi.mock("../src/services/access", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/services/access")>();
  return {
    ...mod,
    roleOf: async (id: string) => (id === "m1" ? ("member" as const) : mod.roleOf(id)),
  };
});

const dir = mkdtempSync(join(tmpdir(), "wizards-rwx-rules-"));
process.env.DATA_DIR = join(dir, "data");
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.PLUGINS_DIR = join(dir, "plugins");
process.env.PLUGINS_WATCH = "0";
process.env.PLUGIN_JOBS = "0";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.FEATURES = "broker=on,dateien=on";

type App = { fetch: (req: Request) => Response | Promise<Response> };
let app: App;
let cookie = "";
let spaceId = "";
let client: typeof import("../src/db/client");
let rwx: typeof import("../src/broker/rwx");

/** The one person of this runtime: its owner. */
const B = "local";
/** A document, a page with text, a table, a wizard; a folder of Wissen with a page and a document in it. */
const at = { D: "", page: "", T: "", W: "", folder: "", inside: "", fileInside: "", mount: "" };
const mounted = join(dir, "Kunden");

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
const api = (path = "") => `/api/studio/spaces/${spaceId}/rules${path}`;
const list = async () => (await json(send("GET", api()))).rules as any[];
const add = (rule: Record<string, unknown>) => send("POST", api(), rule);
const ask = (query: Record<string, string>) => send("GET", api(`/ask?${new URLSearchParams(query)}`));
/** The rules but the ones named, as they are compared before and after a call. */
const others = (rules: any[], ...ids: string[]) =>
  rules.filter((r) => !ids.includes(r.id)).sort((a, b) => a.id.localeCompare(b.id));

const upload = async (name: string, text: string, folder?: string) => {
  const form = new FormData();
  form.append("file", new File([text], name, { type: "text/plain" }));
  const res = await app.fetch(
    new Request(url(`/api/studio/spaces/${spaceId}/files?kind=document${folder ? `&parent=${folder}` : ""}`), {
      method: "POST",
      headers: { cookie, origin: "http://localhost:5181" },
      body: form,
    }),
  );
  expect(res.status, await res.clone().text()).toBe(200);
  const file = await res.json();
  for (let i = 0; i < 100; i++) {
    const { files } = await json(send("GET", `/api/studio/spaces/${spaceId}/files`));
    if (files.find((f: any) => f.id === file.id)?.status !== "pending") {
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return file.id as string;
};

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  await client.openTenantDb("local");
  rwx = await import("../src/broker/rwx");
  app = (await import("../src/app")).default;
  const entered = await app.fetch(new Request(url("/api/local/enter?k=test-key")));
  cookie = (entered.headers.get("set-cookie") ?? "").split(";")[0];
  const spaces = await import("../src/services/spaces");
  spaceId = (await local(() => spaces.defaultSpace("local"))).id;

  const page = async (body: Record<string, unknown>) =>
    (await json(send("POST", `/api/studio/spaces/${spaceId}/pages`, body))).id as string;
  at.D = await upload("vertrag.txt", "Vertrag mit der Firma Hollunder.");
  at.page = await page({ title: "Öffnungszeiten", markdown: "Montag bis Freitag." });
  at.folder = await page({ title: "Preise intern" });
  at.inside = await page({ title: "Einkauf", parentId: at.folder, markdown: "Einkaufspreis: 7 Euro." });
  at.fileInside = await upload("marge.txt", "Marge: 38 Prozent.", at.folder);
  const made = await send("POST", `/api/studio/spaces/${spaceId}/tables`, {
    title: "Lieferanten",
    columns: [{ id: "name", name: "Name", type: "text" }],
  });
  at.T = (await made.json()).id;
  at.W = (await json(send("POST", "/api/studio/wizards", { spaceId }))).id;
  // A folder of this computer, mounted in Dateien: the team sees it, every wizard may use it, the
  // AI in Work reads it.
  mkdirSync(mounted, { recursive: true });
  writeFileSync(join(mounted, "liesmich.md"), "Kundenordner.");
  const mount = await send("POST", `/api/studio/spaces/${spaceId}/mounts`, {
    path: mounted,
    see: ["team"],
    wizards: "all",
    agents: "read",
  });
  expect(mount.status, await mount.clone().text()).toBe(200);
  at.mount = (await mount.json()).id;
}, 60_000);

afterAll(() => {
  delete process.env.FEATURES;
});

describe("one rule at a time", () => {
  let before: any[] = [];
  let ruleId = "";

  it("adds one rule: named, set on this page, and no other rule touched", async () => {
    before = await list();
    const res = await add({
      subjectKind: "person",
      subjectId: B,
      resourceKind: "page",
      resourceId: at.page,
      r: "deny",
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const { rule } = await res.json();
    ruleId = rule.id;
    expect(rule).toMatchObject({
      subjectKind: "person",
      subjectId: B,
      resourceKind: "page",
      resourceId: at.page,
      r: "deny",
      w: null,
      x: null,
      createdBy: B,
      origin: "rights",
      resourceName: "Öffnungszeiten",
    });
    expect(rule.subjectName).toBeTruthy();
    const after = await list();
    expect(after).toHaveLength(before.length + 1);
    expect(others(after, ruleId)).toEqual(others(before));
    // It decides at once.
    expect((await send("GET", `/api/studio/pages/${at.page}`)).status).toBe(403);
  });

  it("changes one rule: the flags named, the others as they were, no other rule touched", async () => {
    const res = await send("PATCH", api(`/${ruleId}`), { w: "deny" });
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await res.json()).rule).toMatchObject({ id: ruleId, r: "deny", w: "deny", x: null, createdBy: B });
    const back = await send("PATCH", api(`/${ruleId}`), { w: null });
    expect((await back.json()).rule).toMatchObject({ r: "deny", w: null, x: null });
    expect(others(await list(), ruleId)).toEqual(others(before));
    // Nothing named, a flag no reader asks, and a rule left without a flag are refused.
    expect((await send("PATCH", api(`/${ruleId}`), {})).status).toBe(400);
    const unasked = await send("PATCH", api(`/${ruleId}`), { x: "allow" });
    expect(unasked.status).toBe(400);
    expect((await unasked.json()).error).toContain("Nothing asks who may run a page");
    const empty = await send("PATCH", api(`/${ruleId}`), { r: null });
    expect(empty.status).toBe(400);
    expect((await empty.json()).error).toContain("Remove the rule instead");
    expect((await send("PATCH", api("/nope"), { r: "deny" })).status).toBe(404);
    expect((await list()).find((r) => r.id === ruleId)).toMatchObject({ r: "deny", w: null, x: null });
  });

  it("changes a rule of the start set, and keeps what it held besides", async () => {
    const members = (await list()).find(
      (r) => r.subjectKind === "role" && r.subjectId === "member" && r.resourceKind === "wizard",
    );
    expect(members).toMatchObject({ r: "allow", w: null, x: "allow", createdBy: "seed", origin: "start" });
    const off = await send("PATCH", api(`/${members.id}`), { x: null });
    expect((await off.json()).rule).toMatchObject({ r: "allow", x: null, createdBy: "seed", origin: "start" });
    const member = rwx.subjectsOfPerson("m1", "member");
    const W = { kind: "wizard" as const, id: at.W };
    expect((await local(() => rwx.decide(spaceId, member, W, "x"))).ok).toBe(false);
    expect((await local(() => rwx.decide(spaceId, member, W, "r"))).ok).toBe(true);
    await send("PATCH", api(`/${members.id}`), { x: "allow" });
    expect((await local(() => rwx.decide(spaceId, member, W, "x"))).ok).toBe(true);
    // The members' rule on documents holds a w no reader asks yet: setting r leaves it there.
    const documents = (await list()).find(
      (r) => r.subjectKind === "role" && r.subjectId === "member" && r.resourceKind === "document",
    );
    expect(documents).toMatchObject({ r: "allow", w: "allow" });
    const closed = await send("PATCH", api(`/${documents.id}`), { r: null });
    expect((await closed.json()).rule).toMatchObject({ r: null, w: "allow" });
    await send("PATCH", api(`/${documents.id}`), { r: "allow" });
    expect(others(await list(), ruleId)).toEqual(others(before));
  });

  it("removes one rule, and no other rule with it", async () => {
    expect((await send("DELETE", api(`/${ruleId}`))).status).toBe(200);
    expect(others(await list())).toEqual(others(before));
    expect((await send("DELETE", api(`/${ruleId}`))).status).toBe(404);
    expect((await send("GET", `/api/studio/pages/${at.page}`)).status).toBe(200);
  });

  it("writes a line of the log for each change", async () => {
    const { lines } = await json(send("GET", `/api/studio/spaces/${spaceId}/broker/log?connection=rwx`));
    const reasons = lines.map((l: any) => l.reason as string);
    expect(reasons.some((r: string) => r.startsWith("An RWX rule was added: person local on page"))).toBe(true);
    expect(reasons.some((r: string) => r.startsWith("An RWX rule was changed:"))).toBe(true);
    expect(reasons.some((r: string) => r.startsWith("An RWX rule was deleted:"))).toBe(true);
  });
});

describe("a rule no reader would ask is refused, in words", () => {
  const member = { subjectKind: "role", subjectId: "member" };
  const guest = { subjectKind: "guest", subjectId: null };
  const cases = (): [string, Record<string, unknown>, string][] => [
    // Connections, mail, hosts and the sandbox: nothing asks a rule about them.
    ["a connection", { ...member, resourceKind: "connection", resourceId: "c1", r: "allow" }, "A connection has its own audience and rules"],
    ["mail", { ...guest, resourceKind: "mail", resourceId: "*", x: "deny" }, "Nothing asks a rule about mail"],
    ["a host", { ...member, resourceKind: "host", resourceId: "example.com", x: "allow" }, "Nothing asks a rule about a host"],
    ["the sandbox", { ...guest, resourceKind: "sandbox", resourceId: "*", x: "deny" }, "Nothing asks a rule about the sandbox"],
    // A permission no reader asks on the kind.
    ["w on a document", { ...member, resourceKind: "document", resourceId: at.D, w: "deny" }, "Nothing asks who may change a document"],
    ["x on a document", { ...member, resourceKind: "document", resourceId: at.D, x: "allow" }, "Nothing asks who may run a document"],
    ["w on a table", { ...member, resourceKind: "table", resourceId: at.T, w: "deny" }, "Nothing asks who may change a table"],
    ["x on a table", { ...member, resourceKind: "table", resourceId: at.T, x: "allow" }, "Nothing asks who may run a table"],
    ["x on a page", { ...member, resourceKind: "page", resourceId: at.page, x: "allow" }, "Nothing asks who may run a page"],
    ["w on a wizard", { ...member, resourceKind: "wizard", resourceId: at.W, w: "deny" }, "Nothing asks who may change a wizard"],
    ["w on a skill", { ...member, resourceKind: "skill", resourceId: "*", w: "deny" }, "Nothing asks who may change a skill"],
    ["r on the setup", { ...member, resourceKind: "setup", resourceId: "*", r: "deny" }, "Nothing asks who may read the setup"],
    ["x on the setup", { ...member, resourceKind: "setup", resourceId: "*", x: "deny" }, "Nothing asks who may run the setup"],
    // One flag asked, one not: the rule is refused whole.
    ["r and w on a document", { ...member, resourceKind: "document", resourceId: at.D, r: "deny", w: "deny" }, "Nothing asks who may change a document"],
    // A subject no reader asks it for.
    ["a guest running a wizard", { ...guest, resourceKind: "wizard", resourceId: at.W, x: "allow" }, "Nothing asks whether a guest may run a wizard"],
    ["a guest changing a page", { ...guest, resourceKind: "page", resourceId: at.page, w: "deny" }, "Nothing asks whether a guest may change a page"],
    ["a plugin reading a table", { subjectKind: "plugin", subjectId: "shop", resourceKind: "table", resourceId: at.T, r: "deny" }, "Nothing asks whether a plugin may read a table"],
    ["Goose running a skill", { subjectKind: "goose", subjectId: B, resourceKind: "skill", resourceId: "*", x: "deny" }, "Nothing asks whether Goose may run a skill"],
    ["Goose listing a wizard", { subjectKind: "goose", subjectId: B, resourceKind: "wizard", resourceId: at.W, r: "deny" }, "Nothing asks whether Goose may read a wizard"],
    ["a wizard changing a page", { subjectKind: "wizard", subjectId: at.W, resourceKind: "page", resourceId: at.page, w: "deny" }, "Nothing asks whether a wizard may change a page"],
    ["the AI in Work changing the setup", { subjectKind: "agent", subjectId: null, resourceKind: "setup", resourceId: "*", w: "deny" }, "Nothing asks whether an AI working for a person may change the setup"],
    // Only Goose asks it, and a client reaches no studio.
    ["a client changing a page", { subjectKind: "role", subjectId: "client", resourceKind: "page", resourceId: at.page, w: "deny" }, "Nothing asks whether a client may change a page"],
    ["a client changing the setup", { subjectKind: "role", subjectId: "client", resourceKind: "setup", resourceId: "*", w: "allow" }, "Nothing asks whether a client may change the setup"],
    // What the schema cannot say.
    ["an agent with an id", { subjectKind: "agent", subjectId: B, resourceKind: "document", resourceId: at.D, r: "deny" }, "has no subject id"],
    ["a guest with an id", { subjectKind: "guest", subjectId: "v1", resourceKind: "document", resourceId: at.D, r: "deny" }, "A guest rule has no subject id"],
    ["a person without one", { subjectKind: "person", subjectId: null, resourceKind: "document", resourceId: at.D, r: "deny" }, "names the person's id"],
    ["a role that is none", { subjectKind: "role", subjectId: "boss", resourceKind: "document", resourceId: at.D, r: "deny" }, "A role is member, admin, owner or client"],
    ["another space's setup", { ...member, resourceKind: "setup", resourceId: "elsewhere", w: "deny" }, "A space has one setup"],
    ["no flag", { ...member, resourceKind: "document", resourceId: at.D }, "at least one of r, w and x"],
    // What the space does not have, and what is there already.
    ["a document that is not there", { ...member, resourceKind: "document", resourceId: "nope", r: "deny" }, 'This space has no document "nope"'],
    ["a second rule about the same", { ...guest, resourceKind: "page", resourceId: "*", r: "deny" }, "already"],
    // A mount's rules are its form's.
    ["a rule on a mount", { ...member, resourceKind: "mount", resourceId: at.mount, r: "deny" }, "set on the folder in Dateien"],
  ];

  it("each of them answers 400 with the reason, and nothing is stored", async () => {
    const before = await list();
    for (const [name, rule, why] of cases()) {
      const res = await add(rule);
      expect(res.status, name).toBe(400);
      expect((await res.json()).error, name).toContain(why);
    }
    expect(others(await list())).toEqual(others(before));
  });

  it("what a reader asks is taken: the AI in Work on a document, a wizard on a folder, Goose on the setup", async () => {
    const taken = [
      { subjectKind: "agent", subjectId: null, resourceKind: "document", resourceId: at.D, r: "deny" },
      { subjectKind: "wizard", subjectId: at.W, resourceKind: "page", resourceId: at.folder, r: "deny" },
      { subjectKind: "wizard", subjectId: "*", resourceKind: "table", resourceId: at.T, r: "deny" },
      { subjectKind: "goose", subjectId: B, resourceKind: "setup", resourceId: spaceId, w: "deny" },
      { subjectKind: "plugin", subjectId: "shop", resourceKind: "page", resourceId: at.inside, r: "deny" },
      { ...guest, resourceKind: "skill", resourceId: "nope", x: "deny" },
    ];
    const ids: string[] = [];
    for (const rule of taken) {
      const res = await add(rule);
      // A guest's run places a skill's scripts: asked. The space has no such skill, though.
      if (rule.resourceKind === "skill") {
        expect((await res.json()).error).toContain('This space has no skill "nope"');
        continue;
      }
      expect(res.status, await res.clone().text()).toBe(200);
      ids.push((await res.json()).rule.id);
    }
    // The AI in Work is asked beside its person: its deny closes the document to a Work chat alone.
    const D = { kind: "document" as const, id: at.D };
    expect((await local(() => rwx.decide(spaceId, rwx.subjectsOfAgent(B, "owner"), D, "r"))).ok).toBe(false);
    expect((await local(() => rwx.decide(spaceId, rwx.subjectsOfPerson(B, "owner"), D, "r"))).ok).toBe(true);
    for (const id of ids) {
      expect((await send("DELETE", api(`/${id}`))).status).toBe(200);
    }
  });

  it("the table names what the runtime enforces, and nothing on a connection, mail, a host or the sandbox", () => {
    const asked = RWX_RESOURCE_KINDS.filter((kind) => Object.keys(RWX_ASKED[kind]).length);
    expect([...asked].sort()).toEqual([...rwx.ENFORCED, "mount"].sort());
    for (const kind of ["connection", "mail", "host", "sandbox"] as const) {
      expect(RWX_ASKED[kind]).toEqual({});
    }
  });
});

describe("a mount's rules are its form's", () => {
  const ofMount = (rules: any[]) =>
    rules.filter((r) => r.resourceKind === "mount").sort((a, b) => a.id.localeCompare(b.id));

  it("lists them as set in Dateien, the AI in Work's row among them", async () => {
    const rules = ofMount(await list());
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.every((r) => r.origin === "mount" && r.resourceName === "Kunden")).toBe(true);
    expect(rules.find((r) => r.subjectKind === "agent")).toMatchObject({ subjectId: null, r: "allow", w: null });
    expect(rules.find((r) => r.subjectKind === "wizard")).toMatchObject({ subjectId: "*", r: "allow" });
  });

  it("every rule the other writers wrote is one the check takes", async () => {
    await send("PUT", `/api/studio/spaces/${spaceId}/knowledge/folders/${at.folder}/audience`, { see: ["clients"] });
    await local(() => rwx.setOpenToClients(B, spaceId, { kind: "wizard", id: at.W }, true));
    const written = (await list()).filter((r) => r.createdBy !== "seed");
    expect(written.map((r) => r.origin).sort()).toEqual(expect.arrayContaining(["clients", "folder", "mount"]));
    for (const r of written) {
      expect(rwx.refusalOf(spaceId, r), `${r.subjectKind} on ${r.resourceKind}`).toBeNull();
    }
    await send("PUT", `/api/studio/spaces/${spaceId}/knowledge/folders/${at.folder}/audience`, { see: ["team", "guests"] });
    await local(() => rwx.setOpenToClients(B, spaceId, { kind: "wizard", id: at.W }, false));
  });

  it("they survive a rule added, changed and removed beside them", async () => {
    const before = ofMount(await list());
    const added = await add({ subjectKind: "guest", subjectId: null, resourceKind: "table", resourceId: at.T, r: "deny" });
    const { rule } = await added.json();
    await send("PATCH", api(`/${rule.id}`), { r: "allow" });
    await send("DELETE", api(`/${rule.id}`));
    expect(ofMount(await list())).toEqual(before);
    // The AI in Work still reads the mount, as its form says.
    const access = await json(send("GET", `/api/studio/spaces/${spaceId}/mounts/${at.mount}`));
    expect(access).toMatchObject({ see: ["team"], wizards: "all", agents: "read" });
  });

  it("the rules routes change and remove none of them", async () => {
    const [first] = ofMount(await list());
    for (const res of [
      await send("PATCH", api(`/${first.id}`), { r: "deny" }),
      await send("DELETE", api(`/${first.id}`)),
    ]) {
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("set on the folder in Dateien");
    }
    expect(ofMount(await list()).find((r) => r.id === first.id)).toEqual(first);
  });
});

describe("where a rule is set", () => {
  const of = (rules: any[], subjectKind: string, subjectId: string | null, resourceKind: string, resourceId: string) =>
    rules.find(
      (r) =>
        r.subjectKind === subjectKind &&
        r.subjectId === subjectId &&
        r.resourceKind === resourceKind &&
        r.resourceId === resourceId,
    );

  it("the start set: every rule of the seed", async () => {
    const seeded = (await list()).filter((r) => r.createdBy === "seed");
    expect(seeded).toHaveLength(26);
    expect(seeded.every((r) => r.origin === "start" && r.subjectName === null && r.resourceName === null)).toBe(true);
  });

  it("a Wissen folder's dialog: closed to guests, opened to clients, named as a folder", async () => {
    const put = await send("PUT", `/api/studio/spaces/${spaceId}/knowledge/folders/${at.folder}/audience`, {
      see: ["clients"],
    });
    expect(put.status, await put.clone().text()).toBe(200);
    const rules = await list();
    for (const [kind, id] of [["guest", null], ["role", "member"], ["role", "client"]] as const) {
      expect(of(rules, kind, id, "page", at.folder), `${kind} ${id}`).toMatchObject({
        origin: "folder",
        resourceName: "Preise intern",
        folder: true,
        createdBy: B,
      });
    }
  });

  it("the same rule written here is the dialog's: it shows it, and takes it away", async () => {
    await send("PUT", `/api/studio/spaces/${spaceId}/knowledge/folders/${at.folder}/audience`, {
      see: ["team", "guests"],
    });
    expect(of(await list(), "guest", null, "page", at.folder)).toBeUndefined();
    const added = await add({ subjectKind: "guest", subjectId: null, resourceKind: "page", resourceId: at.folder, r: "deny" });
    expect((await added.json()).rule).toMatchObject({ origin: "folder", folder: true });
    const { see } = await json(send("GET", `/api/studio/spaces/${spaceId}/knowledge/folders/${at.folder}/audience`));
    expect(see).toEqual(["team"]);
    // What the dialog cannot show is this page's: a member's rule that only keeps Goose from writing there.
    const goose = await add({ subjectKind: "role", subjectId: "member", resourceKind: "page", resourceId: at.folder, w: "deny" });
    expect((await goose.json()).rule).toMatchObject({ origin: "rights", folder: true });
    // Wissen offers the dialog on a page with text too: it is no folder, and the rule is the dialog's.
    const page = await add({ subjectKind: "guest", subjectId: null, resourceKind: "page", resourceId: at.page, r: "deny" });
    const onPage = (await page.json()).rule;
    expect(onPage).toMatchObject({ origin: "folder", resourceName: "Öffnungszeiten" });
    expect(onPage.folder).toBeUndefined();
    // A person's rule on it is no audience: set here.
    const person = await add({ subjectKind: "person", subjectId: "m1", resourceKind: "page", resourceId: at.page, r: "deny" });
    expect((await person.json()).rule).toMatchObject({ origin: "rights" });
  });

  it("„Für Kund:innen sichtbar“: a document, a page, a wizard", async () => {
    for (const [kind, id] of [["document", at.D], ["page", at.page], ["wizard", at.W]] as const) {
      await local(() => rwx.setOpenToClients(B, spaceId, { kind, id }, true));
    }
    const rules = await list();
    expect(of(rules, "role", "client", "document", at.D)).toMatchObject({ origin: "clients", resourceName: "vertrag.txt" });
    // On a page of Wissen it is the rule its dialog shows.
    expect(of(rules, "role", "client", "page", at.page)).toMatchObject({ origin: "folder" });
    expect(of(rules, "role", "client", "wizard", at.W)).toMatchObject({ origin: "clients", x: "allow" });
    expect(of(rules, "role", "client", "wizard", at.W).resourceName).not.toBeNull();
  });

  it("a mount's form, and this page for the rest", async () => {
    const res = await add({ subjectKind: "wizard", subjectId: at.W, resourceKind: "document", resourceId: at.D, r: "deny" });
    const { rule } = await res.json();
    expect(rule).toMatchObject({ origin: "rights", resourceName: "vertrag.txt" });
    expect(rule.subjectName).not.toBeNull();
    const rules = await list();
    expect(rules.filter((r) => r.resourceKind === "mount").every((r) => r.origin === "mount")).toBe(true);
    // A role's rule on every resource of a kind belongs to the start set, whoever wrote it.
    const role = await add({ subjectKind: "role", subjectId: "client", resourceKind: "skill", resourceId: "*", r: "allow" });
    expect((await role.json()).rule).toMatchObject({ origin: "start", createdBy: B });
    // A person's rule on every resource of a kind is an exception.
    const person = await add({ subjectKind: "person", subjectId: "m1", resourceKind: "wizard", resourceId: "*", x: "deny" });
    expect((await person.json()).rule).toMatchObject({ origin: "rights", subjectName: null });
  });
});

describe("„Was darf …?“ for content", () => {
  beforeAll(async () => {
    // The seed again beside the mount's rules, and the folder closed to guests alone.
    await local(() => client.db.delete(client.schema.rwxRule).where(sql`resource_kind <> 'mount'`));
    await local(() => rwx.seedRwx(spaceId));
    const put = await send("PUT", `/api/studio/spaces/${spaceId}/knowledge/folders/${at.folder}/audience`, {
      see: ["team"],
    });
    expect(put.status, await put.clone().text()).toBe(200);
  });

  it("a guest may not read what lies in the folder: the folder's rule decides", async () => {
    for (const [resource, resourceId] of [["page", at.inside], ["page", at.folder], ["document", at.fileInside]]) {
      const answer = await json(ask({ who: "guest", resource, resourceId, perm: "r" }));
      expect(answer, `${resource} ${resourceId}`).toMatchObject({
        ok: false,
        rule: {
          subjectKind: "guest",
          resourceKind: "page",
          resourceId: at.folder,
          r: "deny",
          origin: "folder",
          resourceName: "Preise intern",
          folder: true,
        },
      });
    }
    // Outside the folder the guests' start rule decides.
    expect(await json(ask({ who: "guest", resource: "page", resourceId: at.page, perm: "r" }))).toMatchObject({
      ok: true,
      rule: { subjectKind: "guest", resourceKind: "page", resourceId: "*", origin: "start" },
    });
  });

  it("a member reads it: their role's start rule decides", async () => {
    const answer = await json(ask({ who: "person", id: "m1", resource: "page", resourceId: at.inside, perm: "r" }));
    expect(answer).toMatchObject({
      ok: true,
      rule: { subjectKind: "role", subjectId: "member", resourceKind: "page", resourceId: "*", origin: "start" },
    });
    // The answer is the readers': the same decision `decide` gives a member's read.
    const decided = await local(() =>
      rwx.decide(spaceId, rwx.subjectsOfPerson("m1", "member"), { kind: "page", id: at.inside }, "r"),
    );
    expect(decided).toMatchObject({ ok: true, rule: answer.rule.id });
  });

  it("a wizard's run reads as who holds it: a guest's not, a member's does", async () => {
    const q = { who: "wizard", id: at.W, resource: "page", resourceId: at.inside, perm: "r" };
    expect(await json(ask(q))).toMatchObject({ ok: false, rule: { origin: "folder" } });
    expect(await json(ask({ ...q, for: "m1" }))).toMatchObject({ ok: true, rule: { origin: "start" } });
  });

  it("Goose and the AI in Work may what their person may; a deny on them alone holds for them", async () => {
    const q = { id: "m1", resource: "page", resourceId: at.inside, perm: "r" };
    expect((await json(ask({ ...q, who: "goose" }))).ok).toBe(true);
    expect((await json(ask({ ...q, who: "agent" }))).ok).toBe(true);
    const added = await add({ subjectKind: "agent", subjectId: null, resourceKind: "page", resourceId: at.inside, r: "deny" });
    const { rule } = await added.json();
    expect(await json(ask({ ...q, who: "agent" }))).toMatchObject({ ok: false, rule: { id: rule.id, origin: "rights" } });
    expect((await json(ask({ ...q, who: "person" }))).ok).toBe(true);
    expect((await json(ask({ ...q, who: "goose" }))).ok).toBe(true);
    await send("DELETE", api(`/${rule.id}`));
    // Goose writes a page for a member, as the members' start rule lets it.
    expect((await json(ask({ ...q, who: "goose", perm: "w" }))).ok).toBe(true);
  });

  it("a wizard, a skill, the setup, a table, and no rule at all", async () => {
    expect(await json(ask({ who: "person", id: "m1", resource: "wizard", resourceId: at.W, perm: "x" }))).toMatchObject({
      ok: true,
      rule: { resourceKind: "wizard", resourceId: "*", origin: "start" },
    });
    expect((await json(ask({ who: "goose", id: "m1", resource: "setup", perm: "w" }))).ok).toBe(true);
    expect((await json(ask({ who: "guest", resource: "table", resourceId: at.T, perm: "r" }))).ok).toBe(true);
    // A plugin's job reads as the runtime itself: yes, and no rule says so.
    expect(await json(ask({ who: "plugin", id: "shop", resource: "document", resourceId: at.D, perm: "r" }))).toMatchObject({
      ok: true,
      rule: null,
    });
    // Without the members' start rule on wizards no rule allows it: deny by default.
    await local(() => client.db.delete(client.schema.rwxRule).where(sql`subject_kind = 'role' AND subject_id = 'member' AND resource_kind = 'wizard'`));
    expect(await json(ask({ who: "person", id: "m1", resource: "wizard", resourceId: at.W, perm: "x" }))).toMatchObject({
      ok: false,
      rule: null,
      reason: `wizard ${at.W}: no rule`,
    });
  });

  it("refuses what no reader asks, what is not there, and anyone but an admin", async () => {
    const never = await ask({ who: "guest", resource: "wizard", resourceId: at.W, perm: "x" });
    expect(never.status).toBe(400);
    expect((await never.json()).error).toBe("Nothing asks whether a guest may run a wizard.");
    expect((await ask({ who: "person", id: B, resource: "document", resourceId: at.D, perm: "w" })).status).toBe(400);
    expect((await ask({ who: "person", id: B, resource: "document", resourceId: "nope", perm: "r" })).status).toBe(404);
    expect((await ask({ who: "person", resource: "document", resourceId: at.D, perm: "r" })).status).toBe(400);
    expect((await ask({ who: "person", id: B, resource: "mount", resourceId: at.mount, perm: "r" })).status).toBe(400);
    const { asRole } = await import("../src/services/access");
    await expect(
      local(() => asRole("member", () => rwx.askRule(B, spaceId, { who: "guest", resource: "page", resourceId: at.page, perm: "r" }))),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("what Rechte picks from", () => {
  it("the people, wizards, documents, pages with their folders, tables and skills of the space", async () => {
    const choices = await json(send("GET", api("/choices")));
    expect(choices.people).toEqual([expect.objectContaining({ id: B, role: "owner" })]);
    expect(choices.wizards.map((w: any) => w.id)).toContain(at.W);
    expect(choices.documents.map((d: any) => d.id)).toEqual(expect.arrayContaining([at.D, at.fileInside]));
    expect(choices.pages.find((p: any) => p.id === at.folder)).toMatchObject({ name: "Preise intern", folder: true });
    expect(choices.pages.find((p: any) => p.id === at.page)).toMatchObject({ folder: false });
    expect(choices.tables).toEqual([{ id: at.T, name: "Lieferanten" }]);
    expect(choices.skills).toEqual([]);
    expect(Array.isArray(choices.plugins)).toBe(true);
  });

  it("is the admins', and not there while the switch is off", async () => {
    const { asRole } = await import("../src/services/access");
    await expect(local(() => asRole("member", () => rwx.rulesSpace(B, spaceId)))).rejects.toMatchObject({
      code: "forbidden",
    });
    process.env.FEATURES = "broker=off,dateien=on";
    for (const path of ["", "/choices", `/ask?who=guest&resource=page&resourceId=${at.page}&perm=r`]) {
      expect((await send("GET", api(path))).status, path).toBe(404);
    }
    expect((await add({ subjectKind: "guest", subjectId: null, resourceKind: "table", resourceId: at.T, r: "deny" })).status).toBe(404);
    process.env.FEATURES = "broker=on,dateien=on";
  });
});
