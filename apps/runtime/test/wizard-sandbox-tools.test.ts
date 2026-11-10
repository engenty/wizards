import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { WorkspaceFile } from "@engenty/wizards-shared/workspace";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agentOsVms } from "../../sandbox/src/agentos.ts";
import { sandboxServer } from "../../sandbox/src/server.ts";
import { type MakeVm, NotFound, type Vm } from "../../sandbox/src/vm.ts";

// A wizard's sandbox tools (docs/plans/wizard-code.md): tools/<name>/TOOL.md and its scripts,
// copied into the run's sandbox, called with input.json, read back from output.json and out/.
// First in a sandbox that is a shell in a folder of its own, then through the sandbox
// container's API (apps/sandbox) as the cloud reaches it: with a shell VM everywhere, with
// agentOS where it is installed. The wizard's skill scripts run there too.

const dir = mkdtempSync(join(tmpdir(), "wizards-sandbox-tools-"));
process.env.DATA_DIR = join(dir, "data");
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.PLUGINS_DIR = join(dir, "plugins");
process.env.PLUGINS_WATCH = "0";
process.env.PLUGIN_JOBS = "0";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.FEATURES = "skills=on";

/** A file the person gave, as resolveFile hands it over. */
vi.mock("../src/tools/store.js", async (original) => ({
  ...(await original<typeof import("../src/tools/store.js")>()),
  resolveFile: async (_ctx: unknown, ref: string) => {
    if (ref !== "upload:a1") {
      throw new Error(`No upload ${ref}.`);
    }
    return {
      data: new TextEncoder().encode("item,price\nbolt,1.5\nnut,0.25\n"),
      name: "Preisliste März.csv",
      mime: "text/csv",
    };
  },
}));

const TOOL_MD = [
  "---",
  "description: Converts a supplier's price list into our item table",
  "input:",
  "  type: object",
  "  properties:",
  "    file: { type: string }",
  "    factor: { type: number }",
  "  required: [file]",
  "output:",
  "  type: object",
  "  properties:",
  "    items: { type: array }",
  "    calls: { type: number }",
  "  required: [items]",
  "run: node convert.js",
  "---",
  "Reads the CSV, multiplies each price.",
].join("\n");

/** Reads the file the input names, writes the items and a CSV in out/; counts its calls. */
const CONVERT_JS = `
const fs = require("fs");
const input = JSON.parse(fs.readFileSync("input.json", "utf8"));
const factor = input.factor ?? 1;
const rows = fs.readFileSync(input.file, "utf8").trim().split("\\n").slice(1).map((line) => {
  const [item, price] = line.split(",");
  return { item, eur: Number(price) * factor };
});
// What a call leaves in the folder stays for the next call of the run.
const calls = (fs.existsSync("calls.txt") ? Number(fs.readFileSync("calls.txt", "utf8")) : 0) + 1;
fs.writeFileSync("calls.txt", String(calls));
fs.mkdirSync("out/tables", { recursive: true });
fs.writeFileSync("out/tables/items.csv", "item,eur\\n" + rows.map((r) => r.item + "," + r.eur).join("\\n") + "\\n");
fs.writeFileSync("output.json", JSON.stringify(input.broken ? { items: "none" } : { items: rows, calls }));
if (input.fail) { console.error("no such column"); process.exit(3); }
`;

const SKILL_MD = [
  "---",
  "name: counter",
  "description: Counts the rows of a file.",
  "---",
  "",
  "Run [count.py](scripts/count.py) on the file.",
].join("\n");
const COUNT_PY = [
  "import json, sys",
  "rows = open(sys.argv[1]).read().splitlines()",
  'print(json.dumps({"rows": len(rows)}))',
].join("\n");

const WIZARD_FILES = {
  "tools/convert/TOOL.md": TOOL_MD,
  "tools/convert/convert.js": CONVERT_JS,
  "skills/counter/SKILL.md": SKILL_MD,
  "skills/counter/scripts/count.py": COUNT_PY,
  "prices.csv": "item,price\n",
};

let client: typeof import("../src/db/client");
let spaceId = "";
const local = <T>(fn: () => T | Promise<T>) => client.withTenant("local", fn);

async function workspace(files: Record<string, string>): Promise<WorkspaceFile[]> {
  const { putBlob } = await import("../src/files/blobs");
  const { mimeForPath } = await import("@engenty/wizards-shared/workspace");
  const out: WorkspaceFile[] = [];
  for (const [path, content] of Object.entries(files)) {
    const data = new TextEncoder().encode(content);
    out.push({ path, hash: await putBlob(data), mime: mimeForPath(path), size: data.length });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** A step's context with the wizard's files; saved assets land in `saved`. */
function stepContext(files: WorkspaceFile[], runId: string) {
  const saved: { name: string; mime: string; kind: string; data: string }[] = [];
  const ctx = {
    tenantId: "local",
    runId,
    stepId: "work",
    space: { id: spaceId },
    dataSpace: { id: spaceId, name: "" },
    files,
    signal: new AbortController().signal,
    holder: { kind: "person", id: "local", role: "owner" },
    store: { holder: "u:local", wizardId: "w1" },
    emit: async () => undefined,
    saveAsset: async (input: { name: string; mime: string; kind: string; data: Buffer }) => {
      saved.push({ ...input, data: input.data.toString("utf8") });
      return { id: `asset-${saved.length}`, kind: input.kind, mime: input.mime, name: input.name };
    },
  };
  return { ctx: ctx as never, saved };
}

/** Runs a command with bash in `cwd`, as a sandbox's shell would. */
function shell(command: string, cwd: string, timeoutMs = 60_000) {
  return new Promise<{ stdout: string; stderr: string; exitCode: number }>((done) => {
    const child = spawn("bash", ["-c", command], { cwd, timeout: timeoutMs });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("close", (code) => done({ stdout, stderr, exitCode: code ?? 1 }));
  });
}

/** A run's sandbox that is a shell in a folder of its own: the runtime's Sandbox. */
function shellSandbox() {
  const root = mkdtempSync(join(dir, "box-"));
  const at = (path: string) => resolve(root, path);
  const commands: string[] = [];
  const sandbox = {
    capabilities: { commands: ["bash"], network: "none", uses: "", workdir: root },
    exec: async (command: string, options: { timeoutMs?: number } = {}) => {
      commands.push(command);
      return shell(command, root, options.timeoutMs);
    },
    writeFile: async (path: string, data: string | Uint8Array) => {
      mkdirSync(dirname(at(path)), { recursive: true });
      writeFileSync(at(path), data);
    },
    readFile: async (path: string) => new Uint8Array(readFileSync(at(path))),
    destroy: async () => undefined,
  };
  return { sandbox, commands };
}

/** The sandbox container's VM as a shell in a folder of its own: apps/sandbox's Vm. */
const shellVms: MakeVm = async () => {
  const root = mkdtempSync(join(dir, "vm-"));
  const at = (path: string) => resolve(root, path);
  const vm: Vm = {
    exec: ({ command, cwd, timeoutMs }) => shell(command, cwd ? at(cwd) : root, timeoutMs),
    writeFile: async (path, data) => {
      mkdirSync(dirname(at(path)), { recursive: true });
      writeFileSync(at(path), data);
    },
    readFile: async (path) => {
      if (!existsSync(at(path)) || statSync(at(path)).isDirectory()) {
        throw new NotFound(path);
      }
      return new Uint8Array(readFileSync(at(path)));
    },
    list: async (path) =>
      readdirSync(at(path), { withFileTypes: true }).map((e) => ({
        name: e.name,
        type: e.isDirectory() ? ("directory" as const) : ("file" as const),
      })),
    dispose: async () => undefined,
  };
  return vm;
};

async function convertTool(files: WorkspaceFile[], sandbox: unknown, runId: string) {
  const { loadWizardTool } = await import("../src/engine/wizard-code");
  const { sandboxTool } = await import("../src/tools/wizard-sandbox");
  const { getBlob } = await import("../src/files/blobs");
  const loaded = await loadWizardTool(
    "convert",
    files.map((f) => f.path),
    async (path) => {
      const file = files.find((f) => f.path === path);
      return file ? (await getBlob(file.hash)).toString("utf8") : null;
    },
  );
  if (!(loaded?.ok && loaded.tool.kind === "sandbox")) {
    throw new Error("convert doesn't load");
  }
  const { ctx, saved } = stepContext(files, runId);
  const assets: unknown[] = [];
  const tool = sandboxTool(
    "wizard.convert",
    "wizard_convert",
    loaded.tool,
    ctx,
    () => sandbox as never,
    { assets: assets as never, uploads: [{ ref: "upload:a1", name: "Preisliste März.csv", mime: "text/csv", field: "Liste" }] },
  );
  return { tool: tool as unknown as { execute: (input: unknown) => Promise<any>; description: string }, saved, assets };
}

const logOf = (runId: string) =>
  local(() =>
    client.db.select().from(client.schema.brokerLog).where(eq(client.schema.brokerLog.runId, runId)),
  );

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  await client.openTenantDb("local");
  const spaces = await import("../src/services/spaces");
  spaceId = (await local(() => spaces.defaultSpace("local"))).id;
}, 60_000);

describe("a sandbox tool", { timeout: 60_000 }, () => {
  it("runs in the run's sandbox: the upload in, input.json, output.json and out/ back", async () => {
    const { sandbox, commands } = shellSandbox();
    await local(async () => {
      const files = await workspace(WIZARD_FILES);
      const { tool, saved, assets } = await convertTool(files, sandbox, "run-tool-1");
      expect(tool.description).toContain("upload:a1 (Preisliste März.csv)");

      const first = await tool.execute({ file: "upload:a1", factor: 2 });
      expect(first).toEqual({
        output: {
          items: [
            { item: "bolt", eur: 3 },
            { item: "nut", eur: 0.5 },
          ],
          calls: 1,
        },
        files: [{ name: "tables/items.csv", assetId: "asset-1" }],
      });
      expect(saved).toEqual([
        { name: "items.csv", mime: "text/csv", kind: "file", data: "item,eur\nbolt,3\nnut,0.5\n" },
      ]);
      expect(assets).toHaveLength(1);
      const root = sandbox.capabilities.workdir;
      expect(JSON.parse(readFileSync(join(root, "tools/convert/input.json"), "utf8"))).toEqual({
        file: "in/Preisliste_M_rz.csv",
        factor: 2,
      });
      expect(readFileSync(join(root, "tools/convert/TOOL.md"), "utf8")).toBe(TOOL_MD);

      // The folder is copied once; what a call leaves stays for the next.
      const second = await tool.execute({ file: "upload:a1" });
      expect(second.output.calls).toBe(2);
      expect(commands.filter((c) => c.startsWith("rm -rf tools/convert &&"))).toHaveLength(1);

      expect(await logOf("run-tool-1")).toContainEqual(
        expect.objectContaining({
          connectionId: "tool:wizard.convert",
          actionId: "wizard.convert",
          kind: "run",
          result: "ok",
        }),
      );
    });
  });

  it("hands a failing command and an output that doesn't fit back to the model", async () => {
    const { sandbox } = shellSandbox();
    await local(async () => {
      const { tool } = await convertTool(await workspace(WIZARD_FILES), sandbox, "run-tool-2");
      const failed = await tool.execute({ file: "upload:a1", fail: true });
      expect(failed.error).toContain("exit code 3");
      expect(failed.stderr).toContain("no such column");
      const unfit = await tool.execute({ file: "upload:a1", broken: true });
      expect(unfit.error).toContain("output schema");
      const gone = await tool.execute({ file: "upload:zz" });
      expect(gone.error).toBe("No upload upload:zz.");
      expect((await logOf("run-tool-2")).map((l) => l.result).sort()).toEqual([
        "Error",
        "failed",
        "output_unfit",
      ]);
    });
  });
});

describe("a step that names a sandbox tool", () => {
  const step = (hosts?: string[]) =>
    ({
      id: "work",
      type: "agent",
      title: "Work",
      instructions: "Convert it.",
      tools: ["wizard.convert"],
      ...(hosts ? { hosts } : {}),
      output: { format: "text" },
    }) as never;
  const withHost = {
    ...WIZARD_FILES,
    "tools/convert/TOOL.md": TOOL_MD.replace("run: node convert.js", "run: node convert.js\nhosts: [api.example.com]"),
  };
  const build = async (files: Record<string, string>, hosts: string[] | undefined, sandbox: boolean) => {
    const { wizardTools } = await import("../src/tools/wizard");
    const { ctx } = stepContext(await workspace(files), "run-step");
    const box = shellSandbox().sandbox;
    Object.assign(ctx, {
      resources: {
        runSandboxCapabilities: async () => (sandbox ? box.capabilities : null),
        sandboxHandle: () => box,
      },
    });
    return wizardTools(step(hosts), ctx, {}, {}, { assets: [], uploads: [] });
  };

  it("gets it as a tool where the run has a sandbox and the step lists its hosts", async () => {
    await local(async () => {
      const tools = await build(withHost, ["*.example.com"], true);
      expect(Object.keys(tools)).toEqual(["wizard_convert"]);
      expect(tools.wizard_convert.description).toBe(
        "Converts a supplier's price list into our item table",
      );
    });
  });

  it("fails where the step doesn't list its hosts, or the run has no sandbox", async () => {
    await local(async () => {
      await expect(build(withHost, ["other.example.org"], true)).rejects.toThrow(
        "it reaches api.example.com, which the step doesn't list in its hosts.",
      );
      await expect(build(WIZARD_FILES, undefined, false)).rejects.toThrow(
        "runs in a sandbox, and this run has none here",
      );
    });
  });
});

/** Installed with `pnpm sandbox:add agentos` (SANDBOX_ENGINES_DIR moves it), as the image does. */
const agentOsDir =
  process.env.AGENTOS_DIR ||
  join(process.env.SANDBOX_ENGINES_DIR || join(homedir(), ".engenty", "wizards", "engines"), "agentos");

const containers: { name: string; skip: boolean; vms: () => Promise<{ makeVm: MakeVm; stop(): Promise<void> }> }[] = [
  { name: "a shell VM", skip: false, vms: async () => ({ makeVm: shellVms, stop: async () => undefined }) },
  {
    name: "agentOS",
    skip: !existsSync(join(agentOsDir, "engine.json")),
    vms: () => agentOsVms(agentOsDir, 4, 300_000),
  },
];

for (const container of containers) {
  describe.skipIf(container.skip)(`through the sandbox container, with ${container.name}`, { timeout: 300_000 }, () => {
    const SECRET = "c".repeat(40);
    let api: ReturnType<typeof sandboxServer>;
    let stop: () => Promise<void>;
    let url = "";

    beforeAll(async () => {
      const vms = await container.vms();
      stop = vms.stop;
      api = sandboxServer({
        secret: SECRET,
        maxVms: 4,
        idleMs: 600_000,
        maxExecMs: 300_000,
        maxFileBytes: 10 * 1024 * 1024,
        makeVm: vms.makeVm,
        log: () => undefined,
      });
      api.server.listen(0, "127.0.0.1");
      await new Promise((ok) => api.server.once("listening", ok));
      url = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
    }, 120_000);

    afterAll(async () => {
      await api?.close();
      await stop?.();
    }, 60_000);

    const remote = async (runId: string) => {
      const { RemoteAgentOsSandbox } = await import("../src/sandbox/agentos-remote");
      return new RemoteAgentOsSandbox(runId, { url, secret: SECRET }, []);
    };

    it("runs a sandbox tool", async () => {
      const sandbox = await remote("run-remote-tool");
      await local(async () => {
        const { tool, saved } = await convertTool(await workspace(WIZARD_FILES), sandbox, "run-remote-tool");
        const answer = await tool.execute({ file: "upload:a1", factor: 2 });
        expect(answer).toMatchObject({
          output: { items: [{ item: "bolt", eur: 3 }, { item: "nut", eur: 0.5 }], calls: 1 },
          files: [{ name: "tables/items.csv" }],
        });
        expect(saved[0]?.data).toBe("item,eur\nbolt,3\nnut,0.5\n");
        expect((await tool.execute({ file: "upload:a1" })).output.calls).toBe(2);
      });
      await sandbox.destroy();
    });

    it("runs the scripts of the wizard's skills", async () => {
      const sandbox = await remote("run-remote-skill");
      const { skillTools } = await import("../src/tools/skills");
      await local(async () => {
        const files = await workspace(WIZARD_FILES);
        const { ctx } = stepContext(files, "run-remote-skill");
        const tools = await skillTools(ctx, { handle: () => sandbox as never, workdir: "/workspace" });
        const loaded = await tools.skill_load.execute({ name: "counter" });
        expect(loaded).toMatchObject({ folder: "/workspace/skills/counter", files: ["scripts/count.py"] });
        await sandbox.writeFile("rows.txt", "a\nb\nc\n");
        const ran = await sandbox.exec("python3 skills/counter/scripts/count.py rows.txt", { timeoutMs: 240_000 });
        expect(ran).toMatchObject({ exitCode: 0, stdout: '{"rows": 3}\n' });
      });
      await sandbox.destroy();
    });
  });
}
