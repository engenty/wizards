// Stands in for `wizards deploy <path> --worker`: a wizard (its folder, or a `.wizard` package
// exported from the studio) becomes a deploy package for a Worker of its own. The wizard is
// copied as it is; the pin to the kernel and the edge batteries, the build and the Worker's config
// are added here, from what this CLI itself runs.
//   node deploy.mjs <wizard folder | .wizard> [--home <url>] [--out deploy/<name>]
// With --home the deployment is connected: every ask goes to the organization's runtime at that
// URL, which answers it through the broker; the Worker holds only a deploy key. Without it the
// Worker is on its own: a model key of its own, no tools, no connections.
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";

const here = new URL(".", import.meta.url).pathname;
const args = process.argv.slice(2);
const at = args.indexOf("--out");
const out = at >= 0 ? args.splice(at, 2)[1] : undefined;
const homeAt = args.indexOf("--home");
const home = homeAt >= 0 ? args.splice(homeAt, 2)[1] : undefined;
const from = resolve(args[0] ?? "");
if (!args[0] || !existsSync(from)) {
  console.error(
    "Usage: node deploy.mjs <wizard folder | .wizard> [--home <url>] [--out deploy/<name>]",
  );
  process.exit(1);
}

/** The wizard as wizard.json + steps/: a folder as it is, a .wizard package unpacked. */
function wizardOf(path) {
  if (!path.endsWith(".wizard"))
    return {
      file: JSON.parse(readFileSync(join(path, "wizard.json"), "utf8")),
      steps: join(path, "steps"),
    };
  const dir = mkdtempSync(join(tmpdir(), "wizard-"));
  execFileSync("unzip", ["-q", path, "-d", dir]);
  const manifest = JSON.parse(readFileSync(join(dir, "wizard.json"), "utf8"));
  const file = manifest.definition?.kernel;
  if (manifest.definition?.version !== "0.3.0" || !file) {
    console.error(`${basename(path)} is not a wizard of version 0.3.0.`);
    process.exit(1);
  }
  return { file, steps: join(dir, "files", "steps") };
}

const { file, steps } = wizardOf(from);
const slug = basename(from)
  .replace(/\.wizard$/, "")
  .replace(/[^a-z0-9-]+/gi, "-")
  .toLowerCase();

// On its own, what the file requires and a Worker cannot give is refused before anything is
// written. Connected, the home decides each ask; what it has is its business.
const refused = home
  ? []
  : [
      ...(file.requires?.tools ?? []).map((tool) => `the tool "${tool}"`),
      ...Object.keys(file.connections ?? {}).map((kind) => `the connection "${kind}"`),
      ...Object.keys(file.requires?.roles ?? {}).map((role) => `someone for the role "${role}"`),
    ];
if (refused.length) {
  console.error(`"${file.title}" cannot run as a Worker. It lacks ${refused.join(", ")}.`);
  process.exit(1);
}

const dir = resolve(here, out ?? `deploy/${slug}`);
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "wizard.json"), `${JSON.stringify(file, null, 2)}\n`);
cpSync(steps, join(dir, "steps"), { recursive: true });
copyFileSync(join(here, "template-build.mjs"), join(dir, "build.mjs"));

// The pin: the kernel and the edge batteries this CLI runs. Neither is published, so `link:`
// stands in for their versions; a released CLI writes "<version>" here.
const kernelDir = resolve(here, "../../packages/kernel");
const edgeDir = resolve(here, "edge");
const runnerDir = resolve(here, "../../packages/runner");
const version = (path) => JSON.parse(readFileSync(join(path, "package.json"), "utf8")).version;
const toolVersions = JSON.parse(readFileSync(join(here, "package.json"), "utf8")).devDependencies;
writeFileSync(
  join(dir, "package.json"),
  `${JSON.stringify(
    {
      name: `@wizards/${slug}`,
      private: true,
      type: "module",
      description: `"${file.title}" as a Worker of its own, each run a Durable Object. Made by wizards deploy.`,
      scripts: {
        build: "node build.mjs",
        dev: "wrangler dev",
        workerd:
          "node build.mjs && mkdir -p .workerd/runs && workerd serve workerd.capnp --experimental",
      },
      dependencies: {
        "@engenty/wizards-edge": `link:${relative(dir, edgeDir)}`,
        "@engenty/wizards-kernel": `link:${relative(dir, kernelDir)}`,
        "@engenty/wizards-runner": `link:${relative(dir, runnerDir)}`,
      },
      devDependencies: toolVersions,
      wizards: {
        kernel: version(kernelDir),
        edge: version(edgeDir),
        format: file.version ?? "0.3.0",
      },
    },
    null,
    2,
  )}\n`,
);

// The Worker's config, from `requires`. Connected: the home's URL and the deploy key's name.
// On its own: each model class becomes a model name to set, and the model key's name.
const models = JSON.stringify(
  Object.fromEntries((file.requires?.models ?? []).map((name) => [name, "gpt-4.1-mini"])),
);
writeFileSync(
  join(dir, "wrangler.toml"),
  `# "${file.title}" as a Worker. MODEL_API_KEY is a secret (.dev.vars locally, wrangler secret put).
name = "wizard-${slug}"
main = "dist/worker.js"
compatibility_date = "2025-09-01"
no_bundle = true

[build]
command = "node build.mjs"

[[durable_objects.bindings]]
name = "RUNS"
class_name = "RunObject"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["RunObject"]

# The model classes in requires.models, as models of the endpoint.
[vars]
MODEL_BASE_URL = "https://api.openai.com/v1"
MODELS = '${models}'
`.replace(
    /# The model classes[\s\S]*$/,
    home
      ? `# Connected: every ask goes home. DEPLOY_KEY is a secret.\n[vars]\nHOME_URL = "${home}"\n`
      : (all) => all,
  ),
);
writeFileSync(
  join(dir, "workerd.capnp"),
  `# "${file.title}" on self-hosted workerd: pnpm workerd. Runs are kept in .workerd/runs.
# Secrets from the environment: ${home ? "DEPLOY_KEY" : "MODEL_API_KEY, MODEL_BASE_URL"}.
using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "wizard", worker = .wizard),
    (name = "runs", disk = (path = ".workerd/runs", writable = true)),
    (name = "net", network = (allow = ["public", "private", "local"])),
  ],
  sockets = [(name = "http", address = "127.0.0.1:8788", http = (), service = "wizard")],
);

const wizard :Workerd.Worker = (
  modules = [(name = "worker.js", esModule = embed "dist/worker.js")],
  compatibilityDate = "2025-09-01",
  durableObjectNamespaces = [(className = "RunObject", uniqueKey = "wizard-${slug}-runs", enableSql = true)],
  durableObjectStorage = (localDisk = "runs"),
  globalOutbound = "net",
  bindings = [
    (name = "RUNS", durableObjectNamespace = "RunObject"),
${
  home
    ? `    (name = "HOME_URL", text = ${JSON.stringify(home)}),
    (name = "DEPLOY_KEY", fromEnvironment = "DEPLOY_KEY"),`
    : `    (name = "MODELS", text = ${JSON.stringify(models)}),
    (name = "MODEL_BASE_URL", fromEnvironment = "MODEL_BASE_URL"),
    (name = "MODEL_API_KEY", fromEnvironment = "MODEL_API_KEY"),`
}
  ],
);
`,
);
writeFileSync(join(dir, ".gitignore"), "node_modules\ndist\n.wrangler\n.workerd\n.dev.vars\n");

// The same folder as one zip, to hand to whoever runs the server.
const zip = `${dir}.zip`;
rmSync(zip, { force: true });
execFileSync("zip", ["-qr", zip, "."], { cwd: dir });
console.log(
  `"${file.title}" → ${relative(process.cwd(), dir)}/ and ${relative(process.cwd(), zip)}`,
);
console.log(
  `  kernel ${version(kernelDir)}, edge ${version(edgeDir)}, ${home ? `connected to ${home}` : `models ${models}`}`,
);
