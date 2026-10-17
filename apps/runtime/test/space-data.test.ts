import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

// What a space keeps as data: tables with typed columns and pages of markdown, the space's own
// or one of its wizards'; and its results, searched and filtered.

const dir = mkdtempSync(join(tmpdir(), "wizards-space-data-"));
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
let wizardId = "";

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

beforeAll(async () => {
  const client = await import("../src/db/client");
  await client.migrateControlDb();
  await client.openTenantDb("local");
  app = (await import("../src/app")).default;
  const entered = await app.fetch(new Request(url("/api/local/enter?k=test-key")));
  cookie = (entered.headers.get("set-cookie") ?? "").split(";")[0];
  const projects = await import("../src/services/projects");
  spaceId = (await client.withTenant("local", () => projects.defaultProject("local"))).id;
  wizardId = (await json(send("POST", "/api/studio/wizards", { projectId: spaceId }))).id;
}, 60_000);

describe("a table of the space", () => {
  let tableId = "";

  it("starts with one text column and takes typed columns", async () => {
    const made = await json(send("POST", `/api/studio/projects/${spaceId}/tables`, { title: "Kunden" }));
    tableId = made.id;
    const table = await json(send("GET", `/api/studio/tables/${tableId}`));
    expect(table).toMatchObject({
      title: "Kunden",
      wizardId: null,
      columns: [{ id: "name", name: "Name", type: "text" }],
      rows: [],
      readOnly: false,
    });
    const columns = [
      { id: "name", name: "Name", type: "text", required: true },
      { id: "umsatz", name: "Umsatz", type: "number", format: { style: "currency", currency: "EUR" } },
      {
        id: "stufe",
        name: "Stufe",
        type: "select",
        format: { allowCustom: false, options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] },
      },
    ];
    expect((await send("PATCH", `/api/studio/tables/${tableId}`, { columns })).status).toBe(200);
    const bad = await send("PATCH", `/api/studio/tables/${tableId}`, {
      columns: [{ id: "Bad Id", name: "x", type: "text" }],
    });
    expect(bad.status).toBe(400);
  });

  it("keeps rows filled one cell at a time, and refuses a value its column does not take", async () => {
    // Empty although "name" is required: a person fills the row cell by cell.
    const row = await json(send("POST", `/api/studio/tables/${tableId}/rows`, {}));
    expect(row.cells).toEqual({});
    const filled = await json(
      send("PATCH", `/api/studio/tables/${tableId}/rows/${row.id}`, {
        cells: { name: "Ahorn GmbH", umsatz: "1200.5", stufe: "a" },
      }),
    );
    expect(filled.cells).toEqual({ name: "Ahorn GmbH", umsatz: 1200.5, stufe: "a" });
    const wrong = await send("PATCH", `/api/studio/tables/${tableId}/rows/${row.id}`, {
      cells: { stufe: "z" },
    });
    expect(wrong.status).toBe(400);
    expect((await json(wrong)).error).toContain("not an allowed value");
  });

  it("drops a removed column's cells when the row changes next", async () => {
    await send("PATCH", `/api/studio/tables/${tableId}`, {
      columns: [{ id: "name", name: "Name", type: "text" }],
    });
    const table = await json(send("GET", `/api/studio/tables/${tableId}`));
    const row = table.rows[0];
    const next = await json(
      send("PATCH", `/api/studio/tables/${tableId}/rows/${row.id}`, { cells: { name: "Ahorn" } }),
    );
    expect(next.cells).toEqual({ name: "Ahorn" });
  });

  it("is listed in Knowledge with its rows, not in Data, and goes with its rows", async () => {
    await send("POST", `/api/studio/tables/${tableId}/rows`, { cells: { name: "Birke" } });
    const data = await json(send("GET", `/api/studio/projects/${spaceId}/data`));
    expect(data.tables).toEqual([]);
    const knowledge = await json(send("GET", `/api/studio/projects/${spaceId}/knowledge`));
    expect(knowledge.items).toEqual([
      expect.objectContaining({ id: tableId, kind: "table", title: "Kunden", rows: 2, path: "tables/kunden" }),
    ]);
    const table = await json(send("GET", `/api/studio/tables/${tableId}`));
    await send("POST", `/api/studio/tables/${tableId}/rows/delete`, { ids: [table.rows[0].id] });
    expect((await json(send("GET", `/api/studio/tables/${tableId}`))).rows).toHaveLength(1);
    await send("DELETE", `/api/studio/tables/${tableId}`);
    expect((await send("GET", `/api/studio/tables/${tableId}`)).status).toBe(404);
  });

  it("belongs to a wizard of the space, and to no other", async () => {
    const own = await json(
      send("POST", `/api/studio/projects/${spaceId}/tables`, { title: "Leads", wizardId }),
    );
    expect((await json(send("GET", `/api/studio/tables/${own.id}`))).wizardId).toBe(wizardId);
    const stranger = await send("POST", `/api/studio/projects/${spaceId}/tables`, {
      title: "Fremd",
      wizardId: "nope",
    });
    expect(stranger.status).toBe(400);
  });
});

describe("a page of the space", () => {
  it("keeps a title and markdown", async () => {
    const { id } = await json(
      send("POST", `/api/studio/projects/${spaceId}/pages`, { title: "Über uns", wizardId }),
    );
    await send("PATCH", `/api/studio/pages/${id}`, { markdown: "# Ahorn\n\nTischlerei seit 1952." });
    const page = await json(send("GET", `/api/studio/pages/${id}`));
    expect(page).toMatchObject({
      title: "Über uns",
      wizardId,
      markdown: "# Ahorn\n\nTischlerei seit 1952.",
      readOnly: false,
    });
    const long = await send("PATCH", `/api/studio/pages/${id}`, { markdown: "x".repeat(200_001) });
    expect(long.status).toBe(400);
    const data = await json(send("GET", `/api/studio/projects/${spaceId}/data`));
    expect(data.pages).toEqual([expect.objectContaining({ id, title: "Über uns", wizardId })]);
    await send("DELETE", `/api/studio/pages/${id}`);
    expect((await send("GET", `/api/studio/pages/${id}`)).status).toBe(404);
  });
});

describe("the space's results", () => {
  it("list its wizards, and narrow the runs by words, mode and period", async () => {
    const client = await import("../src/db/client");
    const { schema } = client;
    await client.withTenant("local", async () => {
      const definition = { title: "Angebot", steps: [] } as never;
      const base = {
        wizardId,
        tenantId: "local",
        definition,
        status: "done" as const,
        cursor: null,
      };
      await client.db.insert(schema.run).values([
        { ...base, id: "run-live", mode: "live", state: { values: { ort: "Graz" } } as never },
        {
          ...base,
          id: "run-old",
          mode: "test",
          state: { values: { ort: "Linz" } } as never,
          updatedAt: new Date(Date.now() - 40 * 86_400_000),
        },
      ]);
    });
    const all = await json(send("GET", `/api/studio/projects/${spaceId}/results`));
    expect(all.wizards[0]).toMatchObject({ id: wizardId, results: 2 });
    expect(all.runs.map((r: any) => r.id)).toEqual(["run-live", "run-old"]);
    const ids = async (query: string) =>
      (await json(send("GET", `/api/studio/projects/${spaceId}/results?${query}`))).runs.map(
        (r: any) => r.id,
      );
    expect(await ids("q=graz")).toEqual(["run-live"]);
    expect(await ids("q=50%25")).toEqual([]);
    expect(await ids("mode=test")).toEqual(["run-old"]);
    expect(await ids("days=30")).toEqual(["run-live"]);
  });
});

describe("a shared list", () => {
  const leads = {
    id: "leads",
    title: "Anfragen",
    shared: true,
    key: "email",
    columns: [
      { id: "email", name: "E-Mail", type: "text" as const },
      { id: "anliegen", name: "Anliegen", type: "text" as const },
    ],
  };

  it("is one table of the space that every run writes", async () => {
    const client = await import("../src/db/client");
    const store = await import("../src/store/index");
    await client.withTenant("local", async () => {
      await store.saveRows({ wizardId, holder: "v:anna" }, leads, [
        { email: "anna@example.com", anliegen: "Küche" },
      ]);
      await store.saveRows({ wizardId, holder: "v:ben" }, leads, [
        { email: "ben@example.com", anliegen: "Treppe" },
        { email: "ANNA@example.com ", anliegen: "Küche und Bad" },
      ]);
      const rows = await store.listRows({ wizardId, holder: "v:carla" }, leads);
      // Anna's row, found by its key, took what was given the second time.
      expect(rows.map((r) => r.cells)).toEqual([
        { email: "ANNA@example.com ", anliegen: "Küche und Bad" },
        { email: "ben@example.com", anliegen: "Treppe" },
      ]);
      // Nothing of it is a person's.
      expect(await store.listRows({ wizardId, holder: "v:anna" }, { ...leads, shared: false })).toEqual([]);
    });
    const data = await json(send("GET", `/api/studio/projects/${spaceId}/data`));
    const table = data.tables.find((t: any) => t.list === "leads");
    expect(table).toMatchObject({ wizardId, title: "Anfragen", rows: 2 });
    // The columns are the wizard's; a row whose key is taken is refused in the studio too.
    expect(
      (await send("PATCH", `/api/studio/tables/${table.id}`, { columns: leads.columns })).status,
    ).toBe(400);
    const clash = await send("POST", `/api/studio/tables/${table.id}/rows`, {
      cells: { email: "Ben@example.com" },
    });
    expect(clash.status).toBe(400);
  });

  it("keeps its rows in the order they came, also when two saves fall in one millisecond", async () => {
    const client = await import("../src/db/client");
    const store = await import("../src/store/index");
    const queue = { ...leads, id: "queue", title: "Warteschlange", key: undefined };
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 9, 14, 12));
    try {
      await client.withTenant("local", async () => {
        for (const who of ["a", "b", "c", "d", "e"]) {
          await store.saveRows({ wizardId, holder: `v:${who}` }, queue, [
            { email: `${who}@example.com`, anliegen: who },
          ]);
        }
        const rows = await store.listRows({ wizardId, holder: "v:x" }, queue);
        expect(rows.map((r) => r.cells.anliegen)).toEqual(["a", "b", "c", "d", "e"]);
      });
    } finally {
      clock.mockRestore();
    }
  });

  it("is never shown to the person running the wizard", async () => {
    const { validateWizard } = await import("@engenty-wizards/shared/definition");
    const issues = validateWizard({
      version: 1,
      title: "Anfrage",
      description: "",
      avatar: "round",
      lists: [{ ...leads, check: { status: "anliegen" } }],
      steps: [
        { id: "review", type: "review", show: ["lists.leads"] },
        { id: "done", type: "result", deliverables: [{ from: "lists.leads", formats: ["csv"] }] },
      ],
    } as never);
    const shared = issues.filter((i) => i.message.includes("is shared"));
    expect(shared).toHaveLength(3);
  });
});

describe("a run's pages", () => {
  it("writes its wizard's pages and reads the space's own by path", async () => {
    const client = await import("../src/db/client");
    const { pageTools } = await import("../src/tools/pages");
    const own = await json(
      send("POST", `/api/studio/projects/${spaceId}/pages`, { title: "Preise", markdown: "Ab 90 €." }),
    );
    const emitted: unknown[] = [];
    const tools = pageTools({
      project: { id: spaceId },
      store: { wizardId, holder: "v:anna" },
      emit: async (_type: string, message: unknown) => {
        emitted.push(message);
      },
    } as never) as any;
    await client.withTenant("local", async () => {
      await tools.page_write.execute({ title: "Protokoll", markdown: "- Anna: Küche" });
      await tools.page_write.execute({ title: "protokoll", markdown: "- Ben: Treppe", append: true });
      expect(await tools.page_read.execute({ title: "Protokoll" })).toMatchObject({
        markdown: "- Anna: Küche\n\n- Ben: Treppe",
      });
      const read = await tools.page_read.execute({ path: "pages/preise" });
      expect(read.page).toContain("title: Preise\npath: pages/preise");
      expect(read.page).toContain("Ab 90 €.");
      expect((await tools.page_read.execute({})).pages.map((p: any) => p.title)).toEqual([
        "Protokoll",
      ]);
    });
    const page = { code: "writesPage", params: { title: "Protokoll" } };
    expect(emitted).toEqual([page, page, { code: "reads", params: { name: "pages/preise" } }]);
    await send("DELETE", `/api/studio/pages/${own.id}`);
  });
});

describe("the space's own data from a local install", () => {
  it("replaces what came before, keeps the install's ids and leaves the wizards' data", async () => {
    const client = await import("../src/db/client");
    const spaces = await import("../src/services/spaces");
    const { schema } = client;
    const synced = "localSpace01";
    await client.withTenant("local", async () => {
      await client.db.insert(schema.project).values({
        id: synced,
        tenantId: "local",
        name: "Vom Mac",
        origin: "local",
      });
      const sent = {
        tables: [
          {
            id: "table0000001",
            title: "Preise",
            columns: [{ id: "name", name: "Name", type: "text" as const }],
            rows: [
              { id: "row000000001", cells: { name: "Küche" } },
              { id: "row000000002", cells: { name: "Bad" } },
            ],
          },
        ],
        pages: [{ id: "page00000001", title: "Über uns", markdown: "Seit 1952." }],
      };
      expect(await spaces.syncSpaceData(synced, sent)).toEqual({ tables: 1, pages: 1 });
      // Sent again without the page and with one row: the page goes, the rows are replaced.
      await spaces.syncSpaceData(synced, {
        tables: [{ ...sent.tables[0], rows: [{ id: "row000000003", cells: { name: "Treppe" } }] }],
        pages: [],
      });
      const rows = await client.db.query.spaceTableRow.findMany({
        where: (r, { eq }) => eq(r.tableId, "table0000001"),
      });
      expect(rows.map((r) => r.cells)).toEqual([{ name: "Treppe" }]);
      expect(
        await client.db.query.spacePage.findMany({ where: (p, { eq }) => eq(p.projectId, synced) }),
      ).toEqual([]);
      // An id this tenant uses elsewhere is refused.
      const taken = (await client.db.query.spaceTable.findMany({
        where: (t, { eq }) => eq(t.projectId, spaceId),
      }))[0];
      await expect(
        spaces.syncSpaceData(synced, {
          tables: [{ id: taken.id, title: "x", columns: sent.tables[0].columns, rows: [] }],
          pages: [],
        }),
      ).rejects.toThrow("already in use");
      // A space made here is not one a local install sends.
      await expect(spaces.syncSpaceData(spaceId, { tables: [], pages: [] })).rejects.toThrow();
    });
  });
});
