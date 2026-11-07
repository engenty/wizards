// A package marked `"license": "MIT"` ships to people who take it under MIT alone, so what it
// needs at run time must be MIT too, or as permissive. `dependencies` and `peerDependencies` are
// checked; `devDependencies` don't ship.
//
//   pnpm mit-deps:check
//
// - a workspace dependency must itself be `"license": "MIT"` (or be named in EXCEPTIONS, with
//   the reason);
// - a third-party dependency must carry a permissive licence, as its installed package.json
//   names it. An SPDX expression counts when one side of every OR, and every side of an AND, is
//   permissive: `(MPL-2.0 OR Apache-2.0)` passes.
//
// The MIT packages are the ones in packages/* and modules/*: what ships. The examples are
// examples (examples/openui-chat is MIT and imports @engenty/wizards, which is FSL-1.1-MIT).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const GROUPS = ["packages", "modules"];
const PERMISSIVE = new Set([
  "MIT",
  "MIT-0",
  "ISC",
  "0BSD",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Apache-2.0",
  "BlueOak-1.0.0",
  "Unlicense",
  "CC0-1.0",
]);

/** `<MIT package> -> <workspace dependency>` pairs that are fine, and why. */
const EXCEPTIONS = {
  "@engenty/wizards-runner -> @engenty/wizards-shared":
    "the runner bundles only the wizard format's modules of the shared package, which are " +
    "FSL-1.1-MIT OR MIT (packages/shared/LICENSE-MIT, packages/runner/README.md)",
};

/** Every package.json of packages/* and modules/*, by name. */
function workspacePackages() {
  const found = new Map();
  for (const group of GROUPS) {
    const dir = join(root, group);
    if (!existsSync(dir)) {
      continue;
    }
    for (const entry of readdirSync(dir)) {
      const file = join(dir, entry, "package.json");
      if (existsSync(file)) {
        const pkg = JSON.parse(readFileSync(file, "utf8"));
        found.set(pkg.name, { dir: join(dir, entry), pkg });
      }
    }
  }
  return found;
}

function licenseOf(pkg) {
  return typeof pkg.license === "string" ? pkg.license : pkg.license?.type;
}

/** Whether an SPDX expression (`A OR (B AND C)`) leaves a permissive way to take the package. */
function permissive(expression) {
  const tokens = expression.match(/\(|\)|[^\s()]+/g) ?? [];
  let at = 0;
  // or := and ("OR" and)*;  and := atom ("AND" atom)*;  atom := id | "(" or ")"
  const or = () => {
    let ok = and();
    while (tokens[at] === "OR") {
      at++;
      ok = and() || ok;
    }
    return ok;
  };
  const and = () => {
    let ok = atom();
    while (tokens[at] === "AND") {
      at++;
      ok = atom() && ok;
    }
    return ok;
  };
  const atom = () => {
    const token = tokens[at++];
    if (token === "(") {
      const ok = or();
      at++;
      return ok;
    }
    return PERMISSIVE.has(token);
  };
  const ok = or();
  return ok && at === tokens.length;
}

/**
 * The licence of a third-party dependency as installed for `from`. Looked up along the
 * node_modules folders Node would search, not through `require`: a package whose `exports`
 * leave out `./package.json` can't be resolved to it.
 */
function installedLicense(name, from) {
  const require = createRequire(join(from, "package.json"));
  for (const dir of require.resolve.paths(name) ?? []) {
    const file = join(dir, name, "package.json");
    if (existsSync(file)) {
      return licenseOf(JSON.parse(readFileSync(file, "utf8")));
    }
  }
  return undefined;
}

const workspace = workspacePackages();
const problems = [];
const checked = [];
for (const { dir, pkg } of workspace.values()) {
  if (licenseOf(pkg) !== "MIT") {
    continue;
  }
  checked.push(pkg.name);
  const names = Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies });
  for (const name of names) {
    const local = workspace.get(name);
    if (local) {
      if (licenseOf(local.pkg) !== "MIT" && !EXCEPTIONS[`${pkg.name} -> ${name}`]) {
        problems.push(
          `${pkg.name} (MIT) depends on ${name}, whose licence is ${licenseOf(local.pkg) ?? "not set"}`,
        );
      }
      continue;
    }
    const license = installedLicense(name, dir);
    if (!(license && permissive(license))) {
      problems.push(
        `${pkg.name} (MIT) depends on ${name}, whose licence is ${license ?? "unknown (not installed?)"}`,
      );
    }
  }
}

if (problems.length) {
  console.error(`MIT packages with a dependency that is not MIT:\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
console.log(
  `MIT packages depend only on MIT or permissive packages: ${checked.sort().join(", ")}.`,
);
