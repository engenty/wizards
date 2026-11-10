import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

/**
 * The engine bundles for a runtime that is not Node (docs/plans/runs-on-their-own.md): esbuild's
 * neutral platform with the conditions workerd resolves by, QuickJS's `.wasm` left to the host.
 * A Node built-in anywhere in its imports fails the build: neutral knows none.
 */
const src = fileURLToPath(new URL("../src/", import.meta.url));

describe("the engine for workerd", () => {
  it("bundles every module on the neutral platform, with no Node built-ins", async () => {
    const entryPoints = readdirSync(src)
      .filter((f) => f.endsWith(".ts"))
      .map((f) => `${src}${f}`);
    const result = await build({
      entryPoints,
      bundle: true,
      write: false,
      outdir: "out",
      format: "esm",
      platform: "neutral",
      // Neutral reads no package.json field by itself: the ones a bundler for workerd reads.
      mainFields: ["module", "main"],
      // "wizards-source": the workspace's packages as TypeScript, so nothing needs a build first.
      conditions: ["wizards-source", "workerd", "worker", "browser"],
      external: ["*.wasm"],
      metafile: true,
      logLevel: "silent",
    });
    expect(result.errors).toEqual([]);
    const imports = Object.values(result.metafile.outputs).flatMap((o) =>
      o.imports.filter((i) => i.external).map((i) => i.path),
    );
    // Nothing but QuickJS's module stays outside (its workerd build takes the module from the host).
    expect(imports.filter((path) => !path.endsWith(".wasm"))).toEqual([]);
    // Nor does a built-in hide where esbuild lets it pass: a `require` in a `try`, say.
    const builtins = result.outputFiles.flatMap((f) =>
      [
        ...f.text.matchAll(
          /\b(?:require|import)\s*\(\s*["'](node:[\w/]+|fs|path|os|crypto|module|url|child_process|worker_threads)["']/g,
        ),
      ].map((m) => m[1]),
    );
    expect(builtins).toEqual([]);
  }, 30_000);
});
