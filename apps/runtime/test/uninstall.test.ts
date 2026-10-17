import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "../src/cli/connect.js";
import { layout } from "../src/cli/home.js";
import { type WizardsProcess, wizardsProcesses } from "../src/cli/processes.js";
import { type UninstallSystem, uninstall } from "../src/cli/uninstall.js";

// Every test works in a home folder of its own, never the real one; apps, processes and
// launchctl are stand-ins.

let user: string;
let paths: ReturnType<typeof layout>;
const plist = () => join(user, "Library", "LaunchAgents", "com.engenty.wizards.login.plist");
const link = () => join(user, ".local", "bin", "wizards");
beforeEach(() => {
  user = mkdtempSync(join(tmpdir(), "wizards-uninstall-"));
  paths = layout(join(user, ".engenty", "wizards"));
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  for (const file of [join(paths.bin, "wizards"), join(paths.runtime, "x"), paths.envFile, join(paths.data, "secret"), plist()]) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "x");
  }
  mkdirSync(dirname(link()), { recursive: true });
  symlinkSync(join(paths.bin, "wizards"), link());
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(user, { recursive: true, force: true });
});

function fakeSystem(opts: { stubborn?: boolean; appWorks?: boolean } = {}) {
  const calls: string[] = [];
  let running: WizardsProcess[] = [
    { pid: 11, kind: "runtime" },
    { pid: 12, kind: "mcp" },
  ];
  const app = {
    id: "cursor",
    name: "Cursor",
    on: true,
    connected: async () => app.on,
    disconnect: async () => {
      app.on = opts.appWorks === false;
      return app.on ? { ok: false, message: "Cursor is running" } : { ok: true, message: "" };
    },
  } as unknown as App & { on: boolean };
  const system: UninstallSystem = {
    userHome: user,
    platform: "darwin",
    env: {},
    interactive: false,
    apps: () => [app],
    processes: () => running,
    stop: async (pids) => {
      calls.push(`stop ${pids.join(",")}`);
      running = opts.stubborn ? running : [];
      return running.map((p) => p.pid);
    },
    unloadLoginItem: async () => {
      calls.push("bootout");
    },
    removeUnit: async () => undefined,
  };
  return { system, calls, app };
}

const run = (system: UninstallSystem, flags: { dryRun?: boolean; yes?: boolean; deleteData?: boolean }) =>
  uninstall(paths, { dryRun: false, yes: false, deleteData: false, ...flags }, system);

describe("wizards uninstall", () => {
  it("refuses without a terminal unless --yes is given, and --dry-run changes nothing", async () => {
    const { system, calls, app } = fakeSystem();
    expect(await run(system, {})).toBe(2);
    expect(await run(system, { dryRun: true })).toBe(0);
    expect(calls).toEqual([]);
    expect(app.on).toBe(true);
    expect(existsSync(paths.runtime)).toBe(true);
  });

  it("with --yes removes apps, login item, processes, program and link, and keeps the data", async () => {
    const { system, calls, app } = fakeSystem();
    expect(await run(system, { yes: true })).toBe(0);
    expect(app.on).toBe(false);
    expect(calls).toEqual(["bootout", "stop 11,12"]);
    for (const gone of [plist(), link(), paths.bin, paths.runtime]) {
      expect(existsSync(gone)).toBe(false);
    }
    expect(existsSync(join(paths.data, "secret"))).toBe(true);
    expect(existsSync(paths.envFile)).toBe(true);
  });

  it("with --yes --delete-data leaves nothing, not even an empty ~/.engenty", async () => {
    const { system } = fakeSystem();
    expect(await run(system, { yes: true, deleteData: true })).toBe(0);
    expect(existsSync(join(user, ".engenty"))).toBe(false);
  });

  it("fails and says how to fix what is left", async () => {
    const { system } = fakeSystem({ stubborn: true, appWorks: false });
    expect(await run(system, { yes: true })).toBe(1);
    const said = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(said).toContain("npx wizards disconnect cursor");
    expect(said).toContain("kill -9 11");
  });
});

describe("the processes of an install", () => {
  it("are the ones running from its folder, apart from this one and its parents", () => {
    const home = "/Users/x/.engenty/wizards";
    const bin = `${home}/runtime/node_modules/wizards/bin/wizards.mjs`;
    const list = [
      { pid: 10, ppid: 1, command: `${home}/tools/node/bin/node ${bin} start --no-open` },
      { pid: 11, ppid: 10, command: `node ${home}/runtime/node_modules/wizards/apps/runtime/dist/index.js` },
      { pid: 12, ppid: 1, command: `node ${bin} mcp` },
      { pid: 20, ppid: 1, command: "npm exec wizards uninstall" },
      { pid: 21, ppid: 20, command: `node ${bin} uninstall` },
      { pid: 30, ppid: 1, command: "node /Users/x/other/.engenty/wizards/x.js" },
    ];
    expect(wizardsProcesses(home, list, 21)).toEqual([
      { pid: 10, kind: "start" },
      { pid: 11, kind: "runtime" },
      { pid: 12, kind: "mcp" },
    ]);
  });
});
