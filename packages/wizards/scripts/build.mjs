// dist/ as @engenty/wizards ships (scripts/npm-package.mjs stages and packs it):
//
//   plugin/   tsc's output as it is
//   openui/   index.js and server.js with the runner and the shared modules bundled in (Vite,
//             vite.config.ts), every other package left as an import; one .d.ts per entry with
//             the types of those modules inlined (API Extractor); styles.css, the runner's
//             runner.css; LICENSE-MIT, the runner's licence
//
// Nothing in dist/ names a workspace package (@engenty-wizards/*), and every package the bundle
// imports is a dependency or a peer of package.json: the build fails otherwise.
// Inside the repo everything imports the sources ("wizards-source"); the runner is built first
// (pnpm -r builds it before this package), its runner.css and its .d.ts are read from its dist/.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { Extractor, ExtractorConfig } from "@microsoft/api-extractor";

const root = resolve(import.meta.dirname, "..");
const dist = join(root, "dist");
const tsc = join(dist, ".tsc");
const runner = join(root, "..", "runner");
const WORKSPACE = ["@engenty-wizards/runner", "@engenty-wizards/shared"];

const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: "inherit" });

if (!existsSync(join(runner, "dist", "runner.css"))) {
  throw new Error("packages/runner/dist is missing — build the runner first.");
}
rmSync(dist, { recursive: true, force: true });

// --- 1. tsc: the plugin's files, and the .d.ts the openui entries start from -------------
run("tsc", ["-p", "tsconfig.build.json"]);
cpSync(join(tsc, "plugin"), join(dist, "plugin"), { recursive: true });

// --- 2. Vite: /openui with the workspace's modules in it ---------------------------------
run("vite", ["build", "--logLevel", "warn"]);
cpSync(join(runner, "dist", "runner.css"), join(dist, "openui", "styles.css"));
cpSync(join(runner, "LICENSE"), join(dist, "openui", "LICENSE-MIT"));

// --- 3. API Extractor: one .d.ts per entry ------------------------------------------------
for (const name of ["index", "server"]) {
  const config = ExtractorConfig.prepare({
    configObject: {
      projectFolder: root,
      mainEntryPointFilePath: join(tsc, "openui", `${name}.d.ts`),
      bundledPackages: WORKSPACE,
      compiler: {
        overrideTsconfig: {
          compilerOptions: {
            target: "ES2023",
            module: "ESNext",
            moduleResolution: "Bundler",
            lib: ["ES2023", "DOM", "DOM.Iterable"],
            jsx: "react-jsx",
            strict: true,
            skipLibCheck: true,
            esModuleInterop: true,
          },
          files: [join(tsc, "openui", `${name}.d.ts`)],
        },
      },
      dtsRollup: { enabled: true, untrimmedFilePath: join(dist, "openui", `${name}.d.ts`) },
      apiReport: { enabled: false },
      docModel: { enabled: false },
      tsdocMetadata: { enabled: false },
      messages: {
        compilerMessageReporting: { default: { logLevel: "error" } },
        extractorMessageReporting: {
          default: { logLevel: "warning" },
          "ae-missing-release-tag": { logLevel: "none" },
          "ae-forgotten-export": { logLevel: "none" },
        },
        tsdocMessageReporting: { default: { logLevel: "none" } },
      },
    },
    packageJsonFullPath: join(root, "package.json"),
  });
  const result = Extractor.invoke(config, { localBuild: true });
  if (!result.succeeded) {
    throw new Error(`API Extractor failed for openui/${name}.d.ts`);
  }
}
rmSync(tsc, { recursive: true, force: true });

// --- 4. the checks ------------------------------------------------------------------------
function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      yield* walk(path);
    } else {
      yield path;
    }
  }
}
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const allowed = new Set([
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
]);
const packageOf = (specifier) =>
  specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
const problems = [];
for (const file of walk(dist)) {
  if (!/\.(js|d\.ts)$/.test(file)) {
    continue;
  }
  const text = readFileSync(file, "utf8");
  const where = file.slice(root.length + 1);
  if (text.includes("@engenty-wizards/")) {
    problems.push(`${where} names a workspace package`);
  }
  for (const [, specifier] of text.matchAll(
    /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"'./][^"']*)["']/g,
  )) {
    const name = packageOf(specifier);
    if (!(allowed.has(name) || specifier.startsWith("node:"))) {
      problems.push(`${where} imports ${specifier}, which package.json doesn't list`);
    }
  }
}
if (problems.length > 0) {
  throw new Error(`dist/ is not what @engenty/wizards may ship:\n  ${problems.join("\n  ")}`);
}
