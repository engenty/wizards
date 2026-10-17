import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { wizardSchema } from "@engenty-wizards/shared/definition";
import { beforeAll, describe, expect, it } from "vitest";
import type { StepContext } from "../src/engine/types";

const dir = mkdtempSync(join(tmpdir(), "wizards-plugins-"));
const pluginsDir = join(dir, "plugins");
process.env.DATA_DIR = join(dir, "data");
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.PLUGINS_DIR = pluginsDir;
process.env.PLUGINS_WATCH = "0";
// The marketplace is not asked: what is listed comes from here.
process.env.MARKETPLACE_URL = "off";
// No model is set up: a plugin that asks one is told so.
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";

/** Writes a file of a plugin, making its folders. */
function put(path: string, content: string) {
  const file = join(pluginsDir, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

// --- the plugins under test -----------------------------------------------------------

put(
  "notify.ts",
  `import type { WizardsPluginFactory } from "@engenty/wizards/plugin";
const plugin: WizardsPluginFactory = (wizards) => {
  wizards.server.on("run.done", ({ run, wizard, values }) => {
    ((globalThis as any).__notified ??= []).push({ run: run.id, mode: run.mode, title: wizard.title, values });
  });
};
export default plugin;
`,
);

put(
  "guestbook/engenty.plugin.json",
  JSON.stringify({
    id: "guestbook",
    name: "Guestbook",
    version: "1.2.3",
    description: "Keeps a line per visitor.",
    provides: ["module.guestbook"],
  }),
);
put(
  "guestbook/migrations/0001_init.sql",
  `CREATE TABLE guestbook_entry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL
);
CREATE INDEX guestbook_entry_text ON guestbook_entry (text);
`,
);
put(
  "guestbook/src/schema.ts",
  `import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
export const entry = sqliteTable("guestbook_entry", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  text: text("text").notNull(),
});
`,
);
put("guestbook/src/greeting.ts", `export const GREETING = "hello";\n`);
const guestbook = (extra = "") => `import { definePlugin } from "@engenty/wizards/plugin";
import { count, eq } from "drizzle-orm";
import { z } from "zod";
import { GREETING } from "./greeting";
import { entry } from "./schema";

export default definePlugin((wizards) => {
  const { server } = wizards;
  server.registerMigrations("migrations");
  server.onUnload(() => {
    (globalThis as any).__disposed = ((globalThis as any).__disposed ?? 0) + 1;
  });
  server.registerHttpRoute({
    method: "GET",
    path: "/",
    handler: async ({ user }) => ({
      greeting: GREETING,
      user: user.id,
      entries: await server.getTenantDb().select().from(entry),
    }),
  });
  server.registerHttpRoute({
    method: "POST",
    path: "/",
    handler: async (request) => {
      const { text } = await request.json<{ text?: string }>();
      if (!text) {
        throw Object.assign(new Error("Text fehlt."), { status: 422, code: "no_text" });
      }
      const [row] = await server.getTenantDb().insert(entry).values({ text }).returning();
      return row;
    },
  });
  server.registerHttpRoute({
    method: "GET",
    path: "/entries/:id",
    handler: async ({ params }) => {
      const [row] = await server.getTenantDb().select().from(entry).where(eq(entry.id, Number(params.id)));
      return row ?? new Response("gone", { status: 410 });
    },
  });
  server.registerHttpRoute({ method: "DELETE", path: "/", role: "admin", handler: () => ({ ok: true }) });
  server.registerHttpRoute({
    method: "GET",
    path: "/ask",
    handler: async () => {
      try {
        return await server.generate({ prompt: "Say hello", model: "classifier" });
      } catch (err) {
        return { refused: (err as Error).name, code: (err as { code?: string }).code };
      }
    },
  });
  server.registerHttpRoute({
    method: "GET",
    path: "/boom",
    handler: () => {
      throw new Error("secret detail");
    },
  });
  server.registerTool({
    name: "count",
    title: "Einträge zählen",
    description: "Counts the entries of the guestbook that hold a word.",
    inputSchema: z.object({ word: z.string().optional() }),
    execute: async ({ word }, ctx) => {
      await ctx.emit("Zählt Einträge");
      const [{ n }] = await server.getTenantDb().select({ n: count() }).from(entry);
      return { entries: n, word: word ?? null, project: ctx.project.name };
    },
  });
  server.on("run.done", async ({ values }) => {
    await server.getTenantDb().insert(entry).values({ text: \`run: \${String(values.name)}\` });
  });
  server.registerStarter({
    id: "welcome",
    title: "Willkommen",
    description: "Fragt Gäste nach ihrem Namen.",
    language: "de",
    definition: {
      title: "Willkommen",
      steps: [
        { id: "start", type: "page", title: "Start", fields: [{ id: "name", kind: "text", label: "Name" }] },
        { id: "done", type: "result", title: "Fertig", deliverables: [] },
      ],
    },
    files: { "notes/greeting.txt": "Grüß Gott", "data/bytes.bin": new Uint8Array([1, 2, 3]) },
  });
${extra}});
`;
put("guestbook/src/plugin.ts", guestbook());
put("guestbook/dist/client.js", "var __wizardsPlugin_guestbook = function () {};\n");
put("guestbook/dist/client.css", "[data-plugin=guestbook] .x{color:red}\n");

// Written against the name plugins imported before `@engenty/wizards/plugin`: it still loads.
put(
  "kiosk.ts",
  `import { definePlugin } from "@engenty-wizards/plugin-sdk";
export default definePlugin(({ server }) => {
  server.registerRunner({
    id: "kiosk",
    label: { de: "Kiosk", en: "Kiosk" },
    kind: "page",
    capabilities: {
      input: ["text", "select"],
      output: { shows: ["text"], pictures: ["image"] },
      asks: ["confirm"],
      review: ["accept"],
      waits: true,
      handoff: ["screen"],
    },
    page: ({ wizard, path, query }) =>
      new Response("kiosk for " + wizard.title + " at " + path + (query.get("q") ? "?" + query.get("q") : ""), {
        headers: { "content-type": "text/plain" },
      }),
  });
  server.registerRunner({
    id: "phone",
    label: { de: "Telefon", en: "Phone" },
    kind: "channel",
    capabilities: {
      input: ["text"],
      output: { shows: ["text"], pictures: [] },
      asks: ["confirm"],
      review: ["accept"],
      waits: true,
      handoff: ["sms"],
    },
    // What the test sets: none, a text, or one with its kind.
    problem: () => (globalThis as { phoneProblem?: unknown }).phoneProblem ?? null,
  });
  server.registerPublicRoute({
    method: "POST",
    path: "/call/:token",
    handler: async ({ params, json }) => {
      const body = await json<{ answers?: Record<string, unknown> }>();
      const started = await server.runs.start({
        token: params.token,
        person: { channel: "phone", id: "+43 660 1234567" },
        answers: body.answers,
        runner: "phone",
      });
      const seen: string[] = [];
      const stop = server.runs.subscribe(started.runId, (signal) => {
        seen.push(signal.event ? signal.event.type : "status");
      });
      const report = await server.runs.report(started.runId, { waitSeconds: 5 });
      stop();
      return { ...started, report, handoff: await server.runs.handoffUrl(started.runId), seen };
    },
  });
});
`,
);

put("broken/index.ts", `export default function plugin(wizards: any) {
  wizards.server.registerHttpRoute({ method: "GET", path: "/", handler: () => ({ ok: true }) });
  throw new Error("cannot start");
}
`);
put("Bad_Name.ts", "export default () => {};\n");
put("notes.md", "not a plugin\n");

// ---------------------------------------------------------------------------------------

type App = { fetch: (req: Request) => Response | Promise<Response> };
let app: App;
let client: typeof import("../src/db/client");
let loader: typeof import("../src/plugins/loader");
let registry: typeof import("../src/plugins/registry");
let wizards: typeof import("../src/services/wizards");
let runner: typeof import("../src/engine/runner");
let cookie = "";

const LOCAL = "local";
const url = (path: string) => `http://localhost:5181${path}`;
const get = (path: string, as = cookie) =>
  app.fetch(new Request(url(path), { headers: { cookie: as } }));
const send = (method: string, path: string, body?: unknown) =>
  app.fetch(
    new Request(url(path), {
      method,
      headers: { cookie, "content-type": "application/json", origin: "http://localhost:5181" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
const json = async (res: Response | Promise<Response>) => (await res).json() as Promise<any>;

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = await read();
    if (done(value)) {
      return value;
    }
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error("timed out");
}

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  loader = await import("../src/plugins/loader");
  registry = await import("../src/plugins/registry");
  await loader.loadPlugins();
  await client.openTenantDb(LOCAL);
  wizards = await import("../src/services/wizards");
  runner = await import("../src/engine/runner");
  app = (await import("../src/app")).default;
  const entered = await app.fetch(new Request(url("/api/local/enter?k=test-key")));
  cookie = (entered.headers.get("set-cookie") ?? "").split(";")[0];
}, 60_000);

describe("finding and loading plugins", () => {
  it("finds a file, a folder with a manifest and a folder with an index", () => {
    const ids = registry
      .loadedPlugins()
      .map((p) => p.source.id)
      .sort();
    expect(ids).toEqual(["broken", "guestbook", "kiosk", "notify"]);
    expect(registry.loadedPlugin("guestbook")?.source.manifest).toMatchObject({
      name: "Guestbook",
      version: "1.2.3",
      provides: ["module.guestbook"],
    });
  });

  it("says what looked like a plugin and is none", () => {
    const problems = loader.pluginProblems();
    expect(problems).toHaveLength(1);
    expect(problems[0].path).toContain("Bad_Name.ts");
  });

  it("keeps nothing of a plugin that failed while loading", () => {
    const broken = registry.loadedPlugin("broken")!;
    expect(broken.error).toBe("cannot start");
    expect(broken.routes).toEqual([]);
  });
});

describe("what the studio asks", () => {
  it("takes a signed-in person", async () => {
    expect((await get("/api/studio/plugins", "")).status).toBe(401);
  });

  it("lists the plugins with their tools and their built studio half", async () => {
    const { plugins, canReload, problems } = await json(get("/api/studio/plugins"));
    expect(canReload).toBe(true);
    expect(problems).toHaveLength(1);
    const listed = plugins.find((p: any) => p.id === "guestbook");
    expect(listed).toMatchObject({
      name: "Guestbook",
      version: "1.2.3",
      error: null,
      tools: [{ id: "guestbook.count", title: "Einträge zählen" }],
    });
    expect(listed.script).toMatch(/^\/api\/studio\/plugins\/-\/assets\/guestbook\/client\.js\?rev=\w+$/);
    expect(plugins.find((p: any) => p.id === "notify")).toMatchObject({ script: null, styles: null });
    expect(plugins.find((p: any) => p.id === "broken").error).toBe("cannot start");

    const script = await get(listed.script);
    expect(script.headers.get("content-type")).toContain("text/javascript");
    expect(script.headers.get("cache-control")).toContain("immutable");
    expect(await script.text()).toContain("__wizardsPlugin_guestbook");
    const styles = await get(listed.styles);
    expect(styles.headers.get("content-type")).toContain("text/css");
    expect((await get("/api/studio/plugins/-/assets/notify/client.js")).status).toBe(404);
    expect((await get("/api/studio/plugins/-/assets/guestbook/plugin.ts")).status).toBe(404);
  });
});

describe("a plugin's routes", () => {
  it("answer below the plugin's address, inside the person's tenant", async () => {
    const saved = await json(send("POST", "/api/studio/plugins/guestbook/", { text: "first" }));
    expect(saved).toMatchObject({ id: 1, text: "first" });
    const list = await json(get("/api/studio/plugins/guestbook"));
    expect(list).toMatchObject({ greeting: "hello", user: "local", entries: [{ text: "first" }] });
    expect(await json(get("/api/studio/plugins/guestbook/entries/1"))).toMatchObject({ text: "first" });
  });

  it("pass on a Response, and an error that says how to answer", async () => {
    expect((await get("/api/studio/plugins/guestbook/entries/99")).status).toBe(410);
    const refused = await send("POST", "/api/studio/plugins/guestbook/", {});
    expect(refused.status).toBe(422);
    expect(await refused.json()).toEqual({ error: "Text fehlt.", code: "no_text" });
  });

  it("can ask a model, and hear when there is none", async () => {
    expect(await json(get("/api/studio/plugins/guestbook/ask"))).toEqual({
      refused: "ModelUnavailableError",
      code: "no_model",
    });
  });

  it("keep what went wrong inside to the log", async () => {
    const failed = await get("/api/studio/plugins/guestbook/boom");
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: "The plugin failed.", code: "plugin_failed" });
  });

  it("are not found where there is none", async () => {
    expect((await get("/api/studio/plugins/guestbook/nothing")).status).toBe(404);
    expect((await send("PUT", "/api/studio/plugins/guestbook/")).status).toBe(404);
    expect((await get("/api/studio/plugins/unknown/")).status).toBe(404);
    expect((await get("/api/studio/plugins/broken/")).status).toBe(404);
  });
});

describe("a plugin's tables", () => {
  it("are in every tenant database, each with its own rows", async () => {
    await client.withTenant("tenant-b", async () => {
      const rows = await client.db.run("SELECT count(*) AS n FROM guestbook_entry");
      expect(Number(rows.rows[0].n)).toBe(0);
      const ran = await client.db.run("SELECT plugin, name FROM plugin_migration");
      expect(ran.rows.map((r) => `${r.plugin}/${r.name}`)).toEqual([
        "guestbook/0001_init.sql",
      ]);
    });
  });
});

describe("a plugin's tools", () => {
  const ctx = (emitted: string[]) =>
    ({
      runId: "run-1",
      stepId: "ask",
      tenantId: LOCAL,
      project: { id: "p1", name: "Projekt" },
      def: { title: "Wizard" },
      test: false,
      store: { wizardId: "wizard-1", holder: "u:local" },
      signal: new AbortController().signal,
      emit: async (_type: string, message: string) => {
        emitted.push(message);
      },
    }) as unknown as StepContext;

  it("are accepted by the definition as <plugin>.<tool>", () => {
    const step = (tools: string[]) => ({
      version: 1,
      title: "T",
      description: "",
      avatar: "round",
      steps: [
        { id: "ask", type: "agent", title: "A", instructions: "x", tools },
        { id: "done", type: "result", title: "Fertig", deliverables: [] },
      ],
    });
    expect(wizardSchema.safeParse(step(["http", "guestbook.count"])).success).toBe(true);
    expect(wizardSchema.safeParse(step(["guestbook"])).success).toBe(false);
    expect(wizardSchema.safeParse(step(["Guestbook.count"])).success).toBe(false);
  });

  it("reach an agent step that lists them", async () => {
    const { pluginTools } = await import("../src/tools/plugin");
    const emitted: string[] = [];
    const tools = await client.withTenant(LOCAL, () =>
      pluginTools({ tools: ["http", "guestbook.count"] } as any, ctx(emitted)),
    );
    expect(Object.keys(tools)).toEqual(["guestbook_count"]);
    const result = await client.withTenant(LOCAL, () => tools.guestbook_count.execute({ word: "x" }));
    expect(result).toEqual({ entries: 1, word: "x", project: "Projekt" });
    expect(emitted).toEqual(["Zählt Einträge"]);
  });

  it("answer a step that calls one, with no model", async () => {
    const { runAgentStep } = await import("../src/engine/steps");
    const emitted: string[] = [];
    const step = {
      id: "count",
      type: "agent",
      title: "Zählen",
      instructions: "",
      tools: [],
      call: { tool: "guestbook.count", input: { word: "{{wort}}", unused: "{{leer}}" } },
      output: { format: "json" },
      working: "Zählt nach …",
    };
    const scope = {
      def: { title: "Wizard", steps: [] },
      state: { values: { wort: "Gast", leer: "" }, outputs: {} },
      brand: {},
    };
    const out = await client.withTenant(LOCAL, () =>
      runAgentStep(step as any, { ...ctx(emitted), scope } as any),
    );
    expect(out.json).toEqual({ entries: 1, word: "Gast", project: "Projekt" });
    expect(emitted).toEqual(["Zählt Einträge"]);
    // An input the tool's schema refuses is the step's error, not a model's guess.
    await expect(
      client.withTenant(LOCAL, () =>
        runAgentStep(
          { ...step, call: { tool: "guestbook.count", input: { word: 5 } } } as any,
          { ...ctx([]), scope } as any,
        ),
      ),
    ).rejects.toThrow(/word/);
  });

  it("fail the step that lists one this runtime does not have", async () => {
    const { pluginTools } = await import("../src/tools/plugin");
    await expect(
      client.withTenant(LOCAL, () => pluginTools({ tools: ["crm.lookup"] } as any, ctx([]))),
    ).rejects.toThrow(/crm\.lookup/);
  });

  it("show as an issue of a draft that lists an unknown one", async () => {
    const definition = {
      version: 1,
      title: "Mit Werkzeug",
      description: "",
      avatar: "round",
      steps: [
        { id: "start", type: "page", title: "Start", fields: [{ id: "name", kind: "text", label: "Name" }] },
        { id: "ask", type: "agent", title: "A", instructions: "{{name}}", tools: ["guestbook.count", "crm.lookup"] },
        { id: "done", type: "result", title: "Fertig", deliverables: [] },
      ],
    };
    const issues = await client.withTenant(LOCAL, async () => {
      const created = await wizards.createWizard("local", { definition });
      return wizards.draftIssues(await wizards.ownedWizard("local", created.id));
    });
    expect(issues.map((i) => i.message).filter((m) => m.includes("plugin"))).toEqual([
      expect.stringContaining("“crm.lookup”"),
    ]);
  });
});

describe("a run that ends", () => {
  it("is told to the plugins that listen", async () => {
    const definition = {
      version: 1,
      title: "Gästebuch",
      description: "",
      avatar: "round",
      steps: [
        { id: "start", type: "page", title: "Start", fields: [{ id: "name", kind: "text", label: "Name" }] },
        { id: "done", type: "result", title: "Fertig", deliverables: [] },
      ],
    };
    const runId = await client.withTenant(LOCAL, async () => {
      const created = await wizards.createWizard("local", { definition });
      const w = await wizards.ownedWizard("local", created.id);
      const id = await runner.createRun({
        wizardId: w.id,
        definition: w.draft,
        files: [],
        version: null,
        mode: "test",
        userId: "local",
      });
      await runner.submitPage(id, "start", { name: "Ada" });
      return id;
    });
    const notified = await until(
      async () => ((globalThis as any).__notified ?? []) as any[],
      (list) => list.length > 0,
    );
    expect(notified).toEqual([{ run: runId, mode: "test", title: "Gästebuch", values: { name: "Ada" } }]);
    const list = await until(
      () => json(get("/api/studio/plugins/guestbook")),
      (body) => body.entries.length > 1,
    );
    expect(list.entries.map((e: any) => e.text)).toEqual(["first", "run: Ada"]);
  });
});

describe("while the runtime runs", () => {
  it("a plugin loads again from its files", async () => {
    const before = registry.loadedPlugin("guestbook")!.generation;
    put("guestbook/src/greeting.ts", `export const GREETING = "servus";\n`);
    put(
      "guestbook/migrations/0002_note.sql",
      "ALTER TABLE guestbook_entry ADD COLUMN note TEXT;\n",
    );
    const reloaded = await json(send("POST", "/api/studio/plugins/-/reload/guestbook"));
    expect(reloaded.plugin.generation).toBeGreaterThan(before);
    expect((globalThis as any).__disposed).toBe(1);
    expect((await json(get("/api/studio/plugins/guestbook"))).greeting).toBe("servus");
    // Open databases got the new file; the rows stayed.
    await client.withTenant(LOCAL, async () => {
      const rows = await client.db.run("SELECT text, note FROM guestbook_entry ORDER BY id");
      expect(rows.rows.map((r) => [r.text, r.note])).toEqual([
        ["first", null],
        ["run: Ada", null],
      ]);
    });
  });

  it("a plugin that breaks loses its routes until it is mended", async () => {
    put("guestbook/src/plugin.ts", guestbook(`  throw new Error("typo");\n`));
    await loader.reloadPlugin("guestbook");
    expect(registry.loadedPlugin("guestbook")?.error).toBe("typo");
    expect((await get("/api/studio/plugins/guestbook")).status).toBe(404);
    put("guestbook/src/plugin.ts", guestbook());
    await loader.reloadPlugin("guestbook");
    expect((await get("/api/studio/plugins/guestbook")).status).toBe(200);
  });

  it("a new plugin is found and one that went is unloaded", async () => {
    put(
      "hello/index.ts",
      `export default (wizards: any) => {
  wizards.server.registerHttpRoute({ method: "GET", path: "/", handler: () => ({ hello: wizards.plugin.id }) });
};
`,
    );
    rmSync(join(pluginsDir, "notify.ts"));
    const { plugins } = await json(send("POST", "/api/studio/plugins/-/reload"));
    expect(plugins.map((p: any) => p.id).sort()).toEqual(["broken", "guestbook", "hello", "kiosk"]);
    expect(await json(get("/api/studio/plugins/hello/"))).toEqual({ hello: "hello" });
  });

  it("a look for new plugins leaves the loaded ones as they are", async () => {
    const before = registry.loadedPlugin("guestbook")!.generation;
    put("later.ts", "export default () => {};\n");
    rmSync(join(pluginsDir, "hello"), { recursive: true });
    const seen: unknown[] = [];
    const stop = registry.onPluginChange((change) => seen.push(change));
    await loader.findNewPlugins();
    await loader.findNewPlugins();
    stop();
    expect(
      registry
        .loadedPlugins()
        .map((p) => p.source.id)
        .sort(),
    ).toEqual(["broken", "guestbook", "kiosk", "later"]);
    expect(registry.loadedPlugin("guestbook")!.generation).toBe(before);
    // Told once: the second look found nothing new.
    expect(seen).toEqual([{ id: null }]);
  });

  it("tells an open studio", async () => {
    const seen: unknown[] = [];
    const stop = registry.onPluginChange((change) => seen.push(change));
    await loader.reloadPlugin("later");
    stop();
    expect(seen).toEqual([{ id: "later" }]);
  });
});

describe("a plugin's starters", () => {
  it("are listed first for the tenant, marked with the plugin", async () => {
    const page = await json(get("/api/studio/marketplace?lang=de"));
    expect(page.entries[0]).toMatchObject({
      id: "guestbook.welcome",
      title: "Willkommen",
      pitch: "Fragt Gäste nach ihrem Namen.",
      language: "de",
      starter: true,
      usable: true,
      starred: false,
      plugin: { id: "guestbook", name: "Guestbook" },
    });
    expect(page.all).toBeGreaterThanOrEqual(1);
    expect((await json(get("/api/studio/marketplace?q=Gäste"))).entries[0].id).toBe("guestbook.welcome");
    const detail = await json(get("/api/studio/marketplace/guestbook.welcome?lang=de"));
    expect(detail).toMatchObject({ id: "guestbook.welcome", plugin: { name: "Guestbook" } });
    expect(detail.files.sort()).toEqual(["data/bytes.bin", "notes/greeting.txt"]);
  });

  it("are not shown to someone not signed in, who still gets the gallery", async () => {
    const res = await get("/api/guest/marketplace?lang=de", "");
    expect(res.status).toBe(200);
    const page = await res.json();
    expect(Array.isArray(page.entries)).toBe(true);
    expect(page.entries.some((e: any) => e.plugin || e.starred)).toBe(false);
    expect((await get("/api/studio/marketplace?lang=de", "")).status).toBe(401);
  });

  it("make a wizard with their definition and files", async () => {
    const files = await import("../src/services/files");
    await client.withTenant(LOCAL, async () => {
      const created = await wizards.createWizard("local", { starterId: "guestbook.welcome" });
      const w = await wizards.ownedWizard("local", created.id);
      expect(w).toMatchObject({ title: "Willkommen", starter: "guestbook.welcome", starterRevision: null });
      expect(w.draft.steps.map((s) => s.id)).toEqual(["start", "done"]);
      expect((await files.listFiles("local", w.id)).map((f) => [f.path, f.size])).toEqual([
        ["data/bytes.bin", 3],
        // UTF-8: "ü" and "ß" are two bytes each.
        ["notes/greeting.txt", 11],
      ]);
      expect((await files.readFileText("local", w.id, "notes/greeting.txt")).text).toBe("Grüß Gott");
    });
  });

  it("keep a plugin from loading when one is not a wizard, naming it", async () => {
    put(
      "guestbook/src/plugin.ts",
      guestbook(
        `  server.registerStarter({ id: "empty", title: "Leer", description: "", definition: { title: "Leer", steps: [] } });\n`,
      ),
    );
    await loader.reloadPlugin("guestbook");
    const broken = registry.loadedPlugin("guestbook")!;
    expect(broken.error).toMatch(/^Starter "empty": steps: /);
    expect(broken.starters.size).toBe(0);
    const page = await json(get("/api/studio/marketplace"));
    expect(page.entries.some((e: any) => e.plugin)).toBe(false);
    put("guestbook/src/plugin.ts", guestbook());
    await loader.reloadPlugin("guestbook");
    expect(registry.loadedPlugin("guestbook")?.starters.has("welcome")).toBe(true);
  });
});

describe("a plugin's runners", () => {
  const definition = {
    version: 1,
    title: "Schalter",
    description: "",
    avatar: "round",
    steps: [
      {
        id: "start",
        type: "page",
        title: "Start",
        fields: [{ id: "name", kind: "text", label: "Name", required: true }],
      },
      { id: "done", type: "result", title: "Fertig", deliverables: [] },
    ],
  };
  let wizardId = "";
  let token = "";

  beforeAll(async () => {
    await client.withTenant(LOCAL, async () => {
      wizardId = (await wizards.createWizard("local", { definition })).id;
      await wizards.publishWizard("local", wizardId);
      token = (await wizards.ownedWizard("local", wizardId)).shareToken;
    });
  });

  it("are registered with what they can do, and the studio lists the tenant's runners", async () => {
    const listed = await json(get("/api/studio/runners"));
    expect(listed.map((r: { id: string }) => r.id)).toEqual([
      "steps",
      "chat",
      "talk",
      "video",
      "kiosk",
      "phone",
    ]);
    expect(listed.find((r: { id: string }) => r.id === "kiosk")).toMatchObject({
      kind: "page",
      plugin: "kiosk",
      problem: null,
    });
    // A problem is a text to set up, or says its kind: waiting for someone, not in the plan.
    const phone = async (problem: unknown) => {
      (globalThis as { phoneProblem?: unknown }).phoneProblem = problem;
      const runners = await json(get("/api/studio/runners"));
      return runners.find((r: { id: string }) => r.id === "phone");
    };
    expect(await phone(null)).toMatchObject({ problem: null });
    expect(await phone("Keine Nummer")).toMatchObject({ problem: "Keine Nummer", problemKind: "setup" });
    expect(
      await phone({ text: "Angefragt", kind: "waiting", note: { de: "Nummer angefragt", en: "Number asked for" } }),
    ).toMatchObject({
      problem: "Angefragt",
      problemKind: "waiting",
      problemNote: { de: "Nummer angefragt", en: "Number asked for" },
      problemPlan: null,
    });
    expect(await phone({ text: "Ab Pro", kind: "plan", plan: "Pro" })).toMatchObject({
      problemKind: "plan",
      problemNote: null,
      problemPlan: "Pro",
    });
    (globalThis as { phoneProblem?: unknown }).phoneProblem = null;
    const found = registry.loadedPlugin("kiosk")!.runners;
    expect([...found.keys()]).toEqual(["kiosk", "phone"]);
    expect(found.get("kiosk")!.info).toMatchObject({ kind: "page", plugin: "kiosk" });
    expect(found.get("phone")!.page).toBeUndefined();
  });

  it("a page runner answers at the wizard's address once the owner switched it on", async () => {
    const path = `/api/public/wizards/${token}/runners/kiosk/hello?q=1`;
    expect((await get(path, "")).status).toBe(404);
    await client.withTenant(LOCAL, () =>
      wizards.updateWizardSettings("local", wizardId, {
        runners: { default: "steps", enabled: ["steps", "chat", "kiosk"] },
      }),
    );
    const served = await get(path, "");
    expect(served.status).toBe(200);
    expect(await served.text()).toBe("kiosk for Schalter at /hello?1");
    const offered = await json(get(`/api/public/wizards/${token}`, ""));
    expect(offered.runners.map((r: any) => r.id)).toEqual(["steps", "chat", "kiosk"]);
    expect(offered.runners[2].url).toBe(`http://localhost:5181/api/public/wizards/${token}/runners/kiosk`);
    // A channel runner has no page, and the built-in ones are not served by a plugin.
    expect((await get(`/api/public/wizards/${token}/runners/phone`, "")).status).toBe(404);
    expect((await get(`/api/public/wizards/${token}/runners/chat`, "")).status).toBe(404);
  });

  it("a channel runner drives a run through the run API", async () => {
    const { publicUrlOf } = await import("../src/plugins/public");
    const address = await client.withTenant(LOCAL, () => publicUrlOf("kiosk", `/call/${token}`));
    const res = await app.fetch(
      new Request(address, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answers: { name: "Ada" } }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.refused).toBeNull();
    expect(body.report).toMatchObject({ runId: body.runId, mode: "live", status: "done" });
    expect(body.report.passed).toContain("start");
    expect(body.handoff).toMatch(new RegExp(`^http://localhost:5181/w/${token}/${body.runId}\\?rt=`));
    expect(body.seen.length).toBeGreaterThan(0);
    const run = await client.withTenant(LOCAL, () =>
      client.db.query.run.findFirst({ where: (r, { eq }) => eq(r.id, body.runId) }),
    );
    expect(run).toMatchObject({ runner: "phone", mode: "live", userId: null });
    expect(run!.visitorId).toMatch(/^p:[0-9a-f]{32}$/);
    // The ticket in the hand-off link opens the run's own routes.
    const ticket = new URL(body.handoff).searchParams.get("rt")!;
    expect((await get(`/api/runs/${body.runId}?rt=${encodeURIComponent(ticket)}`, "")).status).toBe(200);
    expect((await get(`/api/runs/${body.runId}?rt=1.forged`, "")).status).toBe(404);
    // The chat's dictation writes a recording down on the run's own route: with the ticket,
    // and only while the run is not over.
    const dictate = (rt: string) =>
      app.fetch(
        new Request(url(`/api/runs/${body.runId}/transcribe?rt=${encodeURIComponent(rt)}`), {
          method: "POST",
          body: new FormData(),
        }),
      );
    expect((await dictate("1.forged")).status).toBe(404);
    expect((await dictate(ticket)).status).toBe(409);
  });

  it("refuses answers that do not fit and says which", async () => {
    const { publicUrlOf } = await import("../src/plugins/public");
    const address = await client.withTenant(LOCAL, () => publicUrlOf("kiosk", `/call/${token}`));
    const body = await json(
      app.fetch(
        new Request(address, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ answers: { name: "" } }),
        }),
      ),
    );
    expect(body.refused).toEqual([{ field: "name", message: "Required" }]);
    expect(body.report.waitingFor.page).toBe("start");
  });
});
