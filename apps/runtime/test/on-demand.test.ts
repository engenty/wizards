import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
    expect(seen["@turbodocx/html-to-docx"]).toBe(
      "@turbodocx/html-to-docx isn’t installed (for writing Word files).",
    );
    expect(existsSync(join(extrasDir(root, "exceljs"), "node_modules", "exceljs"))).toBe(true);
    await installAll(undefined, { root, npm });
    expect(calls).toHaveLength(2);
  });

  it("is the only way the runtime loads them: no import names one", async () => {
    const { onDemandPackages } = await import("../src/on-demand");
    const src = join(__dirname, "..", "src");
    const files = readdirSync(src, { recursive: true, encoding: "utf8" }).filter((f) =>
      /\.tsx?$/.test(f),
    );
    const found: string[] = [];
    for (const file of files) {
      const text = readFileSync(join(src, file), "utf8");
      for (const name of onDemandPackages()) {
        const at = `"${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:/[^"]*)?"`;
        const value = new RegExp(`^(?:import|export)(?! type)[^;]*from ${at}`, "m");
        // An import() of its own finds nothing in an install either; `typeof import()` is a type.
        const dynamic = new RegExp(`(?<!typeof )import\\(\\s*${at}\\s*\\)`);
        if (value.test(text) || dynamic.test(text)) {
          found.push(`${file}: ${name}`);
        }
      }
    }
    expect(found).toEqual([]);
  });

  it("refuses a library the package doesn't name", async () => {
    const { onDemand } = await import("../src/on-demand");
    await expect(onDemand("@turbodocx/html-to-docx", { root, npm: fakeNpm().npm })).rejects.toThrow(
      "@turbodocx/html-to-docx isn’t installed (for writing Word files).",
    );
  });
});

// The document readers as an install meets them the first time: npm puts the library and what it
// needs into extras/ (here copied from this checkout, as npm would download it), and the library
// reads a document from there.
describe("a document reader on first use", () => {
  const fixtures = join(__dirname, "fixtures", "documents");
  const runtimeModules = join(__dirname, "..", "node_modules");

  /** A package's folder and those of what it needs, as pnpm laid them out beside it. */
  function closure(name: string, from: string, into: Map<string, string>) {
    if (into.has(name)) {
      return;
    }
    const dir = realpathSync(join(from, name));
    into.set(name, dir);
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const beside = dir.slice(0, dir.length - name.length);
    for (const dep of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
      if (existsSync(join(beside, dep))) {
        closure(dep, beside, into);
      }
    }
  }

  function copyingNpm() {
    const calls: string[][] = [];
    const npm = async (args: string[]) => {
      calls.push(args);
      const at = args[args.indexOf("--prefix") + 1];
      const specs = args.slice(args.indexOf("--loglevel=error") + 1);
      const packages = new Map<string, string>();
      for (const spec of specs) {
        closure(spec.slice(0, spec.lastIndexOf("@")), runtimeModules, packages);
      }
      for (const [name, dir] of packages) {
        cpSync(dir, join(at, "node_modules", name), { recursive: true, dereference: true });
      }
      // What npm brings and an override keeps out of the checkout: the OpenAPI plugin's icons.
      mkdirSync(join(at, "node_modules", "lucide-react"), { recursive: true });
      return { code: 0, tail: "" };
    };
    return { npm, calls };
  }

  beforeEach(() => {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        peerDependencies: {
          "word-extractor": "1.0.4",
          mammoth: "1.13.0",
          "@executor-js/plugin-openapi": "1.6.11",
          effect: "4.0.0-beta.59",
        },
      }),
    );
  });

  it("reads an old Word file with word-extractor from extras/", async () => {
    const { onDemand, extrasDir } = await import("../src/on-demand");
    const { npm } = copyingNpm();
    const { default: WordExtractor } = await onDemand<{ default: typeof import("word-extractor") }>(
      "word-extractor",
      { root, npm },
    );
    expect(existsSync(join(extrasDir(root, "word-extractor"), "node_modules", "saxes"))).toBe(true);
    const doc = await new WordExtractor().extract(readFileSync(join(fixtures, "angebot.doc")));
    expect(doc.getBody()).toContain("Gartenmauer berechnen wir 1.240,00 Euro");
  });

  it("reads an OpenAPI description with the plugin and the effect installed with it", async () => {
    const { onDemand, extrasDir } = await import("../src/on-demand");
    const { npm, calls } = copyingNpm();
    const [{ extract, parse }, { Effect }] = await Promise.all([
      onDemand<typeof import("@executor-js/plugin-openapi/core")>("@executor-js/plugin-openapi", {
        root,
        npm,
        entry: "@executor-js/plugin-openapi/core",
      }),
      onDemand<typeof import("effect")>("@executor-js/plugin-openapi", {
        root,
        npm,
        entry: "effect",
      }),
    ]);
    // One install for both, with effect named beside the plugin.
    expect(calls).toHaveLength(1);
    expect(calls[0].slice(-2)).toEqual(["effect@4.0.0-beta.59", "@executor-js/plugin-openapi@1.6.11"]);
    const dir = extrasDir(root, "@executor-js/plugin-openapi");
    expect(dir).toMatch(/extras[\\/]@executor-js\+plugin-openapi@1\.6\.11$/);
    expect(existsSync(join(dir, "node_modules", "effect", "package.json"))).toBe(true);
    expect(existsSync(join(dir, "node_modules", "lucide-react"))).toBe(false);
    const spec = JSON.stringify({
      openapi: "3.0.0",
      info: { title: "Garden", version: "1" },
      servers: [{ url: "https://garden.example" }],
      paths: { "/beds": { get: { operationId: "listBeds", responses: { 200: { description: "ok" } } } } },
    });
    const extracted = await Effect.runPromise(extract(await Effect.runPromise(parse(spec))));
    expect(extracted.operations.map((op) => op.operationId)).toEqual(["listBeds"]);
  });

  it("imports only the library, its paths and what comes with it", async () => {
    const { onDemand } = await import("../src/on-demand");
    await expect(
      onDemand("@executor-js/plugin-openapi", { root, npm: copyingNpm().npm, entry: "zod" }),
    ).rejects.toThrow("zod isn’t installed with @executor-js/plugin-openapi.");
  });
});
