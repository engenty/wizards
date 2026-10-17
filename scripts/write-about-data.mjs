#!/usr/bin/env node
// Writes what the app shows as its changelog and its open-source credits,
// apps/web/src/about/{changelog,oss-credits}.json, and the third-party part of COPYRIGHTS.md.
// Commit all three.
//
//   pnpm about:data               all
//   pnpm about:data --changelog   the changelog only (pnpm release --changelog runs this)
//   pnpm about:data --credits     the credits and COPYRIGHTS.md only
//
// The changelog is the root changelog.json (git-cliff's context, written by pnpm release) cut
// down to what the page shows. The credits are the direct dependencies the workspace's
// package.json files declare (not the whole tree), with version and license from
// `pnpm licenses list`, grouped as
//   shared: declared by two or more workspaces
//   groups: the rest, per app or package
// COPYRIGHTS.md lists the same, plus the docs site and the development tooling (devDependencies).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const CHANGELOG_JSON = join(root, "changelog.json");
const OUT_DIR = join(root, "apps", "web", "src", "about");
const OUT_CHANGELOG = join(OUT_DIR, "changelog.json");
const OUT_CREDITS = join(OUT_DIR, "oss-credits.json");
const OUT_COPYRIGHTS = join(root, "COPYRIGHTS.md");
const COPYRIGHTS_BEGIN =
  "<!-- third-party: written by scripts/write-about-data.mjs, do not edit by hand -->";
const COPYRIGHTS_END = "<!-- /third-party -->";
/** The workspace's own packages: no credit to give. */
const OWN_SCOPE = "@engenty-wizards/";
/** Workspaces that are not part of the app people run: the docs site. */
const NOT_THE_APP = new Set(["apps/docs"]);

const args = new Set(process.argv.slice(2));
const writeChangelog = !args.has("--credits");
const writeCredits = !args.has("--changelog");

const KIND_ORDER = { root: 0, app: 1, package: 2 };

function die(message) {
  console.error(`✖ ${message}`);
  process.exit(1);
}

function writeSlimChangelog() {
  if (!existsSync(CHANGELOG_JSON)) {
    die(`${relative(root, CHANGELOG_JSON)} is missing — run \`pnpm release --changelog\` first.`);
  }
  const slim = JSON.parse(readFileSync(CHANGELOG_JSON, "utf8"))
    .filter((release) => Array.isArray(release.commits) && release.commits.length > 0)
    .map((release) => ({
      version: release.version ?? null,
      timestamp: release.timestamp ?? null,
      commits: release.commits.map((commit) => ({
        id: typeof commit.id === "string" ? commit.id.slice(0, 7) : "",
        // The subject only: git-cliff's message can carry the body.
        message: (commit.message ?? "").split(/\r?\n/, 1)[0],
        group: commit.group ?? null,
        scope: commit.scope ?? null,
        breaking: Boolean(commit.breaking),
      })),
    }))
    // Newest first; what is not released yet has no timestamp and leads.
    .sort(
      (a, b) => (b.timestamp ?? Number.MAX_SAFE_INTEGER) - (a.timestamp ?? Number.MAX_SAFE_INTEGER),
    );
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_CHANGELOG, `${JSON.stringify(slim, null, 2)}\n`, "utf8");
  console.log(`✔ ${relative(root, OUT_CHANGELOG)} (${slim.length} release(s))`);
}

/** The package.json of the root and of every workspace under apps/ and packages/ the app is made of. */
function workspacePackageJsonPaths(all = false) {
  const paths = [join(root, "package.json")];
  for (const segment of ["apps", "packages"]) {
    const dir = join(root, segment);
    if (!existsSync(dir)) {
      continue;
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const pkgPath = join(dir, entry.name, "package.json");
      if (
        entry.isDirectory() &&
        existsSync(pkgPath) &&
        (all || !NOT_THE_APP.has(`${segment}/${entry.name}`))
      ) {
        paths.push(pkgPath);
      }
    }
  }
  return paths;
}

/** @returns {Array<{ id: string; kind: "root" | "app" | "package"; label: string; deps: Set<string>; dev: Set<string> }>} */
function workspaceDirectDeps(all = false) {
  const workspaces = [];
  for (const pkgPath of workspacePackageJsonPaths(all)) {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    const id = relative(root, dirname(pkgPath)).replaceAll("\\", "/") || "root";
    const kind = id === "root" ? "root" : id.startsWith("apps/") ? "app" : "package";
    const label = pkg.name?.startsWith(OWN_SCOPE) ? pkg.name.slice(OWN_SCOPE.length) : id;
    const deps = new Set();
    for (const field of ["dependencies", "optionalDependencies"]) {
      for (const name of Object.keys(pkg[field] ?? {})) {
        if (!name.startsWith(OWN_SCOPE)) {
          deps.add(name);
        }
      }
    }
    const dev = new Set();
    for (const name of Object.keys(pkg.devDependencies ?? {})) {
      if (!name.startsWith(OWN_SCOPE)) {
        dev.add(name);
      }
    }
    if (deps.size > 0 || dev.size > 0) {
      workspaces.push({ id, kind, label, deps, dev });
    }
  }
  return workspaces;
}

/** Version, license and homepage of the named packages, as pnpm reports them. */
function licenseIndex(names) {
  let stdout;
  try {
    stdout = execFileSync("pnpm", ["licenses", "list", "--json"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    die("`pnpm licenses list` failed — run `pnpm install` first.");
  }
  const byName = new Map();
  for (const [licenseGroup, packages] of Object.entries(JSON.parse(stdout))) {
    for (const pkg of packages) {
      if (!(pkg?.name && names.has(pkg.name)) || byName.has(pkg.name)) {
        continue;
      }
      const homepage = typeof pkg.homepage === "string" ? pkg.homepage.trim() : "";
      byName.set(pkg.name, {
        name: pkg.name,
        // Several installed versions: the newest.
        version: [...(pkg.versions ?? [])].sort(compareVersions).at(-1) ?? "",
        license: pkg.license || licenseGroup || "Unknown",
        ...(homepage ? { homepage } : {}),
      });
    }
  }
  return byName;
}

function compareVersions(a, b) {
  return a.localeCompare(b, undefined, { numeric: true });
}

function packagesFor(names, byName) {
  return [...names]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => byName.get(name) ?? { name, version: "", license: "Unknown" });
}

function writeOssCredits() {
  const workspaces = workspaceDirectDeps();
  /** @type {Map<string, Set<string>>} */
  const declaredBy = new Map();
  for (const ws of workspaces) {
    for (const name of ws.deps) {
      declaredBy.set(name, (declaredBy.get(name) ?? new Set()).add(ws.id));
    }
  }
  const byName = licenseIndex(new Set(declaredBy.keys()));
  const shared = [...declaredBy].filter(([, owners]) => owners.size > 1).map(([name]) => name);
  const groups = workspaces
    .map((ws) => ({
      id: ws.id,
      kind: ws.kind,
      label: ws.label,
      packages: packagesFor(
        [...ws.deps].filter((name) => declaredBy.get(name)?.size === 1),
        byName,
      ),
    }))
    .filter((group) => group.packages.length > 0)
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.label.localeCompare(b.label));

  const payload = { shared: packagesFor(shared, byName), groups };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_CREDITS, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  const unique = groups.reduce((n, g) => n + g.packages.length, 0);
  console.log(
    `✔ ${relative(root, OUT_CREDITS)} (${payload.shared.length} shared, ${unique} in ${groups.length} workspace(s))`,
  );
}

const row = ({ name, version, license, homepage }) =>
  `| ${homepage ? `[${name}](${homepage})` : name} | ${version} | ${license} |`;
const table = (packages) =>
  ["| Package | Version | Licence |", "|---|---|---|", ...packages.map(row)].join("\n");

/** The third-party part of COPYRIGHTS.md: every workspace, the docs site too, and the tooling. */
function writeCopyrights() {
  const workspaces = workspaceDirectDeps(true);
  /** @type {Map<string, Set<string>>} */
  const declaredBy = new Map();
  const dev = new Set();
  for (const ws of workspaces) {
    for (const name of ws.deps) {
      declaredBy.set(name, (declaredBy.get(name) ?? new Set()).add(ws.id));
    }
    for (const name of ws.dev) {
      dev.add(name);
    }
  }
  const byName = licenseIndex(new Set([...declaredBy.keys(), ...dev]));
  const shared = [...declaredBy].filter(([, owners]) => owners.size > 1).map(([name]) => name);
  const parts = [];
  if (shared.length > 0) {
    parts.push(
      `### Shared\n\nDeclared by two or more of the workspaces below:\n\n${table(packagesFor(shared, byName))}`,
    );
  }
  const ordered = [...workspaces].sort(
    (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.label.localeCompare(b.label),
  );
  for (const ws of ordered) {
    const own = [...ws.deps].filter((name) => declaredBy.get(name)?.size === 1);
    if (own.length > 0) {
      parts.push(`### ${ws.label} (${ws.id})\n\n${table(packagesFor(own, byName))}`);
    }
  }
  const tooling = [...dev].filter((name) => !declaredBy.has(name));
  if (tooling.length > 0) {
    parts.push(
      `### Development only\n\nUsed to build, check and test; not part of what people run:\n\n${table(packagesFor(tooling, byName))}`,
    );
  }
  const current = readFileSync(OUT_COPYRIGHTS, "utf8");
  const start = current.indexOf(COPYRIGHTS_BEGIN);
  const end = current.indexOf(COPYRIGHTS_END);
  if (start < 0 || end < 0) {
    die(`${relative(root, OUT_COPYRIGHTS)} has no ${COPYRIGHTS_BEGIN} … ${COPYRIGHTS_END} part.`);
  }
  const section = `${COPYRIGHTS_BEGIN}\n\n${parts.join("\n\n")}\n\n${COPYRIGHTS_END}`;
  writeFileSync(
    OUT_COPYRIGHTS,
    current.slice(0, start) + section + current.slice(end + COPYRIGHTS_END.length),
  );
  console.log(
    `✔ ${relative(root, OUT_COPYRIGHTS)} (${declaredBy.size} packages, ${tooling.length} development only)`,
  );
}

if (writeChangelog) {
  writeSlimChangelog();
}
if (writeCredits) {
  writeOssCredits();
  writeCopyrights();
}

// `pnpm lint` reads these files too: leave them the way Biome formats them. Relative paths,
// so a checkout under .claude/ (which biome.json skips) is formatted as well.
const written = [
  ...(writeChangelog ? [OUT_CHANGELOG] : []),
  ...(writeCredits ? [OUT_CREDITS] : []),
];
if (written.length > 0) {
  execFileSync(
    "pnpm",
    ["exec", "biome", "format", "--write", ...written.map((file) => relative(root, file))],
    { cwd: root, stdio: "inherit" },
  );
}
