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

const upload = async (name: string, mime: string, text: string, folder?: string) => {
  const form = new FormData();
  form.append("file", new File([text], name, { type: mime }));
  const into = folder ? `&parent=${folder}` : "";
  const res = await app.fetch(
    new Request(url(`/api/studio/spaces/${spaceId}/files?kind=document${into}`), {
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

/**
 * A test's rules, one at a time as the studio writes them: a rule about the same subject and
 * resource takes the flags given, another is added. No other rule is touched.
 */
async function putRules(extra: Record<string, unknown>[]) {
  const key = (r: any) => [r.subjectKind, r.subjectId ?? "", r.resourceKind, r.resourceId].join("|");
  const { rules } = await json(send("GET", `/api/studio/spaces/${spaceId}/rules`));
  for (const e of extra) {
    const there = rules.find((r: any) => key(r) === key(e));
    const flags = { r: e.r ?? null, w: e.w ?? null, x: e.x ?? null };
    const res = there
      ? await send("PATCH", `/api/studio/spaces/${spaceId}/rules/${there.id}`, flags)
      : await send("POST", `/api/studio/spaces/${spaceId}/rules`, e);
    expect(res.status, await res.clone().text()).toBe(200);
  }
  return (await json(send("GET", `/api/studio/spaces/${spaceId}/rules`))).rules as any[];
}

/** Takes the rule about a subject and a resource away again. */
async function dropRule(of: Record<string, unknown>) {
  const key = (r: any) => [r.subjectKind, r.subjectId ?? "", r.resourceKind, r.resourceId].join("|");
  const { rules } = await json(send("GET", `/api/studio/spaces/${spaceId}/rules`));
  const there = rules.find((r: any) => key(r) === key(of));
  expect(there, key(of)).toBeTruthy();
  const res = await send("DELETE", `/api/studio/spaces/${spaceId}/rules/${there.id}`);
  expect(res.status, await res.clone().text()).toBe(200);
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
    expect(rules).toHaveLength(26);
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
      ["data", "allow", "allow", "allow"],
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
      ["data", "allow", "allow", null],
    ]);
    // A guest's run reads and writes the wizard's own data: its AI steps the guest's own alone.
    expect(of("guest", null)).toEqual([
      ["document", "allow", null, null],
      ["table", "allow", null, null],
      ["page", "allow", null, null],
      ["skill", "allow", null, "allow"],
      ["data", "allow", "allow", null],
    ]);
  });

  it("checks what it is given, and takes one rule at a time", async () => {
    const add = (rule: Record<string, unknown>) => send("POST", `/api/studio/spaces/${spaceId}/rules`, rule);
    const bad = await add({ subjectKind: "role", subjectId: "boss", resourceKind: "page", resourceId: "*", r: "allow" });
    expect(bad.status).toBe(400);
    // The guests' rule on every page is there from the seed: a second one about the same is refused.
    const twice = await add({ subjectKind: "guest", subjectId: null, resourceKind: "page", resourceId: "*", r: "deny" });
    expect(twice.status).toBe(400);
    expect((await twice.json()).error).toContain("already");
    const rules = await putRules([
      { subjectKind: "person", subjectId: "b2", resourceKind: "page", resourceId: fixture.pageOfD, r: "deny" },
    ]);
    expect(rules).toHaveLength(27);
    const added = rules.find((r: any) => r.subjectId === "b2");
    expect(added).toMatchObject({ createdBy: B, resourceKind: "page", r: "deny", w: null, x: null });
    expect((await send("DELETE", `/api/studio/spaces/${spaceId}/rules/${added.id}`)).status).toBe(200);
    expect((await json(send("GET", `/api/studio/spaces/${spaceId}/rules`))).rules).toHaveLength(26);
    expect((await send("DELETE", `/api/studio/spaces/${spaceId}/rules/${added.id}`)).status).toBe(404);
    // The whole list is no longer saved at once.
    expect((await send("PUT", `/api/studio/spaces/${spaceId}/rules`, { rules: [] })).status).toBe(404);
  });

  it("refuses a member", async () => {
    const { asRole } = await import("../src/services/access");
    await expect(
      local(() => asRole("member", () => rwx.listRules(B, spaceId))),
    ).rejects.toMatchObject({ code: "forbidden" });
    const rule = { subjectKind: "guest", subjectId: null, resourceKind: "page", resourceId: fixture.pageOfD, r: "deny", w: null, x: null } as const;
    await expect(
      local(() => asRole("member", () => rwx.addRule(B, spaceId, rule))),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      local(() => asRole("member", () => rwx.askRule(B, spaceId, { who: "guest", resource: "page", resourceId: fixture.pageOfD, perm: "r" }))),
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
      { subjectKind: "role", subjectId: "owner", resourceKind: "document", resourceId: fixture.D, r: "deny" },
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
    const res = await send("POST", `/api/studio/spaces/${spaceId}/rules`, {
      subjectKind: "system",
      subjectId: null,
      resourceKind: "document",
      resourceId: "*",
      r: "allow",
    });
    expect(res.status).toBe(400);
  });

  it("a plugin reads a document as whom it was called for, as the runtime only in a job", async () => {
    on();
    await putRules([
      { subjectKind: "plugin", subjectId: "atlas", resourceKind: "document", resourceId: fixture.D, r: "deny" },
    ]);
    // The owners' deny on D from the test before is taken away again.
    await dropRule({ subjectKind: "role", subjectId: "owner", resourceKind: "document", resourceId: fixture.D });
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
    data: "data_query and data_exec, a guest's AI step on shared data (wizard-data.test.ts)",
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

describe("a Wissen folder's audience", () => {
  const member = [{ kind: "role" as const, id: "member" }];
  const clientRole = [{ kind: "role" as const, id: "client" }];
  const guest = [{ kind: "guest" as const, id: null }];
  let folder = "";
  let inside = "";
  let nested = "";

  beforeAll(async () => {
    on();
    folder = (await json(send("POST", `/api/studio/spaces/${spaceId}/pages`, { title: "Intern" }))).id;
    inside = (
      await json(
        send("POST", `/api/studio/spaces/${spaceId}/pages`, { title: "Preise", parentId: folder }),
      )
    ).id;
    nested = (
      await json(
        send("POST", `/api/studio/spaces/${spaceId}/pages`, { title: "2026", parentId: inside }),
      )
    ).id;
    // Table T moves into the folder too: a folder holds what lies in it, of every kind.
    const moved = await send("POST", `/api/studio/spaces/${spaceId}/knowledge/move`, {
      key: `t:${fixture.T}`,
      parentId: folder,
    });
    expect(moved.status, await moved.clone().text()).toBe(200);
  });

  const reads = (who: { kind: any; id: string | null }[], kind: "page" | "table", id: string) =>
    local(() => rwx.decide(spaceId, who, { kind, id }, "r")).then((d) => d.ok);

  it("starts as the seed has it: the team and guests, no clients", async () => {
    const { see } = await json(
      send("GET", `/api/studio/spaces/${spaceId}/knowledge/folders/${folder}/audience`),
    );
    expect(see).toEqual(["team", "guests"]);
    expect(await reads(member, "page", nested)).toBe(true);
    expect(await reads(clientRole, "page", nested)).toBe(false);
  });

  it("closed to the team and guests, opened to clients, it holds for everything in it", async () => {
    const put = await send(
      "PUT",
      `/api/studio/spaces/${spaceId}/knowledge/folders/${folder}/audience`,
      { see: ["clients"] },
    );
    expect(put.status, await put.clone().text()).toBe(200);
    for (const [kind, id] of [
      ["page", folder],
      ["page", inside],
      ["page", nested],
      ["table", fixture.T],
    ] as const) {
      expect(await reads(member, kind, id), `${kind} ${id} for the team`).toBe(false);
      expect(await reads(guest, kind, id), `${kind} ${id} for guests`).toBe(false);
      expect(await reads(clientRole, kind, id), `${kind} ${id} for clients`).toBe(true);
    }
    // Outside the folder nothing changed.
    expect(await reads(member, "page", fixture.pageOfD)).toBe(true);
    expect(await reads(clientRole, "page", fixture.pageOfD)).toBe(false);
    const { see } = await json(
      send("GET", `/api/studio/spaces/${spaceId}/knowledge/folders/${folder}/audience`),
    );
    expect(see).toEqual(["clients"]);
  });

  it("a deny on an item inside still wins over the folder's allow", async () => {
    const r = await local(() =>
      rwx.decideWith(
        [
          { id: "f", subjectKind: "role", subjectId: "client", resourceKind: "page", resourceId: folder, r: "allow", w: null, x: null } as any,
          { id: "i", subjectKind: "role", subjectId: "client", resourceKind: "page", resourceId: nested, r: "deny", w: null, x: null } as any,
        ],
        clientRole,
        { kind: "page", id: nested, folders: [inside, folder] },
        "r",
      ),
    );
    expect(r.ok).toBe(false);
  });

  it("back to the team and guests: the folder's rules are gone again", async () => {
    await send("PUT", `/api/studio/spaces/${spaceId}/knowledge/folders/${folder}/audience`, {
      see: ["team", "guests"],
    });
    expect(await reads(member, "table", fixture.T)).toBe(true);
    expect(await reads(guest, "page", nested)).toBe(true);
    expect(await reads(clientRole, "page", nested)).toBe(false);
  });
});

/**
 * A folder closed to guests, and the readers that asked nobody before: a plugin's `readPages`
 * and `files`, and what a step is told about Knowledge (how much there is, its categories). A
 * guest's run and a member's run, side by side.
 */
describe("a folder closed to guests: a plugin's reads, a step's counts", () => {
  /** In the folder: a page, a table with a row, a document and the page made of it. `open` is outside. */
  const at = { folder: "", page: "", table: "", row: "", file: "", pageOfFile: "", open: "" };
  const guestRun = () => stepContext({ kind: "guest", id: "v1" });
  const memberRun = () =>
    ({
      ...(stepContext({ kind: "person", id: "m1" }) as object),
      holder: { kind: "person", id: "m1", role: "member" },
    }) as never;

  beforeAll(async () => {
    on();
    // The seed again: what the sentences above wrote is gone, and the next read seeds the space.
    await local(() => client.db.delete(client.schema.rwxRule));
    const page = async (body: Record<string, unknown>) =>
      (await json(send("POST", `/api/studio/spaces/${spaceId}/pages`, body))).id as string;
    at.folder = await page({ title: "Kalkulation" });
    at.page = await page({
      title: "Einkauf",
      parentId: at.folder,
      markdown: "Einkaufspreis Zirbe: 7 Euro.",
    });
    at.open = await page({ title: "Öffnungszeiten", markdown: "Montag bis Freitag." });
    const made = await send("POST", `/api/studio/spaces/${spaceId}/tables`, {
      title: "Lieferanten",
      columns: [{ id: "name", name: "Name", type: "text" }],
    });
    at.table = (await made.json()).id;
    at.row = (
      await json(send("POST", `/api/studio/tables/${at.table}/rows`, { cells: { name: "Zirbenhof" } }))
    ).id;
    const moved = await send("POST", `/api/studio/spaces/${spaceId}/knowledge/move`, {
      key: `t:${at.table}`,
      parentId: at.folder,
    });
    expect(moved.status, await moved.clone().text()).toBe(200);
    at.file = await upload("marge.txt", "text/plain", "# Marge\n\nMarge Zirbe: 38 Prozent.", at.folder);
    const { items } = await json(send("GET", `/api/studio/spaces/${spaceId}/knowledge`));
    at.pageOfFile = items.find((i: any) => i.kind === "page" && i.fileId === at.file).id;
    // Two categories: a customer and a discount, on items in the folder and on the page outside.
    const ids: Record<string, string> = {};
    for (const c of [
      { name: "Kunde", type: "choice", values: ["Zirbe", "Birke"] },
      { name: "Rabatt", type: "number", unit: "%" },
    ]) {
      ids[c.name] = (await json(send("POST", `/api/studio/spaces/${spaceId}/categories`, c))).id;
    }
    for (const [key, name, value] of [
      [`p:${at.page}`, "Kunde", "Zirbe"],
      [`t:${at.table}`, "Kunde", "Zirbe"],
      [`p:${at.open}`, "Kunde", "Birke"],
      [`p:${at.page}`, "Rabatt", 40],
      [`r:${at.row}`, "Rabatt", 60],
      [`p:${at.open}`, "Rabatt", 5],
    ] as const) {
      const set = await send(
        "PUT",
        `/api/studio/spaces/${spaceId}/items/${key}/categories/${ids[name]}`,
        { values: [value] },
      );
      expect(set.status, await set.clone().text()).toBe(200);
    }
    const put = await send(
      "PUT",
      `/api/studio/spaces/${spaceId}/knowledge/folders/${at.folder}/audience`,
      { see: ["team"] },
    );
    expect(put.status, await put.clone().text()).toBe(200);
    await flush();
  }, 60_000);

  it("a step is told how much its holder may read: the counts, the categories' values and ranges", async () => {
    const { knowledgeBlock, knowledgeCounts } = await import("../src/services/knowledge");
    const guest = rwx.subjectsOf(guestRun());
    const member = rwx.subjectsOf(memberRun());
    await local(async () => {
      const all = await knowledgeCounts(spaceId, member);
      const seen = await knowledgeCounts(spaceId, guest);
      // The folder, the page in it and the page made of the document; the table; the document.
      expect({
        pages: all.pages - seen.pages,
        tables: all.tables - seen.tables,
        files: all.files - seen.files,
      }).toEqual({ pages: 3, tables: 1, files: 1 });
      const told = await knowledgeBlock(spaceId, guest);
      expect(told).toContain(`${seen.pages} pages, ${seen.tables} tables, ${seen.files} files`);
      expect(told).toContain("- Kunde (choice): Birke\n");
      expect(told).toContain("- Rabatt (number, %): 5 … 5\n");
      expect(told).not.toContain("Zirbe");
      const theirs = await knowledgeBlock(spaceId, member);
      expect(theirs).toContain(`${all.pages} pages, ${all.tables} tables, ${all.files} files`);
      expect(theirs).toContain("- Kunde (choice): Zirbe, Birke\n");
      expect(theirs).toContain("- Rabatt (number, %): 5 … 60\n");
    });
  });

  it("space_list counts a category's items and values over what the run's holder may read", async () => {
    const { spaceTools } = await import("../src/tools/space");
    await local(async () => {
      const of = async (ctx: never) => {
        const listed = await (await spaceTools(ctx)).space_list.execute({});
        return Object.fromEntries(listed.categories.map((c: any) => [c.name, c]));
      };
      const guest = await of(guestRun());
      expect(guest.Kunde).toMatchObject({ items: 1, values: ["Birke (1)"] });
      expect(guest.Rabatt).toMatchObject({ items: 1, range: "5 … 5" });
      const member = await of(memberRun());
      expect(member.Kunde).toMatchObject({ items: 3, values: ["Zirbe (2)", "Birke (1)"] });
      expect(member.Rabatt).toMatchObject({ items: 3, range: "5 … 60" });
    });
  });

  it("space_search counts what its `where` leaves only among what the run's holder may read", async () => {
    const { spaceTools } = await import("../src/tools/space");
    await local(async () => {
      const left = async (ctx: never, where: Record<string, unknown>) =>
        (await (await spaceTools(ctx)).space_search.execute({ query: "Zirbe", where })).filtered;
      // Zirbe: the page, the table and its row, all in the folder. Birke: the page outside.
      expect(await left(memberRun(), { Kunde: "Zirbe" })).toBe(3);
      expect(await left(guestRun(), { Kunde: "Zirbe" })).toBe(0);
      expect(await left(memberRun(), { Kunde: ["Zirbe", "Birke"] })).toBe(4);
      expect(await left(guestRun(), { Kunde: ["Zirbe", "Birke"] })).toBe(1);
    });
  });

  it("a plugin's readPages and files: nothing of the folder in a guest's run, all of it in a member's and in a job", async () => {
    const { originData } = await import("../src/services/space-origin");
    const { withCaller } = await import("../src/broker/caller");
    const shop = originData("shop");
    const where = { wizardId: fixture.W };
    const inside = [at.folder, at.page, at.pageOfFile];
    const pages = async (as: <T>(fn: () => Promise<T>) => Promise<T>, plugin = shop) =>
      (await as(() => local(() => plugin.readPages(spaceId)))).map((p) => p.id);
    const files = async (as: <T>(fn: () => Promise<T>) => Promise<T>) =>
      (await as(() => local(() => shop.files(spaceId)))).map((f) => f.id);
    const guestsRun = <T>(fn: () => Promise<T>) => withCaller({ who: { kind: "guest", id: "v1" }, where }, fn);
    const membersRun = <T>(fn: () => Promise<T>) => withCaller({ who: { kind: "person", id: "m1" }, where }, fn);
    const route = <T>(fn: () => Promise<T>) => rwx.readingAs(rwx.subjectsOfPerson("m1", "member"), fn);
    const job = <T>(fn: () => Promise<T>) => rwx.readingAs([rwx.SYSTEM], fn);
    const nobody = <T>(fn: () => Promise<T>) => fn();

    // A tool in a guest's run: the page outside, nothing of the folder, by id, by text or by parent.
    const guest = await guestsRun(() => local(() => shop.readPages(spaceId)));
    expect(guest.map((p) => p.id)).toContain(at.open);
    expect(guest.map((p) => p.id)).not.toEqual(expect.arrayContaining([expect.stringMatching(inside.join("|"))]));
    expect(JSON.stringify(guest)).not.toContain("Zirbe");
    expect(await guestsRun(() => local(() => shop.readPages(spaceId, { parent: at.folder })))).toEqual([]);
    expect(await files(guestsRun)).not.toContain(at.file);
    expect(await files(guestsRun)).toContain(fixture.D);
    // A tool in a member's run, an HTTP route for a member, a job: all of it.
    for (const as of [membersRun, route, job]) {
      expect(await pages(as)).toEqual(expect.arrayContaining([...inside, at.open]));
      expect(await files(as)).toEqual(expect.arrayContaining([at.file, fixture.D]));
    }
    expect(
      (await membersRun(() => local(() => shop.readPages(spaceId, { parent: at.folder })))).map((p) => p.id),
    ).toContain(at.page);
    // Outside a job, a route or a call: the plugin alone, which no seed allows.
    expect(await pages(nobody)).toEqual([]);
    expect(await files(nobody)).toEqual([]);
    // A deny for the plugin wins, in a job too; another plugin's job reads on.
    await putRules([
      { subjectKind: "plugin", subjectId: "shop", resourceKind: "page", resourceId: at.folder, r: "deny" },
    ]);
    const denied = await pages(job);
    expect(denied).toContain(at.open);
    expect(denied.filter((id) => inside.includes(id))).toEqual([]);
    expect(await pages(job, originData("atlas"))).toEqual(expect.arrayContaining(inside));
  });

  it("a miss names no file and a page no sub-page that is closed to the run's holder", async () => {
    const { spaceTools } = await import("../src/tools/space");
    await local(async () => {
      const guest = await spaceTools(guestRun());
      const missed = await guest.space_document.execute({ path: "files/nirgends.txt" });
      expect(missed.error).toContain("files/vertrag.txt");
      expect(missed.error).not.toContain("marge");
      const member = await spaceTools(memberRun());
      expect((await member.space_document.execute({ path: "files/nirgends.txt" })).error).toContain(
        "files/marge.txt",
      );
      // One sub-page of the folder closed to the member alone: the folder's page names the other.
      await putRules([
        { subjectKind: "person", subjectId: "m1", resourceKind: "page", resourceId: at.page, r: "deny" },
      ]);
      const folder = await member.page_read.execute({ path: "pages/kalkulation" });
      expect(folder.page).toContain("sub-pages:");
      expect(folder.page).not.toContain("pages/kalkulation/einkauf");
      const owner = await spaceTools(stepContext({ kind: "person", id: B }));
      expect((await owner.page_read.execute({ path: "pages/kalkulation" })).page).toContain(
        "  - pages/kalkulation/einkauf",
      );
    });
  });

  it("a guest who may read nothing is told nothing about Knowledge", async () => {
    await putRules(
      (["page", "table", "document"] as const).map((resourceKind) => ({
        subjectKind: "guest",
        subjectId: null,
        resourceKind,
        resourceId: "*",
        r: "deny",
      })),
    );
    const { knowledgeBlock } = await import("../src/services/knowledge");
    const { spaceTools } = await import("../src/tools/space");
    await local(async () => {
      expect(await knowledgeBlock(spaceId, rwx.subjectsOf(guestRun()))).toBe("");
      expect(await knowledgeBlock(spaceId, rwx.subjectsOf(memberRun()))).toContain("pages");
      // The tools stay: each read is the broker's, and a refusal names the item, not its content.
      const read = await (await spaceTools(guestRun())).page_read.execute({ path: "pages/kalkulation" });
      expect(read).toMatchObject({ error: expect.stringContaining("permission"), id: at.folder });
    });
  });

  it("first reads that come at once seed the space once", async () => {
    const { originData } = await import("../src/services/space-origin");
    const shop = originData("shop");
    await local(() => client.db.delete(client.schema.rwxRule));
    // As the shop plugin's route asks: the files and the pages together.
    await rwx.readingAs(rwx.subjectsOfPerson(B, "owner"), () =>
      local(() => Promise.all([shop.files(spaceId), shop.readPages(spaceId)])),
    );
    const { rules } = await json(send("GET", `/api/studio/spaces/${spaceId}/rules`));
    const keys = rules.map((r: any) => [r.subjectKind, r.subjectId ?? "", r.resourceKind, r.resourceId].join("|"));
    expect(keys.length).toBe(new Set(keys).size);
    expect(rules.filter((r: any) => r.subjectKind === "guest").length).toBe(5);
  });
});
