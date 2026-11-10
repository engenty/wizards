import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The engine's step code (packages/engine, docs/plans/runs-on-their-own.md) depends on shared
 * modules only, so it bundles without the runtime and runs on another host. This reads every
 * import of the package's sources, static and dynamic, type imports and `export … from`
 * included: a type from the runtime would break the package's type check as surely as a value
 * breaks its bundle. Allowed: `@engenty/wizards-shared/*`, `ai`, `zod`, QuickJS
 * (`quickjs-emscripten-core` with its release-sync WebAssembly build) and `sucrase` for wizard
 * code, and the package itself. No `node:*` module, no database client, no `@mastra/*`.
 */

const SRC = resolve(__dirname, "../../../packages/engine/src");

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}

/** The package's sources, relative to its `src/`. */
const STEP_CODE = walk(SRC)
  .map((path) => relative(SRC, path))
  .sort();

const PACKAGES = [
  /^@engenty\/wizards-shared\/[\w./-]+$/,
  /^ai$/,
  /^zod$/,
  /^quickjs-emscripten-core$/,
  /^@jitl\/quickjs-wasmfile-release-sync$/,
  /^sucrase$/,
];

/**
 * The specifiers a file imports. Static imports and `export … from` start a line (Biome writes
 * them so); `import("…")` counts anywhere, `typeof import("…")` included. A computed
 * `import(…)` comes back as itself, so it fails too.
 */
function importsOf(text: string): string[] {
  const found: string[] = [];
  const fromStatement = /^(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/gm;
  const bare = /^import\s*["']([^"']+)["']/gm;
  const dynamic = /\bimport\(\s*(?:["'`]([^"'`$]+)["'`]\s*\)|([^)]*)\))/g;
  for (const m of text.matchAll(fromStatement)) {
    found.push(m[1]);
  }
  for (const m of text.matchAll(bare)) {
    found.push(m[1]);
  }
  for (const m of text.matchAll(dynamic)) {
    found.push(m[1] ?? `import(${m[2]})`);
  }
  return found;
}

/** A relative import as a path under `src/`; anything else as written. */
function target(file: string, specifier: string): string {
  if (!specifier.startsWith(".")) {
    return specifier;
  }
  return relative(SRC, resolve(SRC, dirname(file), specifier)).replace(/\.js$/, ".ts");
}

function outsideImports(files: { file: string; text: string }[]) {
  return files.flatMap(({ file, text }) =>
    importsOf(text)
      .map((specifier) => ({ file, imports: target(file, specifier) }))
      .filter(
        ({ imports }) =>
          !STEP_CODE.includes(imports) && !PACKAGES.some((allowed) => allowed.test(imports)),
      ),
  );
}

const key = (i: { file: string; imports: string }) => `${i.file} → ${i.imports}`;

describe("step code imports", () => {
  const files = STEP_CODE.map((file) => ({ file, text: readFileSync(join(SRC, file), "utf8") }));
  const found = outsideImports(files);

  it("reads the step files", () => {
    expect(STEP_CODE).toContain("steps/index.ts");
    expect(STEP_CODE).toContain("steps/agent.ts");
    // Some modules import nothing (the failure table, the prompt texts); every step does.
    const steps = files.filter((f) => f.file.startsWith("steps/"));
    expect(steps.every((f) => importsOf(f.text).length > 0)).toBe(true);
  });

  it("imports only shared modules, ai, zod, QuickJS, sucrase and itself", () => {
    expect(found.map(key)).toEqual([]);
  });

  it("finds every kind of import", () => {
    const text = [
      'import { a } from "../a.js";',
      'import type { B } from "../b.js";',
      "import {",
      "  type C,",
      "  d,",
      '} from "../c.js";',
      'import "../side.js";',
      'export { e } from "./e.js";',
      'export * from "node:fs";',
      'const f = await import("../f.js");',
      'type G = typeof import("../g.js");',
      "const h = await import(name);",
    ].join("\n");
    expect(importsOf(text).sort()).toEqual(
      [
        "../a.js",
        "../b.js",
        "../c.js",
        "../side.js",
        "./e.js",
        "node:fs",
        "../f.js",
        "../g.js",
        "import(name)",
      ].sort(),
    );
    expect(
      outsideImports([{ file: "steps/tool.ts", text }])
        .map((i) => i.imports)
        .sort(),
    ).toEqual(
      [
        "a.ts",
        "b.ts",
        "c.ts",
        "side.ts",
        "steps/e.ts",
        "node:fs",
        "f.ts",
        "g.ts",
        "import(name)",
      ].sort(),
    );
  });
});

/** The runtime's part of a run: the runner, its host and the step context. */
const RUNTIME_ENGINE = resolve(__dirname, "../src/engine");

describe("the runtime's run code", () => {
  it("imports nothing of Mastra: it stays with the Work chats and the assistants", () => {
    const found = walk(RUNTIME_ENGINE).flatMap((path) =>
      importsOf(readFileSync(path, "utf8"))
        .filter((specifier) => specifier.startsWith("@mastra/"))
        .map((specifier) => `${relative(RUNTIME_ENGINE, path)} → ${specifier}`),
    );
    expect(walk(RUNTIME_ENGINE).length).toBeGreaterThan(10);
    expect(found).toEqual([]);
  });
});
