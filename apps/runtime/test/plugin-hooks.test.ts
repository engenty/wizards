import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { StepContext } from "../src/engine/types";

// The hooks a plugin uses to reach the space: the steps' instructions and tools, the search
// index, the assistant, jobs, public routes, events, the web and documents.

const dir = mkdtempSync(join(tmpdir(), "wizards-plugin-hooks-"));
const pluginsDir = join(dir, "plugins");
process.env.DATA_DIR = join(dir, "data");
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.PLUGINS_DIR = pluginsDir;
process.env.PLUGINS_WATCH = "0";
process.env.PLUGIN_JOBS = "0";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";

function put(path: string, content: string) {
  const file = join(pluginsDir, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

put(
  "atlas/engenty.plugin.json",
  JSON.stringify({ id: "atlas", name: "Atlas", version: "0.1.0" }),
);
put(
  "atlas/src/plugin.ts",
  `import { definePlugin } from "@engenty/wizards/plugin";
import { z } from "zod";

const seen = ((globalThis as any).__atlas ??= { events: [], ticks: [] });

export default definePlugin(({ server }) => {
  server.registerSpaceContext({
    block: (space) => \`# WHAT ATLAS KNOWS\\nThe map of \${space.name}. Look things up with atlas_lookup.\`,
    tools: [
      {
        name: "lookup",
        description: "Looks a place up.",
        inputSchema: z.object({ q: z.string() }),
        execute: async ({ q }, ctx) => {
          await ctx.emit("Schlägt nach");
          return { q, space: ctx.space.id };
        },
      },
    ],
  });
  // Nothing to say for a space: neither a block nor its tool.
  server.registerSpaceContext({
    block: () => null,
    tools: [{ name: "silent", description: "Never there.", inputSchema: z.object({}), execute: () => null }],
  });
  server.registerAssistantTool({
    name: "propose",
    description: "Proposes a source.",
    inputSchema: z.object({ url: z.string() }),
    card: true,
    execute: async ({ url }, ctx) => {
      ctx.emit("Schaut nach");
      ctx.changed();
      return { url, space: ctx.space.id };
    },
  });
  server.registerAssistantTool({
    name: "quiet",
    description: "Answers the model only.",
    inputSchema: z.object({}),
    execute: () => ({ ok: true }),
  });
  server.registerHttpRoute({
    method: "POST",
    path: "/index",
    handler: async (request) => {
      await server.index.put(await request.json());
      return { ok: true };
    },
  });
  server.registerHttpRoute({
    method: "DELETE",
    path: "/index/:space/:key",
    handler: async ({ params }) => {
      await server.index.remove(params.space, params.key === "*" ? undefined : params.key);
      return { ok: true };
    },
  });
  server.registerHttpRoute({
    method: "GET",
    path: "/address",
    handler: async () => ({ url: await server.publicUrl("/signal") }),
  });
  server.registerHttpRoute({
    method: "GET",
    path: "/guard",
    handler: async () => {
      try {
        await server.web.fetch("http://127.0.0.1:9/");
        return { refused: null };
      } catch (err) {
        return { refused: (err as Error).message };
      }
    },
  });
  server.registerHttpRoute({
    method: "POST",
    path: "/parse",
    handler: async (request) => {
      const { text } = await request.json<{ text: string }>();
      return server.documents.parse({ data: new TextEncoder().encode(text), name: "zeiten.csv", mime: "text/csv" });
    },
  });
  server.registerPublicRoute({
    method: "POST",
    path: "/signal",
    handler: async (request) => ({ tenant: request.tenantId, body: await request.json() }),
  });
  server.every("sweep", 1000, (tick) => {
    seen.ticks.push({ tenant: tick.tenantId, lastRun: tick.lastRun });
  });
  for (const event of ["space.created", "space.updated", "space.file.removed"] as const) {
    server.on(event, (payload) => {
      seen.events.push({ event, space: payload.space.id });
    });
  }
});
`,
);

type App = { fetch: (req: Request) => Response | Promise<Response> };
let app: App;
let client: typeof import("../src/db/client");
let cookie = "";
let spaceId = "";

const LOCAL = "local";
const seen = () => (globalThis as any).__atlas as { events: any[]; ticks: any[] };
const url = (path: string) => `http://localhost:5181${path}`;
const send = (method: string, path: string, body?: unknown, as = cookie) =>
  app.fetch(
    new Request(url(path), {
      method,
      headers: { cookie: as, "content-type": "application/json", origin: "http://localhost:5181" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
const json = async (res: Response | Promise<Response>) => (await res).json() as Promise<any>;

async function until<T>(read: () => T | Promise<T>, done: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = await read();
    if (done(value)) {
      return value;
    }
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error("timed out");
}

/** An agent step of the space, as far as the hooks look at it. */
const stepOf = (emitted: string[] = []) =>
  ({
    runId: "run-1",
    stepId: "ask",
    tenantId: LOCAL,
    project: { id: spaceId, name: "Ahorn" },
    projectFiles: [],
    def: { title: "Wizard" },
    test: false,
    store: { wizardId: "wizard-1", holder: "u:local" },
    signal: new AbortController().signal,
    emit: async (_type: string, message: string) => {
      emitted.push(message);
    },
  }) as unknown as StepContext;

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  const loader = await import("../src/plugins/loader");
  await loader.loadPlugins();
  await client.openTenantDb(LOCAL);
  app = (await import("../src/app")).default;
  const entered = await app.fetch(new Request(url("/api/local/enter?k=test-key")));
  cookie = (entered.headers.get("set-cookie") ?? "").split(";")[0];
  const projects = await import("../src/services/projects");
  spaceId = (await client.withTenant(LOCAL, () => projects.defaultProject("local"))).id;
}, 60_000);

describe("a space's events", () => {
  it("tell when a space is made and changed", async () => {
    const projects = await import("../src/services/projects");
    await client.withTenant(LOCAL, () =>
      projects.updateProject("local", spaceId, { brand: { name: "Tischlerei Ahorn" } }),
    );
    const events = await until(
      () => seen().events,
      (list) => list.some((e) => e.event === "space.updated"),
    );
    expect(events).toEqual([
      { event: "space.created", space: spaceId },
      { event: "space.updated", space: spaceId },
    ]);
  });
});

describe("a space context", () => {
  it("adds its block and its tools to an agent step", async () => {
    const { spaceContextOf } = await import("../src/tools/plugin");
    const emitted: string[] = [];
    const step = stepOf(emitted);
    const context = await client.withTenant(LOCAL, () => spaceContextOf(step));
    expect(context.blocks).toEqual([
      "# WHAT ATLAS KNOWS\nThe map of Ahorn. Look things up with atlas_lookup.",
    ]);
    expect(Object.keys(context.tools)).toEqual(["atlas_lookup"]);
    expect(await client.withTenant(LOCAL, () => context.tools.atlas_lookup.execute({ q: "Wien" }))).toEqual(
      { q: "Wien", space: spaceId },
    );
    expect(emitted).toEqual(["Schlägt nach"]);
    // Asked once per step: the instructions and the tools see the same.
    expect(await client.withTenant(LOCAL, () => spaceContextOf(step))).toBe(context);
  });
});

describe("the search index", () => {
  const hours = {
    key: "hours",
    title: "Öffnungszeiten",
    text: "Die Werkstatt hat Montag bis Freitag von 8 bis 17 Uhr geöffnet.",
    link: "/space#atlas",
  };

  it("finds what a plugin put in, beside the documents", async () => {
    expect(await json(send("POST", "/api/studio/plugins/atlas/index", { ...hours, space: spaceId }))).toEqual({
      ok: true,
    });
    const { searchKnowledge, hasIndexEntries } = await import("../src/services/project-index");
    const found = await client.withTenant(LOCAL, () =>
      searchKnowledge(spaceId, "Werkstatt geöffnet"),
    );
    expect(found.hits).toEqual([
      expect.objectContaining({
        key: "x:atlas:hours",
        kind: "plugin",
        plugin: "atlas",
        title: "Öffnungszeiten",
        link: "/space#atlas",
        text: expect.stringContaining("Montag bis Freitag"),
      }),
    ]);
    expect(await client.withTenant(LOCAL, () => hasIndexEntries(spaceId))).toBe(true);
  });

  it("gives the steps project_search without documents", async () => {
    const { projectTools } = await import("../src/tools/project");
    const tools = await client.withTenant(LOCAL, () => projectTools(stepOf()));
    expect(Object.keys(tools)).toEqual(["project_search", "project_list"]);
  });

  it("replaces a key that is put again, and takes keys out", async () => {
    const { searchKnowledge } = await import("../src/services/project-index");
    const search = async (q: string) =>
      (await client.withTenant(LOCAL, () => searchKnowledge(spaceId, q))).hits;
    await send("POST", "/api/studio/plugins/atlas/index", {
      ...hours,
      space: spaceId,
      text: "Samstags nach Vereinbarung.",
    });
    expect(await search("Freitag")).toEqual([]);
    expect((await search("Samstags")).map((h) => h.title)).toEqual(["Öffnungszeiten"]);
    await send("DELETE", `/api/studio/plugins/atlas/index/${spaceId}/*`);
    expect(await search("Samstags")).toEqual([]);
  });

  it("refuses a space that is not there", async () => {
    const res = await send("POST", "/api/studio/plugins/atlas/index", { ...hours, space: "nowhere" });
    expect(res.status).toBe(404);
  });
});

describe("the space assistant", () => {
  it("gets the plugins' tools, and hands a card's result to the chat", async () => {
    const { assistantToolsOf } = await import("../src/tools/plugin");
    const told: string[] = [];
    const cards: unknown[] = [];
    let changed = 0;
    const tools = await client.withTenant(LOCAL, () =>
      assistantToolsOf({
        tenantId: LOCAL,
        space: { id: spaceId, name: "Ahorn" },
        userId: "local",
        signal: new AbortController().signal,
        emit: (message) => told.push(message),
        changed: () => {
          changed++;
        },
        card: (card) => cards.push(card),
      }),
    );
    expect(Object.keys(tools).sort()).toEqual(["atlas_propose", "atlas_quiet"]);
    const result = await tools.atlas_propose.execute({ url: "ahorn.example" });
    expect(result).toEqual({ url: "ahorn.example", space: spaceId });
    expect(told).toEqual(["Schaut nach"]);
    expect(changed).toBe(1);
    expect(cards).toEqual([{ plugin: "atlas", tool: "propose", data: result }]);
    await tools.atlas_quiet.execute({});
    expect(cards).toHaveLength(1);
  });
});

describe("a job", () => {
  it("runs once per turn and tenant, and counts from its last run", async () => {
    const { runDueJobs } = await import("../src/plugins/jobs");
    const start = new Date("2026-10-06T10:00:00Z");
    await runDueJobs(start);
    expect(seen().ticks).toEqual([{ tenant: LOCAL, lastRun: null }]);
    // At least a minute between turns, though the plugin asked for a second.
    await runDueJobs(new Date(start.getTime() + 30_000));
    expect(seen().ticks).toHaveLength(1);
    await runDueJobs(new Date(start.getTime() + 61_000));
    expect(seen().ticks).toEqual([
      { tenant: LOCAL, lastRun: null },
      { tenant: LOCAL, lastRun: start },
    ]);
  });
});

describe("a public route", () => {
  it("answers anyone at the address the plugin hands out, inside its tenant", async () => {
    const { url: address } = await json(send("GET", "/api/studio/plugins/atlas/address"));
    expect(address).toMatch(/^http:\/\/localhost:5181\/api\/public\/plugins\/atlas\/[\w-]{24}\/signal$/);
    expect((await json(send("GET", "/api/studio/plugins/atlas/address"))).url).toBe(address);
    const path = new URL(address).pathname;
    const res = await send("POST", path, { changed: ["/preise"] }, "");
    expect(await res.json()).toEqual({ tenant: LOCAL, body: { changed: ["/preise"] } });
  });

  it("is not found at an address it did not hand out", async () => {
    const { url: address } = await json(send("GET", "/api/studio/plugins/atlas/address"));
    const path = new URL(address).pathname;
    expect((await send("POST", path.replace(/\/[\w-]{24}\//, "/not-a-ref-of-anyone-here/"), {}, "")).status).toBe(404);
    expect((await send("POST", path.replace("/atlas/", "/other/"), {}, "")).status).toBe(404);
    expect((await send("GET", path, undefined, "")).status).toBe(404);
  });
});

describe("the web and documents", () => {
  it("keep a plugin's requests off this machine and the local network", async () => {
    const { refused } = await json(send("GET", "/api/studio/plugins/atlas/guard"));
    expect(refused).toBeTruthy();
  });

  it("read a file as Markdown", async () => {
    const parsed = await json(
      send("POST", "/api/studio/plugins/atlas/parse", { text: "Tag;Von;Bis\nMontag;8;17\n" }),
    );
    expect(parsed.markdown).toContain("Montag");
  });
});
