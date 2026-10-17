import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Knowledge: typed categories on pages, rows and files; an index whose units follow the structure;
// a search that filters first and lets a classifier judge what it found; what plugins write
// under keys of their own; documents read into pages and tables when they arrive; the tools a
// step reads it all with.

const dir = mkdtempSync(join(tmpdir(), "wizards-knowledge-"));
process.env.DATA_DIR = join(dir, "data");
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.PLUGINS_DIR = join(dir, "plugins");
process.env.PLUGINS_WATCH = "0";
process.env.PLUGIN_JOBS = "0";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
// Jev answers through TypeSafe's own API here; the test answers for it.
process.env.TYPESAFE_API_KEY = "test-typesafe";

type App = { fetch: (req: Request) => Response | Promise<Response> };
let app: App;
let cookie = "";
let spaceId = "";
let client: typeof import("../src/db/client");

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
  const { flushIndex } = await import("../src/services/project-index");
  await flushIndex();
};

/** What Jev answers: P(yes) by a word the candidate must contain. */
let relevant: (candidate: { title: string; text: string }) => number = () => 0.9;
let asked = 0;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const address = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (address.startsWith("https://api.typesafe.ai/v1/systemone")) {
      asked++;
      const body = JSON.parse(String(init?.body));
      const answers: Record<string, unknown> = {};
      for (const c of body.state.candidates) {
        answers[`c${c.index}`] = { type: "noul", noul: relevant(c) };
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
  app = (await import("../src/app")).default;
  const entered = await app.fetch(new Request(url("/api/local/enter?k=test-key")));
  cookie = (entered.headers.get("set-cookie") ?? "").split(";")[0];
  const projects = await import("../src/services/projects");
  spaceId = (await local(() => projects.defaultProject("local"))).id;
}, 60_000);

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("Categories", () => {
  const ids: Record<string, string> = {};
  const pages: Record<string, string> = {};

  it("are typed, and a choice keeps its values in their order", async () => {
    for (const c of [
      { name: "Baustelle", type: "choice", values: ["Graz Süd", "Linz Hafen"] },
      { name: "Berichtsdatum", type: "date" },
      { name: "Arbeitsstunden", type: "number", unit: "h" },
      { name: "Mängel festgestellt", type: "boolean" },
      { name: "Wichtigkeit", type: "choice", ordered: true, values: ["niedrig", "mittel", "hoch"] },
    ]) {
      const res = await send("POST", `/api/studio/projects/${spaceId}/categories`, c);
      expect(res.status).toBe(200);
      ids[c.name] = (await res.json()).id;
    }
    const again = await json(
      send("POST", `/api/studio/projects/${spaceId}/categories`, { name: "baustelle", type: "choice" }),
    );
    expect(again.id).toBe(ids.Baustelle);
    const { categories } = await json(send("GET", `/api/studio/projects/${spaceId}/knowledge`));
    expect(categories.map((c: any) => [c.name, c.type])).toEqual([
      ["Baustelle", "choice"],
      ["Berichtsdatum", "date"],
      ["Arbeitsstunden", "number"],
      ["Mängel festgestellt", "boolean"],
      ["Wichtigkeit", "choice"],
    ]);
    expect(categories[0].values.map((v: any) => v.value)).toEqual(["Graz Süd", "Linz Hafen"]);
  });

  it("are set on pages as typed values, and a sub-page goes with its page", async () => {
    const reports = [
      { title: "Tagesbericht 14.03.2026", site: "Graz Süd", day: "14.03.2026", hours: "38 h", flaw: "nein", level: "mittel" },
      { title: "Tagesbericht 15.03.2026", site: "Graz-Süd", day: "2026-03-15", hours: 41.5, flaw: true, level: "hoch" },
      { title: "Tagesbericht 02.04.2026", site: "Linz Hafen", day: "2026-04-02", hours: 12, flaw: false, level: "niedrig" },
    ];
    for (const r of reports) {
      const { id } = await json(
        send("POST", `/api/studio/projects/${spaceId}/pages`, {
          title: r.title,
          markdown: `# ${r.title}\n\nBetonarbeiten am Fundament. Bewehrung geprüft.\n\n## Mängel\n\nRiss in der Schalung.`,
        }),
      );
      pages[r.title] = id;
      for (const [name, value] of [
        ["Baustelle", r.site],
        ["Berichtsdatum", r.day],
        ["Arbeitsstunden", r.hours],
        ["Mängel festgestellt", r.flaw],
        ["Wichtigkeit", r.level],
      ] as const) {
        const res = await send(
          "PUT",
          `/api/studio/projects/${spaceId}/items/p:${id}/categories/${ids[name]}`,
          { values: [value] },
        );
        expect(res.status).toBe(200);
      }
    }
    const sub = await json(
      send("POST", `/api/studio/projects/${spaceId}/pages`, {
        title: "Fotos",
        parentId: pages["Tagesbericht 14.03.2026"],
        markdown: "Drei Fotos der Bewehrung.",
      }),
    );
    pages.Fotos = sub.id;
    const page = await json(send("GET", `/api/studio/pages/${sub.id}`));
    expect(page.knowledge).toMatchObject({
      path: "pages/tagesbericht-14-03-2026/fotos",
      parents: [{ id: pages["Tagesbericht 14.03.2026"], title: "Tagesbericht 14.03.2026" }],
    });
    const knowledge = await json(send("GET", `/api/studio/projects/${spaceId}/knowledge`));
    const first = knowledge.items.find((i: any) => i.id === pages["Tagesbericht 14.03.2026"]);
    expect(first).toMatchObject({ children: 1 });
    const byName = (name: string) => first.categories.find((c: any) => c.categoryId === ids[name]);
    expect(byName("Berichtsdatum").values).toEqual(["2026-03-14"]);
    expect(byName("Arbeitsstunden").values).toEqual([38]);
    expect(byName("Mängel festgestellt").values).toEqual([false]);
    // Two spellings of one value are offered for merging.
    const site = knowledge.categories.find((c: any) => c.name === "Baustelle");
    expect(site.alike).toHaveLength(1);
  });

  it("filter by their type: a value, a range of numbers and days, yes/no, at least", async () => {
    const { filterItems } = await import("../src/services/space-categories");
    const filtered = (where: Record<string, unknown>) =>
      local(async () => [...((await filterItems(spaceId, where as never))?.pages ?? [])].sort());
    const ofTitles = (...titles: string[]) => titles.map((t) => pages[t]).sort();
    expect(await filtered({ Baustelle: "Linz Hafen" })).toEqual(ofTitles("Tagesbericht 02.04.2026"));
    expect(await filtered({ Arbeitsstunden: { gte: 30 } })).toEqual(
      ofTitles("Tagesbericht 14.03.2026", "Tagesbericht 15.03.2026", "Fotos"),
    );
    expect(await filtered({ Berichtsdatum: { after: "2026-03-15", before: "2026-04-30" } })).toEqual(
      ofTitles("Tagesbericht 15.03.2026", "Tagesbericht 02.04.2026"),
    );
    expect(await filtered({ "Mängel festgestellt": true })).toEqual(ofTitles("Tagesbericht 15.03.2026"));
    expect(await filtered({ Wichtigkeit: { atLeast: "mittel" }, Arbeitsstunden: { lte: 40 } })).toEqual(
      ofTitles("Tagesbericht 14.03.2026", "Fotos"),
    );
    await expect(local(() => filterItems(spaceId, { Gewerk: "Maurer" }))).rejects.toThrow(
      /No category “Gewerk”\. There are: Baustelle \(choice\)/,
    );
  });

  it("merge two spellings of a value into one", async () => {
    const knowledge = await json(send("GET", `/api/studio/projects/${spaceId}/knowledge`));
    const site = knowledge.categories.find((c: any) => c.name === "Baustelle");
    const [a, b] = site.alike[0];
    const from = site.values.find((v: any) => v.id === a).value === "Graz-Süd" ? a : b;
    const into = from === a ? b : a;
    expect((await send("POST", `/api/studio/values/${from}/merge`, { into })).status).toBe(200);
    const after = await json(send("GET", `/api/studio/projects/${spaceId}/knowledge`));
    const merged = after.categories.find((c: any) => c.name === "Baustelle");
    expect(merged.values.map((v: any) => [v.value, v.count])).toEqual([
      ["Graz Süd", 2],
      ["Linz Hafen", 1],
    ]);
    const value = await json(send("GET", `/api/studio/values/${into}`));
    expect(value.items.map((i: any) => i.title).sort()).toEqual([
      "Tagesbericht 14.03.2026",
      "Tagesbericht 15.03.2026",
    ]);
  });
});

describe("the search", () => {
  it("indexes a page by its sections, with its path and categories in front", async () => {
    await flush();
    const rows = await local(() =>
      client.db.query.projectChunk.findMany({
        where: (c, { isNotNull }) => isNotNull(c.pageId),
      }),
    );
    const mängel = rows.find((r) => r.heading?.endsWith("Mängel") && r.text.includes("14.03.2026"));
    expect(mängel?.text).toContain("Tagesbericht 14.03.2026\nBaustelle: Graz Süd · Berichtsdatum: 2026-03-14");
    expect(mängel?.text).toContain("Riss in der Schalung.");
  });

  it("filters before it searches, and the classifier cuts and ranks", async () => {
    const { searchKnowledge } = await import("../src/services/project-index");
    relevant = (c) => (c.text.includes("Riss") ? 0.92 : 0.2);
    const before = asked;
    const found = await local(() =>
      searchKnowledge(spaceId, "Riss Schalung", { where: { Baustelle: "Graz Süd" } }),
    );
    expect(asked).toBe(before + 1);
    expect(found.checked).toBe(true);
    expect(found.filtered).toBe(3);
    expect(found.hits.map((h) => h.title).sort()).toEqual([
      "Tagesbericht 14.03.2026",
      "Tagesbericht 15.03.2026",
    ]);
    expect(found.hits.every((h) => h.relevance === 0.92 && h.heading?.endsWith("Mängel"))).toBe(true);
    relevant = () => 0.1;
    const none = await local(() => searchKnowledge(spaceId, "Riss Schalung"));
    expect(none.hits).toEqual([]);
    expect(none.candidates).toBeGreaterThan(0);
    relevant = () => 0.9;
  });

  it("finds parts of compounds and codes by their trigrams", async () => {
    await send("POST", `/api/studio/projects/${spaceId}/pages`, {
      title: "Cyber-Sicher",
      markdown: "Die Höchstförderhöhe beträgt 30.000 €. Artikel WIN 6 400 I AW-KHSW.",
    });
    await flush();
    const { searchKnowledge } = await import("../src/services/project-index");
    const compound = await local(() => searchKnowledge(spaceId, "förderhöhe", { check: false }));
    expect(compound.hits[0]?.title).toBe("Cyber-Sicher");
    expect(compound.checked).toBe(false);
    const code = await local(() => searchKnowledge(spaceId, "khsw", { check: false }));
    expect(code.hits[0]?.title).toBe("Cyber-Sicher");
  });
});

describe("what a plugin writes", () => {
  it("writes pages, tables and categories under its keys; the same key rewrites", async () => {
    const { originData } = await import("../src/services/space-origin");
    const data = originData("sourcer");
    await local(async () => {
      await data.putCategories({
        space: spaceId,
        categories: [{ name: "Art der Förderung", type: "choice", values: ["Zuschuss", "Kredit"] }],
      });
      const first = await data.putPage({
        space: spaceId,
        key: "sfg:cyber",
        label: "SFG",
        title: "Cyber!Sicher",
        markdown: "Zuschuss für IT-Sicherheit.",
        categories: { "Art der Förderung": "Zuschuss" },
      });
      expect(first).toMatchObject({ state: "written", path: "pages/cyber-sicher-2" });
      const again = await data.putPage({
        space: spaceId,
        key: "sfg:cyber",
        label: "SFG",
        title: "Cyber!Sicher",
        markdown: "Zuschuss für IT-Sicherheit, bis 30.000 €.",
        categories: { "Art der Förderung": "Zuschuss" },
      });
      expect(again.id).toBe(first.id);
      await data.putTable({
        space: spaceId,
        key: "pewag:g10",
        label: "pewag",
        title: "Varianten G10",
        columns: [
          { id: "code", name: "Code", type: "text" },
          { id: "wll", name: "WLL", type: "number", format: { style: "integer" } },
        ],
        rows: [
          { code: "WIN 6", wll: 1120 },
          { code: "WIN 8", wll: 2000 },
        ],
      });
      await data.putCategories({
        space: spaceId,
        categories: [{ name: "WLL", type: "number", unit: "kg", column: { table: "pewag:g10", column: "wll" } }],
      });
      const listed = await data.list(spaceId);
      expect(listed.map((i) => [i.key, i.kind, i.state])).toEqual([
        ["sfg:cyber", "page", "written"],
        ["pewag:g10", "table", "written"],
      ]);
    });
    await flush();
    const { searchKnowledge } = await import("../src/services/project-index");
    const heavy = await local(() =>
      searchKnowledge(spaceId, "WIN Kette", { where: { WLL: { gte: 1500 } }, check: false }),
    );
    expect(heavy.hits.map((h) => h.text)).toEqual([expect.stringContaining("Code: WIN 8")]);
  });

  it("leaves a page a person changed: the plugin no longer writes it", async () => {
    const { originData } = await import("../src/services/space-origin");
    const data = originData("sourcer");
    const listed = await local(() => data.list(spaceId));
    const page = listed.find((i) => i.key === "sfg:cyber");
    await send("PATCH", `/api/studio/pages/${page?.id}`, { markdown: "Von Hand ergänzt." });
    const written = await local(() =>
      data.putPage({ space: spaceId, key: "sfg:cyber", title: "Cyber!Sicher", markdown: "Neu." }),
    );
    expect(written.state).toBe("kept");
    const after = await json(send("GET", `/api/studio/pages/${page?.id}`));
    expect(after.markdown).toBe("Von Hand ergänzt.");
    expect(await local(() => data.remove(spaceId))).toBe(1);
    expect((await local(() => data.list(spaceId))).map((i) => i.key)).toEqual(["sfg:cyber"]);
  });
});

describe("a plugin's documents", () => {
  it("are read as an upload is; the same key reads again, and goes with what it became", async () => {
    const { originData } = await import("../src/services/space-origin");
    const data = originData("folder");
    const csv = (n: number) =>
      ["Artikel;Preis", ...Array.from({ length: n }, (_, i) => `Teil ${i};${10 + i},50 €`)].join("\n");
    const first = await local(() =>
      data.putDocument({
        space: spaceId,
        key: "f1",
        label: "Preislisten",
        name: "preise.csv",
        mime: "text/csv",
        data: new TextEncoder().encode(csv(3)),
      }),
    );
    expect(first).toMatchObject({
      state: "written",
      path: "files/preise.csv",
      items: [{ kind: "table", path: "tables/preise", title: "preise" }],
    });
    const again = await local(() =>
      data.putDocument({
        space: spaceId,
        key: "f1",
        label: "Preislisten",
        name: "preise.csv",
        mime: "text/csv",
        data: new TextEncoder().encode(csv(5)),
      }),
    );
    expect(again.id).toBe(first.id);
    const table = await json(send("GET", `/api/studio/tables/${again.items[0].id}`));
    expect(table.rows).toHaveLength(5);
    expect(table.knowledge).toMatchObject({ originLabel: "Preislisten", file: { id: first.id } });
    expect((await local(() => data.list(spaceId))).map((i) => [i.key, i.kind])).toEqual([["f1", "file"]]);
    expect(await local(() => data.remove(spaceId, "f1"))).toBe(1);
    expect((await send("GET", `/api/studio/tables/${again.items[0].id}`)).status).toBe(404);
  });
});

describe("documents read into Knowledge", () => {
  const upload = async (name: string, mime: string, text: string) => {
    const form = new FormData();
    form.append("file", new File([text], name, { type: mime }));
    const res = await app.fetch(
      new Request(url(`/api/studio/projects/${spaceId}/files?kind=document`), {
        method: "POST",
        headers: { cookie, origin: "http://localhost:5181" },
        body: form,
      }),
    );
    expect(res.status).toBe(200);
    const file = await res.json();
    for (let i = 0; i < 100; i++) {
      const { files } = await json(send("GET", `/api/studio/projects/${spaceId}/files`));
      if (files.find((f: any) => f.id === file.id)?.status !== "pending") {
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    await flush();
    return file.id as string;
  };

  it("reads a CSV into a table with typed columns", async () => {
    const csv = [
      "Produkt;WLL [kg];Gewicht [kg];Geprüft am",
      ...Array.from({ length: 10 }, (_, i) => `WIN ${i + 6};${1000 + i * 100};${(1.5 + i / 10).toFixed(1).replace(".", ",")};0${(i % 9) + 1}.03.2026`),
    ].join("\n");
    const fileId = await upload("kettenprogramm.csv", "text/csv", csv);
    const { items } = await json(send("GET", `/api/studio/projects/${spaceId}/knowledge`));
    const table = items.find((i: any) => i.fileId === fileId);
    expect(table).toMatchObject({ kind: "table", title: "kettenprogramm", rows: 10, path: "tables/kettenprogramm" });
    expect(items.some((i: any) => i.kind === "file" && i.id === fileId)).toBe(false);
    const read = await json(send("GET", `/api/studio/tables/${table.id}`));
    expect(read.columns.map((c: any) => [c.name, c.type])).toEqual([
      ["Produkt", "text"],
      ["WLL [kg]", "number"],
      ["Gewicht [kg]", "number"],
      ["Geprüft am", "date"],
    ]);
    expect(read.rows[1].cells).toMatchObject({ produkt: "WIN 7", wll_kg: 1100, gewicht_kg: 1.6, gepruft_am: "2026-03-02" });
  });

  it("splits a long document along its §§ into sub-pages that link to each other", async () => {
    const paragraphs = Array.from({ length: 6 }, (_, i) => {
      const n = 280 + i;
      return `§ ${n} Pflicht ${n}\n\n${"Der Schuldner hat den Schaden zu ersetzen. ".repeat(120)}Siehe § ${n === 285 ? 280 : n + 1}.`;
    }).join("\n\n");
    const fileId = await upload("bgb-auszug.txt", "text/plain", `# BGB Auszug\n\n${paragraphs}`);
    const { items } = await json(send("GET", `/api/studio/projects/${spaceId}/knowledge`));
    const law = items.find((i: any) => i.fileId === fileId && i.kind === "page");
    expect(law).toMatchObject({ title: "BGB Auszug", children: 6, path: "pages/bgb-auszug" });
    const page = await json(send("GET", `/api/studio/pages/${law.id}`));
    expect(page.knowledge.children.map((c: any) => c.path)).toEqual([
      "pages/bgb-auszug/p-280-pflicht-280",
      "pages/bgb-auszug/p-281-pflicht-281",
      "pages/bgb-auszug/p-282-pflicht-282",
      "pages/bgb-auszug/p-283-pflicht-283",
      "pages/bgb-auszug/p-284-pflicht-284",
      "pages/bgb-auszug/p-285-pflicht-285",
    ]);
    const sub = await json(send("GET", `/api/studio/pages/${page.knowledge.children[0].id}`));
    expect(sub.markdown).toContain("Siehe [§ 281](pages/bgb-auszug/p-281-pflicht-281).");
    expect(sub.knowledge.file).toMatchObject({ id: fileId, name: "bgb-auszug.txt" });
  });
});

describe("the tools of a step", () => {
  it("search with where, list by categories, read a page's section and a table's rows", async () => {
    const { projectTools } = await import("../src/tools/project");
    const emitted: any[] = [];
    const ctx = {
      project: { id: spaceId },
      signal: new AbortController().signal,
      emit: async (_type: string, message: unknown) => {
        emitted.push(message);
      },
    } as never;
    await local(async () => {
      const tools = await projectTools(ctx);
      expect(Object.keys(tools)).toEqual([
        "project_search",
        "project_list",
        "page_read",
        "table_read",
        "project_document",
      ]);
      const found = await tools.project_search.execute({
        query: "Riss Schalung",
        where: { Baustelle: "Graz Süd" },
      });
      expect(found.checked).toBe(true);
      expect(found.hits[0]).toMatchObject({
        path: expect.stringMatching(/^pages\/tagesbericht-1[45]-03-2026$/),
        categories: expect.arrayContaining(["Baustelle: Graz Süd"]),
        section: expect.stringContaining("Mängel"),
        relevance: 0.9,
      });
      const tree = await tools.project_list.execute({});
      expect(tree.categories.find((k: any) => k.name === "Baustelle")).toMatchObject({
        type: "choice",
        values: ["Graz Süd (2)", "Linz Hafen (1)"],
      });
      const listed = await tools.project_list.execute({ where: { Berichtsdatum: { after: "2026-04-01" } } });
      expect(listed.items.map((i: any) => i.path)).toEqual(["pages/tagesbericht-02-04-2026"]);
      const section = await tools.page_read.execute({ path: "pages/tagesbericht-14-03-2026", section: "Mängel" });
      expect(section.page).toContain("categories:\n  Baustelle: Graz Süd");
      expect(section.page).toContain("sub-pages:\n  - pages/tagesbericht-14-03-2026/fotos");
      expect(section.page).toMatch(/## Mängel\n\nRiss in der Schalung\.$/);
      const rows = await tools.table_read.execute({ path: "tables/kettenprogramm", where: { "WLL [kg]": { gte: 1800 } } });
      expect(rows).toMatchObject({ rows: 2, shown: 2 });
      expect(rows.csv.split("\n")[0]).toBe("Produkt,WLL [kg],Gewicht [kg],Geprüft am");
      const missing = await tools.page_read.execute({ path: "pages/nirgends" });
      expect(missing.error).toMatch(/No page "pages\/nirgends"/);
    });
    expect(emitted[0]).toMatchObject({
      code: "searchesKnowledge",
      params: { query: "Riss Schalung" },
    });
  });

  it("tells every step what Knowledge holds and how to filter it", async () => {
    const { knowledgeBlock } = await import("../src/services/knowledge");
    const block = await local(() => knowledgeBlock(spaceId));
    expect(block).toContain("# KNOWLEDGE — WHAT THE SPACE KNOWS");
    expect(block).toContain("- Baustelle (choice): Graz Süd, Linz Hafen");
    expect(block).toContain("- Arbeitsstunden (number, h): 12 … 41.5");
  });
});
