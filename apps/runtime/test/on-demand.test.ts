import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// An install as the installer leaves it: the runtime package in a prefix's node_modules, naming
// the libraries it loads on demand as peers, and a library of its own beside it.
let prefix: string;
let root: string;

beforeEach(() => {
  vi.resetModules();
  prefix = mkdtempSync(join(tmpdir(), "on-demand-"));
  root = join(prefix, "node_modules", "@engenty", "wizards-runtime");
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ peerDependencies: { exceljs: "9.9.9", "@mastra/docker": "1.2.3" } }),
  );
  const shared = join(prefix, "node_modules", "shared-lib");
  mkdirSync(shared, { recursive: true });
  writeFileSync(join(shared, "package.json"), JSON.stringify({ name: "shared-lib", main: "index.js" }));
  writeFileSync(join(shared, "index.js"), "module.exports = { from: 'the runtime' };\n");
});

afterEach(() => rmSync(prefix, { recursive: true, force: true }));

/** npm as the test sees it: puts the named library into --prefix, which uses the runtime's shared-lib. */
function fakeNpm(fail = false) {
  const calls: string[][] = [];
  const npm = async (args: string[]) => {
    calls.push(args);
    if (fail) {
      return { code: 1, tail: "npm error network ENOTFOUND registry.npmjs.org" };
    }
    const at = args[args.indexOf("--prefix") + 1];
    const spec = args.at(-1) as string;
    const name = spec.slice(0, spec.lastIndexOf("@"));
    const dir = join(at, "node_modules", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name, exports: { ".": "./index.mjs" } }));
    writeFileSync(
      join(dir, "index.mjs"),
      "import shared from 'shared-lib';\nexport const loaded = 'yes';\nexport const sharedFrom = shared.from;\n",
    );
    return { code: 0, tail: "" };
  };
  return { npm, calls };
}

describe("onDemand", () => {
  it("installs a missing library once, at the version the package names, beside the runtime", async () => {
    const { onDemand } = await import("../src/on-demand");
    const { npm, calls } = fakeNpm();
    const mod = await onDemand<{ loaded: string; sharedFrom: string }>("exceljs", { root, npm });
    expect(mod.loaded).toBe("yes");
    // What it needs and the runtime has, it takes from the runtime.
    expect(mod.sharedFrom).toBe("the runtime");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("exceljs@9.9.9");
    expect(calls[0]).toContain("--legacy-peer-deps");
    expect(calls[0][calls[0].indexOf("--prefix") + 1]).toMatch(/extras[\\/]exceljs@9\.9\.9\.\d+\.tmp$/);
    await onDemand("exceljs", { root, npm });
    expect(calls).toHaveLength(1);
  });

  it("loads what an earlier process installed without npm", async () => {
    const first = fakeNpm();
    const { onDemand: once } = await import("../src/on-demand");
    await once("@mastra/docker", { root, npm: first.npm });
    vi.resetModules();
    const { onDemand } = await import("../src/on-demand");
    const second = fakeNpm();
    const mod = await onDemand<{ loaded: string }>("@mastra/docker", { root, npm: second.npm });
    expect(mod.loaded).toBe("yes");
    expect(second.calls).toHaveLength(0);
  });

  it("says what failed, leaves nothing behind and tries again on the next use", async () => {
    const { onDemand, extrasDir } = await import("../src/on-demand");
    await expect(onDemand("exceljs", { root, npm: fakeNpm(true).npm })).rejects.toThrow(
      /exceljs \(for Excel files\) is downloaded the first time it’s needed, and that didn’t work: npm error network ENOTFOUND/,
    );
    const dir = extrasDir(root, "exceljs");
    expect(existsSync(dir)).toBe(false);
    expect(readdirSync(dirname(dir))).toEqual([]);
    const retry = fakeNpm();
    await expect(onDemand("exceljs", { root, npm: retry.npm })).resolves.toMatchObject({ loaded: "yes" });
    expect(retry.calls).toHaveLength(1);
  });

  it("installs every library for a full installation and goes on past one that fails", async () => {
    const { installAll, extrasDir } = await import("../src/on-demand");
    const { npm, calls } = fakeNpm();
    const seen: Record<string, string> = {};
    await installAll((name, err) => {
      seen[name] = err ? err.message : "ok";
    }, { root, npm });
    expect(calls.map((args) => args.at(-1))).toEqual(["@mastra/docker@1.2.3", "exceljs@9.9.9"]);
    expect(seen.exceljs).toBe("ok");
    expect(seen["@mastra/quickjs"]).toBe("@mastra/quickjs isn’t installed (for running code).");
    expect(existsSync(join(extrasDir(root, "exceljs"), "node_modules", "exceljs"))).toBe(true);
    await installAll(undefined, { root, npm });
    expect(calls).toHaveLength(2);
  });

  it("is the only way the runtime loads them: no static import names one", async () => {
    const { ON_DEMAND } = await import("../src/on-demand");
    const src = join(__dirname, "..", "src");
    const files = readdirSync(src, { recursive: true, encoding: "utf8" }).filter((f) =>
      /\.tsx?$/.test(f),
    );
    const found: string[] = [];
    for (const file of files) {
      const text = readFileSync(join(src, file), "utf8");
      for (const name of Object.keys(ON_DEMAND)) {
        const value = new RegExp(`^(?:import|export)(?! type)[^;]*from "${name}"`, "m");
        if (value.test(text)) {
          found.push(`${file}: ${name}`);
        }
      }
    }
    expect(found).toEqual([]);
  });

  it("refuses a library the package doesn't name", async () => {
    const { onDemand } = await import("../src/on-demand");
    await expect(onDemand("@mastra/quickjs", { root, npm: fakeNpm().npm })).rejects.toThrow(
      "@mastra/quickjs isn’t installed (for running code).",
    );
  });
});
