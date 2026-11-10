import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TOOL_IDS } from "@engenty/wizards-shared/definition";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Every tool has a descriptor (broker/registry.ts): what it is about, what it does there, its
 * kind. This walks the step's tools (`TOOL_IDS`), the catalogue's and every tool the source makes
 * by a fixed name, and fails on one without. With `runServices` on, a step's call of a tool that
 * had no line of the broker's log has one; with it off, none.
 */
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wizards-tool-descriptors-"));
process.env.APP_URL = "http://localhost:5181";
delete process.env.FEATURES;

let client: typeof import("../src/db/client");
let registry: typeof import("../src/broker/registry");
let acted: typeof import("../src/tools/acted");
let names: readonly string[];
let codeTool: string;

const TENANT = "tenant-d";
const inTenant = <T>(fn: () => Promise<T>) => client.withTenant(TENANT, fn);

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  await client.openTenantDb(TENANT);
  registry = await import("../src/broker/registry");
  acted = await import("../src/tools/acted");
  names = (await import("../src/elements/catalogue")).ELEMENT_TOOL_NAMES;
  codeTool = (await import("../src/tools/code")).CODE_TOOL_ID;
});

afterAll(() => {
  delete process.env.FEATURES;
});

const SRC = resolve(__dirname, "../src");

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("every tool has a descriptor", () => {
  it("every tool a step can list brings tools with one", () => {
    const described = Object.values(registry.toolDescriptors());
    const without = TOOL_IDS.filter((id) => !described.some((d) => d.tool === id));
    expect(without).toEqual([]);
    expect(registry.descriptorOf("web_search")?.tool).toBe("web_search");
    expect(registry.descriptorOf("web_fetch")?.tool).toBe("web_fetch");
    expect(registry.descriptorOf(codeTool)?.tool).toBe("code");
  });

  it("every tool of the catalogue", () => {
    expect(names.filter((name) => !registry.descriptorOf(name))).toEqual([]);
  });

  it("every tool of a step or the catalogue the source makes by a fixed name", () => {
    const made = new Set<string>();
    for (const path of [...walk(join(SRC, "tools")), ...walk(join(SRC, "elements"))]) {
      for (const m of readFileSync(path, "utf8").matchAll(/createTool\(\{\s*id:\s*"([a-z_]+)"/g)) {
        made.add(m[1]);
      }
    }
    expect(made).toContain("browser_open");
    expect(made).toContain("list_write");
    expect([...made].filter((name) => !registry.descriptorOf(name))).toEqual([]);
  });

  it("names a resource, an action and one of the broker's kinds", () => {
    for (const [name, d] of Object.entries(registry.toolDescriptors())) {
      expect(d.resource, name).toMatch(/^[a-z_]+$/);
      expect(d.action, name).toMatch(/^[a-z_]+$/);
      expect(["read", "write", "destructive", "send"], name).toContain(d.kind);
    }
  });

  it("decides whether a step's call only looks: the descriptor's kind", () => {
    expect(acted.onlyReads("web_fetch")).toBe(true);
    expect(acted.onlyReads("browser_read")).toBe(true);
    expect(acted.onlyReads("browser_open")).toBe(false);
    expect(acted.onlyReads("list_write")).toBe(false);
    expect(acted.onlyReads("some_plugin_tool")).toBe(false);
  });

  it("describes a connection's tool by what it reaches", () => {
    registry.reachesOutside("crm_list_deals", { connection: "c1", action: "list", kind: "read" });
    registry.reachesOutside("crm_mixed", [
      { connection: "c1", action: "list", kind: "read" },
      { connection: "c1", action: "delete", kind: "destructive" },
    ]);
    expect(registry.descriptorOf("crm_list_deals")).toEqual({
      resource: "c1",
      action: "list",
      kind: "read",
      logged: true,
    });
    expect(registry.descriptorOf("crm_mixed")?.kind).toBe("destructive");
    expect(acted.onlyReads("crm_mixed")).toBe(false);
  });
});

describe("a line of the broker's log per call", () => {
  const base = (runId: string) => ({
    whoKind: "person",
    whoId: "user-a",
    runId,
    stepId: "s1",
    client: null,
    chatId: null,
    wizardId: "w1",
    spaceId: "sp1",
  });
  const toolsOf = () => ({
    web_fetch: { execute: async (_: unknown) => ({ status: 200, content: "Hallo" }) },
    // The gate writes the line of a data call.
    data_query: { execute: async (_: unknown) => ({ rows: [] }) },
    page_read: { execute: async (_: unknown) => ({ title: "Notizen", markdown: "x" }) },
    unknown_tool: { execute: async (_: unknown) => ({ done: true }) },
  });
  const linesOf = (runId: string) =>
    inTenant(() =>
      client.db.query.brokerLog.findMany({ where: (t, { eq }) => eq(t.runId, runId) }),
    );
  const callAll = (tools: ReturnType<typeof toolsOf>) =>
    inTenant(async () => {
      await tools.web_fetch.execute({ url: "https://example.org/a?key=geheim#x" });
      await tools.data_query.execute({ sql: "select 1" });
      // By a path it reads Knowledge, whose gate writes the line; by a title, it has its own.
      await tools.page_read.execute({ path: "pages/a" });
      await tools.page_read.execute({ title: "Notizen" });
      await tools.unknown_tool.execute({});
    });

  it("with the switch on: one line for each call no other path logs", async () => {
    process.env.FEATURES = "runServices=on";
    const tools = toolsOf();
    await acted.logCalls(tools, base("run-on"));
    await callAll(tools);
    const lines = await linesOf("run-on");
    expect(lines.map((l) => [l.connectionId, l.actionId, l.kind, l.result])).toEqual(
      expect.arrayContaining([
        ["web", "fetch", "read", "ok"],
        ["pages", "read", "read", "ok"],
      ]),
    );
    expect(lines).toHaveLength(2);
    const fetched = lines.find((l) => l.connectionId === "web")!;
    expect(fetched).toMatchObject({ whoKind: "person", stepId: "s1", outcome: "allow" });
    expect(fetched.inputSummary).toContain("https://example.org/a");
    expect(fetched.inputSummary).not.toContain("geheim");
  });

  it("with the switch off: none", async () => {
    process.env.FEATURES = "runServices=off";
    const tools = toolsOf();
    await acted.logCalls(tools, base("run-off"));
    await callAll(tools);
    expect(await linesOf("run-off")).toEqual([]);
  });
});
