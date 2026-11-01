import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RWX_RESOURCE_KINDS } from "@engenty/wizards-shared/rwx";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The broker's RWX (docs/plans/broker.md, "First: RWX"): one table of permissions per space, deny
// by default, a deny wins; asked at every reader of a document, a table or a page and by search
// before it ranks. One fixture per sentence („B darf Dokument D nicht lesen“, „Gäste dürfen
// Tabelle T nicht lesen“), each run down every path: the studio's routes, a Work chat's tool, a
// run's step, Goose. With the switch off nothing changes.

const dir = mkdtempSync(join(tmpdir(), "wizards-rwx-"));
process.env.DATA_DIR = join(dir, "data");
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.PLUGINS_DIR = join(dir, "plugins");
process.env.PLUGINS_WATCH = "0";
process.env.PLUGIN_JOBS = "0";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
// The classifier of a search answers through TypeSafe's API; the test answers for it.
process.env.TYPESAFE_API_KEY = "test-typesafe";
delete process.env.FEATURES;

type App = { fetch: (req: Request) => Response | Promise<Response> };
let app: App;
let cookie = "";
let spaceId = "";
let client: typeof import("../src/db/client");
let rwx: typeof import("../src/broker/rwx");

/** The one person of this runtime: the studio's owner, "B" in the sentences below. */
const B = "local";
/** Document D, the page made of it, table T, the wizard W whose run reads them. */
const fixture = { D: "", pageOfD: "", pathOfD: "", T: "", pathOfT: "", W: "", notes: "" };

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
const flush = async () => {
  const { flushIndex } = await import("../src/services/space-index");
  await flushIndex();
};
const on = () => {
  process.env.FEATURES = "broker=on";
};
/** The switch is on by default: off is said out loud. */
const off = () => {
  process.env.FEATURES = "broker=off";
};

const upload = async (name: string, mime: string, text: string) => {
  const form = new FormData();
  form.append("file", new File([text], name, { type: mime }));
  const res = await app.fetch(
    new Request(url(`/api/studio/spaces/${spaceId}/files?kind=document`), {
      method: "POST",
      headers: { cookie, origin: "http://localhost:5181" },
      body: form,
    }),
  );
  expect(res.status).toBe(200);
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

/** A step's context as the tools see it: who holds the run, and the wizard it runs. */
const stepContext = (holder: { kind: "guest"; id: string } | { kind: "person"; id: string }) =>
  ({
    space: { id: spaceId },
    dataSpace: { id: spaceId, name: "" },
    signal: new AbortController().signal,
    emit: async () => {},
    holder: holder.kind === "person" ? { ...holder, role: "owner" } : holder,
    store: { wizardId: fixture.W, holder: `${holder.kind[0]}:${holder.id}` },
  }) as never;

/** The rules as the studio saves them: what is there, with a test's rows laid over it. */
async function putRules(extra: Record<string, unknown>[]) {
  const { rules } = await json(send("GET", `/api/studio/spaces/${spaceId}/rules`));
  const key = (r: any) => [r.subjectKind, r.subjectId ?? "", r.resourceKind, r.resourceId].join("|");
  const kept = rules
    .filter((r: any) => !extra.some((e) => key(e) === key(r)))
    .map(({ id: _id, createdBy: _by, createdAt: _at, ...r }: any) => r);
  const res = await send("PUT", `/api/studio/spaces/${spaceId}/rules`, {
    rules: [...kept, ...extra],
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()).rules as any[];
}

const realFetch = globalThis.fetch;

beforeAll(async () => {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const address = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (address.startsWith("https://api.typesafe.ai/v1/systemone")) {
      const body = JSON.parse(String(init?.body));
      const answers: Record<string, unknown> = {};
      for (const c of body.state.candidates) {
        answers[`c${c.index}`] = { type: "noul", noul: 0.9 };
      }
      return new Response(JSON.stringify({ model: "jev-latest", answers }), {
        headers: { "content-type": "application/json" },
      });
    }
    return realFetch(input, init);
  });
  client = await import("../src/db/client");
  await client.migrateControlDb();
  await client.openTenantDb("local");
  rwx = await import("../src/broker/rwx");
  app = (await import("../src/app")).default;
  const entered = await app.fetch(new Request(url("/api/local/enter?k=test-key")));
  cookie = (entered.headers.get("set-cookie") ?? "").split(";")[0];
  const spaces = await import("../src/services/spaces");
  spaceId = (await local(() => spaces.defaultSpace("local"))).id;

  // Document D becomes a page; the page carries its text, the file stands behind it.
  fixture.D = await upload(
    "vertrag.txt",
    "text/plain",
    "# Vertrag Hollunder\n\nGeheimvertrag mit der Firma Hollunder über 12000 Euro im Jahr.",
  );
  // Table T with a few rows.
  const made = await send("POST", `/api/studio/spaces/${spaceId}/tables`, {
    title: "Kettenprogramm",
    columns: [
      { id: "produkt", name: "Produkt", type: "text" },
      { id: "wll", name: "WLL", type: "text" },
    ],
  });
  expect(made.status, await made.clone().text()).toBe(200);
  fixture.T = (await made.json()).id;
  for (const [produkt, wll] of [
    ["WIN 7 Kette", "1100 kg"],
    ["WIN 10 Kette", "2000 kg"],
  ]) {
    const row = await send("POST", `/api/studio/tables/${fixture.T}/rows`, { cells: { produkt, wll } });
    expect(row.status, await row.clone().text()).toBe(200);
  }
  const { items } = await json(send("GET", `/api/studio/spaces/${spaceId}/knowledge`));
  const page = items.find((i: any) => i.kind === "page" && i.fileId === fixture.D);
  fixture.pageOfD = page.id;
  fixture.pathOfD = page.path;
  fixture.pathOfT = items.find((i: any) => i.id === fixture.T).path;
  // Wizard W, with a page of its own that its runs read.
  fixture.W = (await json(send("POST", "/api/studio/wizards", { spaceId }))).id;
  const data = await import("../src/services/space-data");
  fixture.notes = (
    await local(() =>
      data.writeRunPage(spaceId, fixture.W, { title: "Notizen", markdown: "Merke: Hollunder." }),
    )
  ).id;
  await flush();
}, 60_000);

afterAll(() => {
  vi.unstubAllGlobals();
  delete process.env.FEATURES;
});

describe("with the switch off", () => {
  it("every answer is yes, rules or not, and the rules are not there", async () => {
    off();
    await local(() =>
      client.db.insert(client.schema.rwxRule).values({
        id: "deny-off",
        tenantId: "local",
        spaceId,
        subjectKind: "person",
        subjectId: B,
        resourceKind: "document",
        resourceId: fixture.D,
        r: "deny",
        createdBy: B,
      }),
    );
    expect(
      await local(() =>
        rwx.decide(spaceId, rwx.subjectsOfPerson(B, "owner"), { kind: "document", id: fixture.D }, "r"),
      ),
    ).toMatchObject({ ok: true, reason: "off" });
    const { items } = await json(send("GET", `/api/studio/spaces/${spaceId}/knowledge`));
    expect(items.map((i: any) => i.id)).toEqual(expect.arrayContaining([fixture.pageOfD, fixture.T]));
    expect((await send("GET", `/api/studio/spaces/${spaceId}/files/${fixture.D}/content`)).status).toBe(200);
    const found = await json(send("POST", `/api/studio/spaces/${spaceId}/search`, { query: "Hollunder" }));
    expect(found.hits.map((h: any) => h.open)).toContain(`p:${fixture.pageOfD}`);
    // A search without a who passes too: nothing asks yet.
    const { searchKnowledge } = await import("../src/services/space-index");
    expect((await local(() => searchKnowledge(spaceId, "Hollunder"))).hits.length).toBeGreaterThan(0);
    expect((await send("GET", `/api/studio/spaces/${spaceId}/rules`)).status).toBe(404);
  });
});

describe("the rules, for the space's admins", () => {
  beforeAll(() => local(() => client.db.delete(client.schema.rwxRule)));

  it("seeds a space on its first read: admins and owners rwx, members rw, guests r", async () => {
    on();
    const { rules } = await json(send("GET", `/api/studio/spaces/${spaceId}/rules`));
    expect(rules).toHaveLength(22);
    expect(rules.every((r: any) => r.createdBy === "seed" && r.resourceId === "*")).toBe(true);
    const of = (kind: string, id: string | null) =>
      rules.filter((r: any) => r.subjectKind === kind && r.subjectId === id).map((r: any) => [r.resourceKind, r.r, r.w, r.x]);
    expect(of("role", "owner")).toEqual([
      ["document", "allow", "allow", "allow"],
      ["table", "allow", "allow", "allow"],
      ["page", "allow", "allow", "allow"],
      ["wizard", "allow", "allow", "allow"],
      ["skill", "allow", "allow", "allow"],
      ["setup", "allow", "allow", "allow"],
    ]);
    // A member runs wizards and skills' scripts, and writes the space's setup; building a wizard
    // is the studio's, by the members' studio rule.
    expect(of("role", "member")).toEqual([
      ["document", "allow", "allow", null],
      ["table", "allow", "allow", null],
      ["page", "allow", "allow", null],
      ["wizard", "allow", null, "allow"],
      ["skill", "allow", null, "allow"],
      ["setup", "allow", "allow", null],
    ]);
    expect(of("guest", null)).toEqual([
      ["document", "allow", null, null],
      ["table", "allow", null, null],
      ["page", "allow", null, null],
      ["skill", "allow", null, "allow"],
    ]);
  });

  it("checks what it is given, and takes the whole list", async () => {
    const bad = await send("PUT", `/api/studio/spaces/${spaceId}/rules`, {
      rules: [{ subjectKind: "role", subjectId: "boss", resourceKind: "page", resourceId: "*", r: "allow" }],
    });
    expect(bad.status).toBe(400);
    const twice = await send("PUT", `/api/studio/spaces/${spaceId}/rules`, {
      rules: [
        { subjectKind: "guest", subjectId: null, resourceKind: "page", resourceId: "*", r: "allow" },
        { subjectKind: "guest", subjectId: null, resourceKind: "page", resourceId: "*", r: "deny" },
      ],
    });
    expect(twice.status).toBe(400);
    const rules = await putRules([
      { subjectKind: "person", subjectId: "b2", resourceKind: "page", resourceId: fixture.pageOfD, r: "deny" },
    ]);
    expect(rules).toHaveLength(23);
    const added = rules.find((r: any) => r.subjectId === "b2");
    expect(added).toMatchObject({ createdBy: B, resourceKind: "page", r: "deny", w: null, x: null });
    expect((await send("DELETE", `/api/studio/spaces/${spaceId}/rules/${added.id}`)).status).toBe(200);
    expect((await json(send("GET", `/api/studio/spaces/${spaceId}/rules`))).rules).toHaveLength(22);
    expect((await send("DELETE", `/api/studio/spaces/${spaceId}/rules/${added.id}`)).status).toBe(404);
  });

  it("refuses a member", async () => {
    const { asRole } = await import("../src/services/access");
    await expect(
      local(() => asRole("member", () => rwx.listRules(B, spaceId))),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      local(() => asRole("member", () => rwx.putRules(B, spaceId, []))),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("„B darf Dokument D nicht lesen“", () => {
  beforeAll(async () => {
    on();
    await putRules([
      { subjectKind: "person", subjectId: B, resourceKind: "document", resourceId: fixture.D, r: "deny" },
    ]);
  });

  it("the deny wins over B's role, and reaches Goose and B's runs", async () => {
    const D = { kind: "document" as const, id: fixture.D };
    const denied = await local(() => rwx.decide(spaceId, rwx.subjectsOfPerson(B, "owner"), D, "r"));
    expect(denied).toMatchObject({ ok: false, reason: `document ${fixture.D}: denied` });
    expect(denied.rule).toBeTruthy();
    expect((await local(() => rwx.decide(spaceId, rwx.subjectsOfGoose(B, "owner"), D, "r"))).ok).toBe(false);
    expect(
      (
        await local(() =>
          rwx.decide(spaceId, rwx.subjectsOf(stepContext({ kind: "person", id: B })), D, "r"),
        )
      ).ok,
    ).toBe(false);
    // The page made of D is read as D is.
    expect(
      (
        await local(() =>
          rwx.decide(
            spaceId,
            rwx.subjectsOfPerson(B, "owner"),
            { kind: "page", id: fixture.pageOfD, fileId: fixture.D },
            "r",
          ),
        )
      ).ok,
    ).toBe(false);
    // Another person reads it; so does a guest.
    expect((await local(() => rwx.decide(spaceId, rwx.subjectsOfPerson("b2", "member"), D, "r"))).ok).toBe(true);
    expect((await local(() => rwx.decide(spaceId, rwx.subjectsOfGuest(), D, "r"))).ok).toBe(true);
  });

  it("the studio's routes: D and its page are in no list, no search, and no read", async () => {
    const { items } = await json(send("GET", `/api/studio/spaces/${spaceId}/knowledge`));
    expect(items.map((i: any) => i.id)).not.toContain(fixture.pageOfD);
    expect(items.map((i: any) => i.fileId)).not.toContain(fixture.D);
    expect(items.map((i: any) => i.id)).toContain(fixture.T);
    const found = await json(send("POST", `/api/studio/spaces/${spaceId}/search`, { query: "Hollunder" }));
    expect(found.hits.map((h: any) => h.open)).not.toContain(`p:${fixture.pageOfD}`);
    expect(JSON.stringify(found)).not.toContain("12000");
    for (const path of [
      `/api/studio/spaces/${spaceId}/files/${fixture.D}/content`,
      `/api/studio/spaces/${spaceId}/files/${fixture.D}/text`,
      `/api/studio/pages/${fixture.pageOfD}`,
    ]) {
      const res = await send("GET", path);
      expect(res.status, path).toBe(403);
      const text = await res.text();
      expect(text).not.toContain("Hollunder");
      expect(JSON.parse(text)).toMatchObject({
        code: "forbidden",
        error: `You don’t have permission to read this document (${fixture.D}). An admin of the space can change that.`,
        resource: "document",
        id: fixture.D,
      });
    }
    const de = await app.fetch(
      new Request(url(`/api/studio/pages/${fixture.pageOfD}`), {
        headers: { cookie, "accept-language": "de" },
      }),
    );
    expect((await de.json()).error).toBe(
      `Du darfst Dokument ${fixture.D} nicht lesen. Das ändern die Admins des Space.`,
    );
  });

  it("a Work chat's space_search finds nothing of it for B", async () => {
    const { toolToRun } = await import("../src/services/work-ai");
    const tool = await local(() =>
      toolToRun({ id: spaceId, name: "Test" }, B, "space_search", new AbortController().signal),
    );
    const found = (await local(() => tool?.execute?.({ query: "Hollunder" }))) as any;
    expect(found.hits.map((h: any) => h.open)).not.toContain(`p:${fixture.pageOfD}`);
    expect(JSON.stringify(found)).not.toContain("12000");
  });

  it("a run's step: search, page_read and space_document as B refuse it", async () => {
    const { spaceTools } = await import("../src/tools/space");
    await local(async () => {
      const tools = await spaceTools(stepContext({ kind: "person", id: B }));
      const found = await tools.space_search.execute({ query: "Hollunder" });
      expect(found.hits.map((h: any) => h.path)).not.toContain(fixture.pathOfD);
      expect(JSON.stringify(found)).not.toContain("12000");
      const page = await tools.page_read.execute({ path: fixture.pathOfD });
      expect(page).toMatchObject({ error: expect.stringContaining("permission"), id: fixture.D });
      expect(JSON.stringify(page)).not.toContain("Hollunder");
      const file = await tools.space_document.execute({ path: "files/vertrag.txt" });
      expect(file).toMatchObject({ error: expect.stringContaining("permission"), id: fixture.D });
      // Another person's run reads it.
      const other = await spaceTools(stepContext({ kind: "person", id: "b2" }));
      expect((await other.page_read.execute({ path: fixture.pathOfD })).page).toContain("Hollunder");
    });
  });

  it("Goose, for B, cannot look at it", async () => {
    const { gooseSpaceTools } = await import("../src/agents/studio-assistant");
    const { ownedSpace } = await import("../src/services/spaces");
    await local(async () => {
      const space = await ownedSpace(B, spaceId);
      const input = {
        user: { id: B, role: "owner", tenantId: "local", name: "B", email: "" },
        lang: "en",
        signal: new AbortController().signal,
      } as never;
      const tools = gooseSpaceTools(input, space, () => {}, {
        brandSections: false,
        brandRules: false,
        typography: false,
      });
      const looked = await tools.look_at_file.execute({ id: fixture.D });
      expect(looked).toMatchObject({ error: expect.stringContaining("permission"), id: fixture.D });
      expect(JSON.stringify(looked)).not.toContain("Hollunder");
    });
  });
});

describe("„Gäste dürfen Tabelle T nicht lesen“", () => {
  beforeAll(async () => {
    on();
    await putRules([
      { subjectKind: "guest", subjectId: null, resourceKind: "table", resourceId: fixture.T, r: "deny" },
    ]);
  });

  it("a guest's run: table_read refuses, search finds none of its rows; a member's run reads it", async () => {
    const { spaceTools } = await import("../src/tools/space");
    await local(async () => {
      const guest = await spaceTools(stepContext({ kind: "guest", id: "v1" }));
      const read = await guest.table_read.execute({ path: fixture.pathOfT });
      expect(read).toMatchObject({ error: expect.stringContaining("permission"), id: fixture.T });
      expect(JSON.stringify(read)).not.toContain("WIN 7");
      const found = await guest.space_search.execute({ query: "WIN 7 Kette" });
      expect(found.hits.map((h: any) => h.path)).not.toContain(fixture.pathOfT);
      expect(JSON.stringify(found)).not.toContain("WIN 7");
      const member = await spaceTools(stepContext({ kind: "person", id: "b2" }));
      expect((await member.table_read.execute({ path: fixture.pathOfT })).csv).toContain("WIN 7");
      const theirs = await member.space_search.execute({ query: "WIN 7 Kette" });
      expect(theirs.hits.map((h: any) => h.path)).toContain(fixture.pathOfT);
    });
  });

  it("a shared list is a table of the space: a guest's run reads it as the rules say", async () => {
    const { listRows } = await import("../src/store/index");
    const { sharedTable } = await import("../src/store/shared-lists");
    const def = {
      id: "orders",
      title: "Bestellungen",
      columns: [{ id: "name", name: "Name", type: "text" as const }],
      shared: true,
    };
    const scope = { wizardId: fixture.W, holder: "v:v1" };
    await local(async () => {
      expect(await listRows(scope, def, rwx.subjectsOfGuest())).toEqual([]);
      const table = await sharedTable(scope, def);
      await putRules([
        { subjectKind: "guest", subjectId: null, resourceKind: "table", resourceId: fixture.T, r: "deny" },
        { subjectKind: "guest", subjectId: null, resourceKind: "table", resourceId: table.id, r: "deny" },
      ]);
      await expect(listRows(scope, def, rwx.subjectsOfGuest())).rejects.toMatchObject({
        code: "forbidden",
        data: { resource: "table", id: table.id },
      });
      // Without a who, a shared list goes to nobody.
      await expect(listRows(scope, def)).rejects.toMatchObject({ code: "forbidden" });
    });
  });

  it("the studio's Data and a table's page are read as the rules say too", async () => {
    await putRules([
      { subjectKind: "person", subjectId: B, resourceKind: "table", resourceId: fixture.T, r: "deny" },
    ]);
    const res = await send("GET", `/api/studio/tables/${fixture.T}`);
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("WIN 7");
    const { items } = await json(send("GET", `/api/studio/spaces/${spaceId}/knowledge`));
    expect(items.map((i: any) => i.id)).not.toContain(fixture.T);
    const found = await json(send("POST", `/api/studio/spaces/${spaceId}/search`, { query: "WIN 7 Kette" }));
    expect(JSON.stringify(found)).not.toContain("WIN 7");
  });
});

describe("a wizard's pages (Daten)", () => {
  it("a run reads its wizard's pages as its holder may; the studio's Data too", async () => {
    on();
    const { pageTools } = await import("../src/tools/pages");
    await local(async () => {
      const guest = pageTools(stepContext({ kind: "guest", id: "v1" }));
      expect((await guest.page_read.execute({})).pages.map((p: any) => p.title)).toEqual(["Notizen"]);
      await putRules([
        { subjectKind: "guest", subjectId: null, resourceKind: "page", resourceId: fixture.notes, r: "deny" },
        { subjectKind: "person", subjectId: B, resourceKind: "page", resourceId: fixture.notes, r: "deny" },
      ]);
      expect((await guest.page_read.execute({})).pages).toEqual([]);
      expect(await guest.page_read.execute({ title: "Notizen" })).toMatchObject({ error: 'No page "Notizen".' });
    });
    const data = await json(send("GET", `/api/studio/spaces/${spaceId}/data`));
    expect(data.pages.map((p: any) => p.id)).not.toContain(fixture.notes);
    expect((await send("GET", `/api/studio/pages/${fixture.notes}`)).status).toBe(403);
  });
});

describe("deny by default", () => {
  it("no rule is a no; no subject is a no; a deny beside an allow is a no", async () => {
    on();
    const D = { kind: "document" as const, id: fixture.D };
    expect(await local(() => rwx.decide(spaceId, [{ kind: "plugin", id: "data-sourcer" }], D, "r"))).toEqual({
      ok: false,
      reason: `document ${fixture.D}: no rule`,
      of: D,
    });
    // The seed gives members no x.
    expect(
      (await local(() => rwx.decide(spaceId, rwx.subjectsOfPerson("b2", "member"), D, "x"))).reason,
    ).toBe(`document ${fixture.D}: no rule`);
    expect((await local(() => rwx.decide(spaceId, [], D, "r"))).reason).toBe(`document ${fixture.D}: no subject`);
    const { searchKnowledge } = await import("../src/services/space-index");
    await expect(local(() => searchKnowledge(spaceId, "Hollunder"))).rejects.toMatchObject({ code: "forbidden" });
    // An allow on the person and a deny on their role: the deny wins.
    await putRules([
      { subjectKind: "person", subjectId: "b3", resourceKind: "document", resourceId: fixture.D, r: "allow" },
      { subjectKind: "role", subjectId: "member", resourceKind: "document", resourceId: fixture.D, r: "deny" },
    ]);
    const b3 = await local(() => rwx.decide(spaceId, rwx.subjectsOfPerson("b3", "member"), D, "r"));
    expect(b3.ok).toBe(false);
    expect(b3.reason).toBe(`document ${fixture.D}: denied`);
    // An admin of the organization: their role's rows, not the member's.
    expect((await local(() => rwx.decide(spaceId, rwx.subjectsOfPerson("b3", "admin"), D, "r"))).ok).toBe(true);
    expect(
      await local(() =>
        rwx.readableIds(spaceId, rwx.subjectsOfPerson("b3", "member"), "document", [fixture.D, "other"]),
      ),
    ).toEqual(["other"]);
    expect(await local(() => rwx.readableIds(spaceId, rwx.subjectsOfPerson("b3", "admin"), "document", [fixture.D, "other"]))).toEqual([fixture.D, "other"]);
  });
});

/**
 * The runtime itself (`SYSTEM`): a plugin's job, which no person, guest or run stands behind. It
 * may do everything, a deny for a subject beside it still wins, and nothing a request carries
 * turns into it. No subject at all stays a no.
 */
describe("the runtime itself", () => {
  const D = () => ({ kind: "document" as const, id: fixture.D });

  it("is allowed everything, whatever a role's rows say; a deny for the plugin beside it wins", async () => {
    on();
    await putRules([
      { subjectKind: "role", subjectId: "owner", resourceKind: "document", resourceId: fixture.D, r: "deny", w: "deny", x: "deny" },
    ]);
    expect((await local(() => rwx.decide(spaceId, rwx.subjectsOfPerson(B, "owner"), D(), "r"))).ok).toBe(false);
    for (const perm of ["r", "w", "x"] as const) {
      expect(await local(() => rwx.decide(spaceId, [rwx.SYSTEM], D(), perm))).toEqual({
        ok: true,
        reason: `document ${fixture.D}: the runtime itself`,
        of: D(),
      });
    }
    // The page made of D is D: a deny on D for the plugin reaches the page too.
    const plugin = { kind: "plugin" as const, id: "data-sourcer" };
    await putRules([
      { subjectKind: "plugin", subjectId: "data-sourcer", resourceKind: "document", resourceId: fixture.D, r: "deny" },
    ]);
    const page = { kind: "page" as const, id: fixture.pageOfD, fileId: fixture.D };
    expect(await local(() => rwx.decide(spaceId, [rwx.SYSTEM, plugin], page, "r"))).toMatchObject({
      ok: false,
      reason: `document ${fixture.D}: denied`,
    });
    expect((await local(() => rwx.decide(spaceId, [rwx.SYSTEM, plugin], page, "w"))).ok).toBe(true);
    expect((await local(() => rwx.decide(spaceId, [rwx.SYSTEM], page, "r"))).ok).toBe(true);
    // No subject is still a no, also for the search.
    expect((await local(() => rwx.decide(spaceId, [], D(), "r"))).reason).toBe(`document ${fixture.D}: no subject`);
    const { searchKnowledge } = await import("../src/services/space-index");
    await expect(local(() => searchKnowledge(spaceId, "Hollunder", { who: [] }))).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("never comes from a request: no helper gives it, no rule names it, a look-alike is nobody", async () => {
    on();
    const step = rwx.subjectsOf({
      holder: { kind: "person", id: B, role: "owner" },
      store: { wizardId: fixture.W } as never,
    });
    const callers = await local(() =>
      Promise.all(
        (
          [
            { kind: "guest", id: "v1" },
            { kind: "person", id: B },
            { kind: "admin", id: B },
            { kind: "goose", id: B },
            { kind: "plugin", id: "atlas" },
            { kind: "step", id: "s1", for: { kind: "guest", id: "v1" } },
            { kind: "person" },
          ] as const
        ).map((who) => rwx.subjectsOfCaller({ who, where: { wizardId: fixture.W } })),
      ),
    );
    for (const subjects of [
      rwx.subjectsOfGuest(),
      rwx.subjectsOfPerson(B, "owner"),
      rwx.subjectsOfGoose(B, "admin"),
      rwx.subjectsOfHolder({ kind: "guest", id: "v1" }),
      step,
      rwx.currentReader(),
      ...callers,
    ]) {
      expect(subjects.some((s) => s.kind === "system")).toBe(false);
    }
    // A subject that only looks like it is nobody: no rule names it.
    const lookalike = { kind: "system", id: null } as never;
    expect((await local(() => rwx.decide(spaceId, [lookalike], D(), "r"))).reason).toBe(
      `document ${fixture.D}: no rule`,
    );
    const res = await send("PUT", `/api/studio/spaces/${spaceId}/rules`, {
      rules: [{ subjectKind: "system", subjectId: null, resourceKind: "document", resourceId: "*", r: "allow" }],
    });
    expect(res.status).toBe(400);
  });

  it("a plugin reads a document as whom it was called for, as the runtime only in a job", async () => {
    on();
    await putRules([
      { subjectKind: "plugin", subjectId: "atlas", resourceKind: "document", resourceId: fixture.D, r: "deny" },
      { subjectKind: "role", subjectId: "owner", resourceKind: "document", resourceId: fixture.D, r: null, w: null, x: "allow" },
    ]);
    const { originData } = await import("../src/services/space-origin");
    const { withCaller } = await import("../src/broker/caller");
    const read = (plugin: string) => local(() => originData(plugin).readFile(spaceId, fixture.D));
    // Outside a job, a route or a call: the plugin alone, which no seed allows.
    await expect(read("shop")).rejects.toMatchObject({ code: "forbidden" });
    // A job: the runtime itself.
    expect((await rwx.readingAs([rwx.SYSTEM], () => read("shop"))).id).toBe(fixture.D);
    // A deny for the plugin wins, in a job too.
    await expect(rwx.readingAs([rwx.SYSTEM], () => read("atlas"))).rejects.toMatchObject({ code: "forbidden" });
    // An HTTP route reads as its person: the member's deny on D holds (deny by default above).
    await expect(
      rwx.readingAs(rwx.subjectsOfPerson("b3", "member"), () => read("shop")),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect((await rwx.readingAs(rwx.subjectsOfPerson("b3", "admin"), () => read("shop"))).id).toBe(fixture.D);
    // A tool in a guest's run reads as the guest; the seed lets guests read.
    expect(
      (await withCaller({ who: { kind: "guest", id: "v1" }, where: { wizardId: fixture.W } }, () => read("shop"))).id,
    ).toBe(fixture.D);
  });

  it("is used only where the runtime acts for nobody", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const src = join(__dirname, "../src");
    const files = (readdirSync(src, { recursive: true }) as string[]).filter((f) => f.endsWith(".ts"));
    const users = files.filter((f) => {
      const text = readFileSync(join(src, f), "utf8");
      return (
        /import\s*\{[^}]*\bSYSTEM\b[^}]*\}\s*from\s*"[^"]*broker\/rwx(\.js)?"/.test(text) ||
        /\.SYSTEM\b/.test(text)
      );
    });
    // plugins/jobs.ts: a plugin's job runs on the clock, for no person, guest or run.
    expect(users.sort()).toEqual(["plugins/jobs.ts"]);
  });
});

/**
 * The walk: every kind of resource the rules can name. The kinds this PR enforces have a fixture
 * above; the others are listed here until their reader asks the broker, so a later PR extends
 * the walk and nothing is forgotten.
 */
describe("the walk over every resource kind", () => {
  const fixtures: Record<string, string> = {
    document: "„B darf Dokument D nicht lesen“",
    table: "„Gäste dürfen Tabelle T nicht lesen“",
    page: "a wizard's pages (Daten), and the page made of D",
    wizard: "wizard_run refused without x (elements.test.ts)",
    skill: "skill_load refused without r, scripts without x (elements.test.ts)",
    setup: "Goose's writes refused without w (elements.test.ts)",
  };
  it("enforces exactly the kinds that have a fixture", async () => {
    expect([...rwx.ENFORCED].sort()).toEqual(Object.keys(fixtures).sort());
  });
  for (const kind of RWX_RESOURCE_KINDS) {
    if (fixtures[kind]) {
      it(`${kind}: ${fixtures[kind]}`, () => {
        expect(rwx.ENFORCED).toContain(kind);
      });
    } else {
      it.todo(`${kind}: not yet enforced`);
    }
  }
});
