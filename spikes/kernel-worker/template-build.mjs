// The build of a deploy package: wizard.json + steps/*.ts beside it, bundled into dist/worker.js
// with the kernel and the edge batteries this package pins, from its own node_modules.
// deploy.mjs copies this file into the package as build.mjs.   pnpm build
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { parse } from "node:path";
import { build } from "esbuild";

const here = new URL(".", import.meta.url).pathname;
const dir = here.replace(/\/$/, "");
const file = JSON.parse(readFileSync(`${dir}/wizard.json`, "utf8"));
const pkg = existsSync(`${dir}/package.json`)
  ? JSON.parse(readFileSync(`${dir}/package.json`, "utf8"))
  : {};

// The package says which runner it was made for. Without the pin, or not installed, no build.
const RUNNER = ["@engenty/wizards-kernel", "@engenty/wizards-edge"];
const unpinned = RUNNER.filter((name) => !pkg.dependencies?.[name]);
if (unpinned.length) {
  console.error(`"${file.title}" pins no ${unpinned.join(", ")} in its package.json.`);
  process.exit(1);
}
const installed = Object.fromEntries(
  RUNNER.map((name) => {
    const at = `${dir}/node_modules/${name}/package.json`;
    if (!existsSync(at)) {
      console.error(`${name} is not installed in ${dir}. Run pnpm install there.`);
      process.exit(1);
    }
    return [name, JSON.parse(readFileSync(at, "utf8"))];
  }),
);
// The edge batteries name the kernel they run on; this package's pin has to be that one.
const kernel = installed["@engenty/wizards-kernel"].version;
const wants = installed["@engenty/wizards-edge"].peerDependencies?.["@engenty/wizards-kernel"];
if (wants && wants !== kernel) {
  console.error(`@engenty/wizards-edge runs on kernel ${wants}; the package pins ${kernel}.`);
  process.exit(1);
}

const steps = readdirSync(`${dir}/steps`).map((name) => parse(name).name);
const started = performance.now();

// The run page, where the package has the runner: its components over this Worker's routes,
// with the runner's own CSS. It goes into the Worker as two strings.
const runnerAt = `${dir}/node_modules/@engenty/wizards-runner`;
let pageBytes = 0;
if (existsSync(runnerAt)) {
  const runner = realpathSync(runnerAt);
  const cssAt = `${runner}/dist/runner.css`;
  if (!existsSync(cssAt)) {
    console.error(`${cssAt} is missing: run node scripts/css.mjs in the runner first.`);
    process.exit(1);
  }
  const page = await build({
    entryPoints: [realpathSync(`${dir}/node_modules/@engenty/wizards-edge/page.tsx`)],
    // The page's own imports (React) come from the runner's, so there is one React.
    nodePaths: [`${dir}/node_modules`, `${runner}/node_modules`],
    bundle: true,
    format: "esm",
    minify: true,
    write: false,
    jsx: "automatic",
    conditions: ["wizards-source", "browser"],
    define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".png": "dataurl", ".svg": "dataurl", ".woff2": "dataurl" },
  });
  const js = page.outputFiles[0].text;
  const css = readFileSync(cssAt, "utf8");
  pageBytes = js.length + css.length;
  mkdirSync(`${here}dist`, { recursive: true });
  writeFileSync(
    `${here}dist/page.mjs`,
    `export const js = ${JSON.stringify(js)};\nexport const css = ${JSON.stringify(css)};\n`,
  );
}

const name = (id) => `step_${id.replace(/\W/g, "_")}`;
const entry = `
import { wizardWorker } from "@engenty/wizards-edge";
${pageBytes ? `import * as page from "${here}dist/page.mjs";` : ""}
import file from "${dir}/wizard.json";
${steps.map((id) => `import ${name(id)} from "${dir}/steps/${id}.ts";`).join("\n")}

const worker = wizardWorker({
  file,
  steps: { ${steps.map((id) => `${JSON.stringify(id)}: ${name(id)}`).join(", ")} },
}${pageBytes ? ", page" : ""});
export const RunObject = worker.RunObject;
export default { fetch: worker.fetch };
`;

const out = await build({
  stdin: { contents: entry, resolveDir: dir, loader: "ts" },
  // The edge package finds the kernel through this package's pin, not a copy of its own.
  nodePaths: [`${dir}/node_modules`],
  bundle: true,
  format: "esm",
  minify: true,
  outfile: `${here}dist/worker.js`,
  external: ["cloudflare:workers"],
  conditions: ["wizards-source", "workerd", "worker", "browser"],
  metafile: true,
});
const bytes = Object.values(out.metafile.outputs)[0].bytes;
console.log(
  `${file.title}: kernel ${kernel}, edge ${installed["@engenty/wizards-edge"].version}, ` +
    `${steps.length} steps, models ${JSON.stringify(file.requires?.models ?? [])}, ` +
    `${(bytes / 1024).toFixed(1)} KiB${pageBytes ? ` (the page ${(pageBytes / 1024).toFixed(0)} KiB of it)` : ""} in ${Math.round(performance.now() - started)} ms → dist/worker.js`,
);
