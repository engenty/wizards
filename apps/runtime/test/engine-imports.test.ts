import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The step code depends on shared modules only (docs/plans/runs-on-their-own.md, package 1.6),
 * so phase 2 can move it into a package of its own and bundle it without the runtime. This reads
 * every import of the step code, static and dynamic, type imports and `export … from` included:
 * a type from the runtime would break the package's type check as surely as a value breaks its
 * bundle. Allowed: `@engenty/wizards-shared/*`, `ai`, `zod`, and the step code among itself.
 *
 * `decide.ts` and `answerers.ts`, listed in the plan, are not step code any longer: no step file
 * imports them. `decide()` is what the models service calls (run-services/index.ts), and
 * `answerers.ts` reads who may answer from the database for routes, services and the runner.
 */

const SRC = resolve(__dirname, "../src");

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}

/** The step code, relative to `src/`. `code-step.ts` and `data-step.ts` run the `code` and `tool` steps' data. */
const STEP_CODE = [
  ...walk(join(SRC, "engine/steps")).map((path) => relative(SRC, path)),
  "engine/template.ts",
  "engine/input.ts",
  "engine/surface.ts",
  "engine/code-step.ts",
  "engine/data-step.ts",
].sort();

const PACKAGES = [/^@engenty\/wizards-shared\/[\w./-]+$/, /^ai$/, /^zod$/];

/**
 * What the step code still imports from outside, each with what removes it. A pair not listed
 * here fails; a listed pair no file imports any more fails too, so the list only shrinks.
 */
const STILL_OUTSIDE: { file: string; imports: string; until: string }[] = [
  ...[
    "engine/code-step.ts",
    "engine/data-step.ts",
    "engine/steps/agent.ts",
    "engine/steps/decision.ts",
    "engine/steps/foreach.ts",
    "engine/steps/index.ts",
    "engine/steps/prompt.ts",
    "engine/steps/tool.ts",
    "engine/steps/turn.ts",
    "engine/surface.ts",
  ].map((file) => ({
    file,
    imports: "engine/types.ts",
    until: "2.1: StepContext and StepError move into the engine package, `services` typed as RunServices",
  })),
  ...["engine/steps/agent.ts", "engine/steps/prompt.ts", "engine/template.ts"].map((file) => ({
    file,
    imports: "prompts.ts",
    until: "the step prompts as a module the engine imports; prompts.ts reads them with node:fs",
  })),
  {
    file: "engine/steps/agent.ts",
    imports: "engine/durable-turn.ts",
    until: "2.4: agent turns saved by the engine; 2.5 deletes durable-turn.ts",
  },
  {
    file: "engine/steps/agent.ts",
    imports: "@mastra/core/agent",
    until: "2.4: the engine's own agent loop; 2.5: Mastra leaves the run",
  },
  {
    file: "engine/code-step.ts",
    imports: "engine/quickjs.ts",
    until: "2.1: quickjs.ts moves into the package on quickjs-emscripten, without @mastra/quickjs",
  },
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
    expect(STEP_CODE).toContain("engine/steps/index.ts");
    expect(STEP_CODE).toContain("engine/steps/agent.ts");
    expect(files.every((f) => importsOf(f.text).length > 0)).toBe(true);
  });

  it("imports only shared modules, ai, zod and itself", () => {
    const listed = new Set(STILL_OUTSIDE.map(key));
    expect(found.filter((i) => !listed.has(key(i))).map(key)).toEqual([]);
  });

  it("lists nothing it no longer imports", () => {
    const seen = new Set(found.map(key));
    expect(STILL_OUTSIDE.filter((i) => !seen.has(key(i))).map(key)).toEqual([]);
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
      outsideImports([{ file: "engine/steps/tool.ts", text }])
        .map((i) => i.imports)
        .sort(),
    ).toEqual(
      [
        "engine/a.ts",
        "engine/b.ts",
        "engine/c.ts",
        "engine/side.ts",
        "engine/steps/e.ts",
        "node:fs",
        "engine/f.ts",
        "engine/g.ts",
        "import(name)",
      ].sort(),
    );
  });
});
