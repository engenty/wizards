// The Worker as workerd takes it: one ES module with the engine and the shared package in it,
// and QuickJS's `.wasm` beside it as a module of its own, which workerd compiles itself.
//
//   pnpm --filter @engenty/wizards-edge build   → dist/worker.js, dist/quickjs.wasm
//
// `buildWorker()` is what the tests start in Miniflare (test/local-edge.ts). No Node built-in
// gets in: esbuild's neutral platform knows none, so one in the imports fails the build.
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "package.json"));

/** The module name the bundle imports QuickJS's WebAssembly by. */
export const QUICKJS_WASM = "quickjs.wasm";

/**
 * Bundles `src/worker.ts`. `plugins`: more esbuild plugins (a test's probe). Returns the script
 * and the `.wasm`'s bytes.
 */
export async function buildWorker({ plugins = [] } = {}) {
  const wasmPath = require.resolve("@jitl/quickjs-wasmfile-release-sync/wasm");
  const result = await build({
    entryPoints: [join(root, "src/worker.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    target: "es2023",
    // Neutral reads no package.json field by itself: the ones a bundler for workerd reads.
    mainFields: ["module", "main"],
    // "wizards-source": the workspace's packages as TypeScript, so nothing needs a build first.
    conditions: ["wizards-source", "workerd", "worker", "browser"],
    outfile: "worker.js",
    logLevel: "silent",
    plugins: [
      ...plugins,
      {
        name: "quickjs-wasm",
        setup(b) {
          b.onResolve({ filter: /^@jitl\/quickjs-wasmfile-release-sync\/wasm$/ }, () => ({
            path: `./${QUICKJS_WASM}`,
            external: true,
          }));
        },
      },
    ],
  });
  return { script: result.outputFiles[0].text, wasm: readFileSync(wasmPath) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { script, wasm } = await buildWorker();
  const out = join(root, "dist");
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "worker.js"), script);
  await writeFile(join(out, QUICKJS_WASM), wasm);
  console.log(`dist/worker.js ${(script.length / 1024).toFixed(0)} KiB, dist/${QUICKJS_WASM}`);
}
