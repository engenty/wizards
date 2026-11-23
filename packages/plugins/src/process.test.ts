import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverPlugins } from "./discovery.js";
import { MANIFEST_FILE } from "./manifest.js";
import { type PluginProcess, startPluginProcess, zodPaths } from "./process.js";

let dir: string;
let data: string;
const started: PluginProcess[] = [];

/** A plugin folder with this server half; starts its process. */
async function plugin(code: string, options: { callMs?: number } = {}) {
  mkdirSync(join(dir, "demo", "src"), { recursive: true });
  writeFileSync(join(dir, "demo", MANIFEST_FILE), JSON.stringify({ id: "demo", name: "Demo" }));
  writeFileSync(join(dir, "demo", "src", "plugin.ts"), code);
  const [source] = discoverPlugins([dir]).found;
  const process = await startPluginProcess({ source, dataDir: data, ...options });
  started.push(process);
  return process;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plugin-process-"));
  data = mkdtempSync(join(tmpdir(), "plugin-data-"));
});
afterEach(async () => {
  await Promise.all(started.splice(0).map((p) => p.stop()));
  rmSync(dir, { recursive: true, force: true });
  rmSync(data, { recursive: true, force: true });
});

const GREET = `
import { definePlugin } from "@engenty/plugins";
import { z } from "zod";

export default definePlugin((api) => {
  api.server.registerTool({
    name: "greet",
    description: "Greets someone.",
    readOnly: true,
    inputSchema: z.object({ who: z.string() }),
    execute: async ({ who }, context) => {
      await context.emit("Greeting " + who);
      return { text: "Hello " + who + " from " + api.plugin.name };
    },
  });
  api.server.registerTool({
    name: "note",
    description: "Writes a note.",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
    execute: async (input) => String(input.text).length,
  });
});
`;

describe("startPluginProcess", () => {
  it("lists the tools with JSON Schema and runs them", async () => {
    const process = await plugin(GREET);
    expect(process.tools).toEqual([
      {
        name: "greet",
        description: "Greets someone.",
        readOnly: true,
        inputSchema: {
          type: "object",
          properties: { who: { type: "string" } },
          required: ["who"],
        },
      },
      {
        name: "note",
        description: "Writes a note.",
        readOnly: false,
        inputSchema: { type: "object", properties: { text: { type: "string" } } },
      },
    ]);
    const lines: string[] = [];
    await expect(
      process.call("greet", { who: "Ada" }, { emit: (line) => lines.push(line) }),
    ).resolves.toEqual({ text: "Hello Ada from Demo" });
    expect(lines).toEqual(["Greeting Ada"]);
    await expect(process.call("note", { text: "abc" })).resolves.toBe(3);
    await expect(process.call("greet", { who: 1 })).rejects.toThrow(/Invalid input/);
  });

  it("loads a plugin written for engenty wizards' import", async () => {
    const process = await plugin(`
      import { definePlugin } from "@engenty/wizards/plugin";
      export default definePlugin((wizards) => {
        wizards.server.registerTool({ name: "ping", description: "Ping.", readOnly: true,
          inputSchema: { type: "object", properties: {} }, execute: () => "pong" });
      });
    `);
    await expect(process.call("ping", {})).resolves.toBe("pong");
  });

  it("holds the plugin to its folders and keeps the host's environment from it", async () => {
    globalThis.process.env.PLUGIN_TEST_SECRET = "s3cret";
    const process = await plugin(`
      import { readFileSync, writeFileSync } from "node:fs";
      const attempt = async (work) => { try { await work(); return "allowed"; } catch (e) { return e.code ?? e.message; } };
      export default (api) => {
        api.server.registerTool({ name: "probe", description: "Probe.", inputSchema: { type: "object" },
          execute: async () => ({
            readOwn: await attempt(() => readFileSync(api.resolvePath("engenty.plugin.json"))),
            readOther: await attempt(() => readFileSync("/etc/hosts")),
            writeData: await attempt(() => writeFileSync("note.txt", "x")),
            writeOwn: await attempt(() => writeFileSync(api.resolvePath("x.txt"), "x")),
            spawn: await attempt(async () => (await import("node:child_process")).execSync("true")),
            env: process.env.PLUGIN_TEST_SECRET ?? null,
          }) });
      };
    `);
    await expect(process.call("probe", {})).resolves.toEqual({
      readOwn: "allowed",
      readOther: "ERR_ACCESS_DENIED",
      writeData: "allowed",
      writeOwn: "ERR_ACCESS_DENIED",
      spawn: "ERR_ACCESS_DENIED",
      env: null,
    });
    delete globalThis.process.env.PLUGIN_TEST_SECRET;
  });

  it("stops a call that runs too long and one the host aborts", async () => {
    const process = await plugin(
      `export default (api) => api.server.registerTool({ name: "wait", description: "Waits.",
        inputSchema: { type: "object" },
        execute: (_input, { signal }) => new Promise((resolve) => signal.addEventListener("abort", () => resolve("stopped"))) });`,
      { callMs: 200 },
    );
    await expect(process.call("wait", {})).rejects.toThrow(/longer than/);
    const controller = new AbortController();
    const call = process.call("wait", {}, { signal: controller.signal });
    controller.abort();
    await expect(call).rejects.toThrow("Stopped.");
    expect(process.running()).toBe(true);
  });

  it("refuses a plugin that fails while it registers", async () => {
    await expect(
      plugin(`export default () => { throw new Error("no key set"); };`),
    ).rejects.toThrow("no key set");
    await expect(
      plugin(
        `export default (api) => api.server.registerTool({ name: "Bad Name", description: "x", inputSchema: {}, execute() {} });`,
      ),
    ).rejects.toThrow(/no tool name/);
  });

  it("rejects what waits when the process ends", async () => {
    const process = await plugin(
      `export default (api) => api.server.registerTool({ name: "die", description: "Dies.",
        inputSchema: { type: "object" }, execute: () => process.exit(3) });`,
    );
    await expect(process.call("die", {})).rejects.toThrow(/stopped \(ended with code 3\)/);
    expect(process.running()).toBe(false);
  });
});

describe("zodPaths", () => {
  it("allows zod where Node finds it through a link, as pnpm installs it, and where the link leads", () => {
    const store = join(dir, "store", "zod");
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, "package.json"), JSON.stringify({ name: "zod", main: "index.js" }));
    writeFileSync(join(store, "index.js"), "");
    const pkg = join(dir, ".pnpm", "plugins", "node_modules");
    mkdirSync(join(pkg, "@engenty", "plugins", "dist"), { recursive: true });
    symlinkSync(store, join(pkg, "zod"), "dir");
    expect(zodPaths(join(pkg, "@engenty", "plugins", "dist"))).toEqual([
      join(pkg, "zod"),
      realpathSync(store),
    ]);
  });
});
