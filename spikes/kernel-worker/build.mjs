// Builds one wizard folder (wizard.json + steps/*.ts) with the kernel into dist/worker.js.
//   node build.mjs [wizards/x-post]       or WIZARD=wizards/x-post node build.mjs
import { readdirSync, readFileSync } from "node:fs";
import { parse, resolve } from "node:path";
import { build } from "esbuild";

const here = new URL(".", import.meta.url).pathname;
const dir = resolve(here, process.argv[2] ?? process.env.WIZARD ?? "wizards/x-post");
const file = JSON.parse(readFileSync(`${dir}/wizard.json`, "utf8"));
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
import { wizardWorker } from "${here}src/worker.ts";
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
  stdin: { contents: entry, resolveDir: here, loader: "ts" },
  bundle: true,
  format: "esm",
  minify: true,
  outfile: `${here}dist/worker.js`,
  external: ["cloudflare:workers"],
  conditions: ["workerd", "worker", "browser"],
  metafile: true,
});
const bytes = Object.values(out.metafile.outputs)[0].bytes;
console.log(
  `${file.title}: ${steps.length} steps, models ${JSON.stringify(file.requires?.models ?? [])}, ` +
    `${(bytes / 1024).toFixed(1)} KiB in ${Math.round(performance.now() - started)} ms → dist/worker.js`,
);
