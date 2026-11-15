// Builds one wizard folder (wizard.json + steps/*.ts + package.json) into dist/worker.js, with
// the kernel and the edge batteries its package.json pins, installed in its own node_modules.
//   node build.mjs [wizards/x-post]       or WIZARD=wizards/x-post node build.mjs
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { parse, resolve } from "node:path";
import { build } from "esbuild";

const here = new URL(".", import.meta.url).pathname;
const dir = resolve(here, process.argv[2] ?? process.env.WIZARD ?? "wizards/x-post");
const file = JSON.parse(readFileSync(`${dir}/wizard.json`, "utf8"));
const pkg = existsSync(`${dir}/package.json`)
  ? JSON.parse(readFileSync(`${dir}/package.json`, "utf8"))
  : {};

// The folder says which runner it was written for. Without the pin, or not installed, no build.
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
// The edge batteries name the kernel they run on; the wizard's pin has to be that one.
const kernel = installed["@engenty/wizards-kernel"].version;
const wants = installed["@engenty/wizards-edge"].peerDependencies?.["@engenty/wizards-kernel"];
if (wants && wants !== kernel) {
  console.error(`@engenty/wizards-edge runs on kernel ${wants}; the wizard pins ${kernel}.`);
  process.exit(1);
}

const steps = readdirSync(`${dir}/steps`).map((name) => parse(name).name);

// What the file requires and this Worker cannot give is refused here, before anything runs.
const refused = [
  ...(file.requires?.tools ?? []).map((tool) => `the tool "${tool}"`),
  ...Object.keys(file.connections ?? {}).map((kind) => `the connection "${kind}"`),
  ...Object.keys(file.requires?.roles ?? {}).map((role) => `someone for the role "${role}"`),
];
if (refused.length) {
  console.error(`This Worker cannot run "${file.title}". It lacks ${refused.join(", ")}.`);
  process.exit(1);
}

const name = (id) => `step_${id.replace(/\W/g, "_")}`;
const entry = `
import { wizardWorker } from "@engenty/wizards-edge";
import file from "${dir}/wizard.json";
${steps.map((id) => `import ${name(id)} from "${dir}/steps/${id}.ts";`).join("\n")}

const worker = wizardWorker({
  file,
  steps: { ${steps.map((id) => `${JSON.stringify(id)}: ${name(id)}`).join(", ")} },
});
export const RunObject = worker.RunObject;
export default { fetch: worker.fetch };
`;

const started = performance.now();
const out = await build({
  stdin: { contents: entry, resolveDir: dir, loader: "ts" },
  // The edge package finds the kernel through the wizard's pin, not a copy of its own.
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
    `${(bytes / 1024).toFixed(1)} KiB in ${Math.round(performance.now() - started)} ms → dist/worker.js`,
);
