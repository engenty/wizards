// Stages and packs the three npm packages of a release:
//
//   @engenty/wizards-runtime  the runtime (built server, built SPA, plugin template, the modules),
//                             the `wizards` command and the workspace packages inside it: what the
//                             installer (apps/web/public/install.sh), the updates and the desktop
//                             app install into ~/.engenty/wizards
//   wizards                   the launcher `npx wizards` runs: bin/wizards.mjs and install.sh,
//                             no dependencies, a few dozen KB. It installs the runtime with the
//                             installer and hands over to it (bin/wizards.mjs).
//   @engenty/wizards          what code outside this repo imports: packages/wizards/dist as its
//                             build leaves it (packages/wizards/scripts/build.mjs)
//
//   node scripts/npm-package.mjs [--skip-build] [--version 1.2.3] [--apple <wizards-apple>]
//
// --skip-build  reuse the dist/ folders of the checkout instead of building
// --version     the version to publish (default: the root package.json's)
// --apple       the `wizards-apple` helper built on a Mac (apps/runtime/scripts/build-apple.mjs),
//               for a package made elsewhere; a Mac's own build ships as it is
//
// Out: dist/npm/runtime/, dist/npm/wizards/ and dist/npm/engenty-wizards/ (the staged folders),
// dist/npm/engenty-wizards-runtime-<version>.tgz, dist/npm/wizards-<version>.tgz and
// dist/npm/engenty-wizards-<version>.tgz.
// Publish the runtime first: the launcher installs the runtime of its own version from npm.
//
// The folder keeps the checkout's layout (apps/runtime/dist, apps/web/dist, plugin/), so the
// runtime finds the SPA and the plugin template the same way everywhere.
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const outDir = join(root, "dist", "npm");
const stage = join(outDir, "runtime");
const launcherStage = join(outDir, "wizards");
const libraryStage = join(outDir, "engenty-wizards");
const RUNTIME = "@engenty/wizards-runtime";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};

const run = (cmd, cmdArgs, cwd = root) => {
  console.log(`$ ${cmd} ${cmdArgs.join(" ")}`);
  return execFileSync(cmd, cmdArgs, {
    cwd,
    stdio: ["ignore", "pipe", "inherit"],
    encoding: "utf8",
  });
};
const readJson = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));

// --- 1. build ---------------------------------------------------------------------------
const BUILT = [
  "apps/runtime/dist",
  "apps/web/dist",
  "packages/shared/dist",
  "packages/wizards/dist",
];
if (flag("skip-build")) {
  for (const dir of BUILT) {
    if (!existsSync(join(root, dir))) {
      throw new Error(`${dir}/ is missing — run without --skip-build.`);
    }
  }
} else {
  // tsc leaves files of deleted sources behind: build into empty folders.
  for (const dir of BUILT) {
    rmSync(join(root, dir), { recursive: true, force: true });
  }
  execFileSync("pnpm", ["build"], { cwd: root, stdio: "inherit" });
}

// --- 2. the files -----------------------------------------------------------------------
rmSync(outDir, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
for (const path of [
  "apps/runtime/dist",
  "apps/web/dist",
  "plugin",
  "bin",
  "LICENSE",
  "README.md",
]) {
  cpSync(join(root, path), join(stage, path), { recursive: true });
}
// The plugins that ship with the runtime (modules/README.md): their files as they are, with the
// built studio half and without what only their build needs.
cpSync(join(root, "modules"), join(stage, "modules"), {
  recursive: true,
  filter: (source) => !/[\\/](node_modules|\.turbo)$/.test(source),
});
chmodSync(join(stage, "bin", "wizards.mjs"), 0o755);
// Apple Intelligence as a model needs the helper only a Mac builds: handed in where the package
// is made on Linux (release.yml), else the runtime's own build left it in dist/apple.
const apple = option("apple");
if (apple) {
  const to = join(stage, "apps", "runtime", "dist", "apple", "wizards-apple");
  mkdirSync(join(stage, "apps", "runtime", "dist", "apple"), { recursive: true });
  cpSync(apple, to);
  chmodSync(to, 0o755);
}

// --- 3. package.json --------------------------------------------------------------------
// The runtime's dependencies at the versions the checkout's lockfile resolved: what was tested
// is what gets installed. A workspace package comes along inside the tarball (bundled) as its
// built files; its own dependencies join the list.
const pkg = readJson("package.json");
const version = option("version") ?? pkg.version;
const DESCRIPTION =
  "Make a wish. Get your wizard. It guides you step by step. Let AI do the work. Runs on your machine, on the AI subscription you already have.";
const about = {
  license: pkg.license,
  homepage: "https://engenty.ai",
  repository: { type: "git", url: "git+https://github.com/engenty/wizards.git" },
};
const resolved = (dir) => {
  const [listed] = JSON.parse(
    run("pnpm", ["list", "--prod", "--depth", "0", "--json"], join(root, dir)),
  );
  return listed.dependencies ?? {};
};
const dependencies = {};
const bundled = [];
// The runtime imports @engenty/wizards for /plugin alone: its copy leaves out /openui, which
// bundles the runner and brings the runner's libraries.
const ONLY = { "@engenty/wizards": "plugin" };
const collect = (dir) => {
  const installed = resolved(dir);
  for (const [name, range] of Object.entries(readJson(`${dir}/package.json`).dependencies ?? {})) {
    if (range.startsWith("workspace:")) {
      const from = `packages/${name.split("/").pop()}`;
      const manifest = readJson(`${from}/package.json`);
      bundled.push(name);
      dependencies[name] = manifest.version;
      const to = join(stage, "node_modules", name);
      const only = ONLY[name];
      mkdirSync(to, { recursive: true });
      cpSync(join(root, from, "dist", only ?? ""), join(to, "dist", only ?? ""), {
        recursive: true,
      });
      // Without the condition that points at the TypeScript sources, which are not shipped.
      const exports = Object.fromEntries(
        Object.entries(manifest.exports ?? {})
          .filter(([key]) => !only || key === `./${only}` || key.startsWith(`./${only}/`))
          .map(([key, value]) => [key, typeof value === "string" ? value : value.default]),
      );
      writeFileSync(
        join(to, "package.json"),
        `${JSON.stringify(
          {
            name,
            version: manifest.version,
            license: manifest.license,
            type: manifest.type,
            exports,
          },
          null,
          2,
        )}\n`,
      );
      if (!only) {
        collect(from);
      }
    } else {
      const exact = installed[name]?.version;
      if (!exact) {
        throw new Error(`${name} (${dir}) is not installed — run pnpm install.`);
      }
      dependencies[name] = exact;
    }
  }
};
collect("apps/runtime");
// node-pty brings built binaries for macOS and Windows only; elsewhere npm compiles it, and
// where that fails (no compiler) `npx wizards` still installs: the built-in terminal says it is
// not available here.
const OPTIONAL = ["node-pty"];
const sorted = (names) =>
  Object.fromEntries(
    names.sort((a, b) => a.localeCompare(b)).map((name) => [name, dependencies[name]]),
  );

writeFileSync(
  join(stage, "package.json"),
  `${JSON.stringify(
    {
      name: RUNTIME,
      version,
      description: `${DESCRIPTION} The runtime, which \`npx wizards\` installs.`,
      ...about,
      type: "module",
      bin: { wizards: "bin/wizards.mjs" },
      engines: pkg.engines,
      // Windows has no installer yet (bin/wizards.mjs says so): npm refuses at once instead of
      // installing for many minutes first.
      os: ["darwin", "linux"],
      files: ["apps", "bin", "modules", "plugin"],
      dependencies: sorted(Object.keys(dependencies).filter((name) => !OPTIONAL.includes(name))),
      optionalDependencies: sorted(OPTIONAL.filter((name) => name in dependencies)),
      bundleDependencies: bundled,
    },
    null,
    2,
  )}\n`,
);

// --- 4. the launcher ---------------------------------------------------------------------
// bin/wizards.mjs as it is (it tells the launcher from the runtime by what is beside it) and the
// installer it runs. No engines: it runs on an older Node too, and the installer brings a new one.
mkdirSync(join(launcherStage, "bin"), { recursive: true });
cpSync(join(root, "bin", "wizards.mjs"), join(launcherStage, "bin", "wizards.mjs"));
chmodSync(join(launcherStage, "bin", "wizards.mjs"), 0o755);
cpSync(join(root, "apps", "web", "public", "install.sh"), join(launcherStage, "install.sh"));
for (const file of ["LICENSE", "README.md"]) {
  cpSync(join(root, file), join(launcherStage, file));
}
writeFileSync(
  join(launcherStage, "package.json"),
  `${JSON.stringify(
    {
      name: "wizards",
      version,
      description: DESCRIPTION,
      ...about,
      type: "module",
      bin: { wizards: "bin/wizards.mjs" },
      os: ["darwin", "linux"],
      files: ["bin", "install.sh"],
    },
    null,
    2,
  )}\n`,
);

// --- 5. @engenty/wizards ----------------------------------------------------------------
// The build's dist/ and a package.json without the condition that points at the sources. Its
// libraries as ranges, the way a library names them: the host's lockfile settles them.
// typesVersions: TypeScript with `moduleResolution: "node"` doesn't read `exports`.
const library = readJson("packages/wizards/package.json");
mkdirSync(libraryStage, { recursive: true });
cpSync(join(root, "packages", "wizards", "dist"), join(libraryStage, "dist"), { recursive: true });
cpSync(join(root, "packages", "wizards", "README.md"), join(libraryStage, "README.md"));
cpSync(join(root, "LICENSE"), join(libraryStage, "LICENSE"));
const libraryExports = Object.fromEntries(
  Object.entries(library.exports).map(([key, value]) => {
    if (typeof value === "string") {
      return [key, value];
    }
    const { "wizards-source": _source, ...published } = value;
    return [key, Object.keys(published).length === 1 ? published.default : published];
  }),
);
const typesVersions = Object.fromEntries(
  Object.entries(libraryExports)
    .filter(([, value]) => typeof value === "object" && value.types)
    .map(([key, value]) => [key.slice(2), [value.types]]),
);
writeFileSync(
  join(libraryStage, "package.json"),
  `${JSON.stringify(
    {
      name: library.name,
      version,
      description: library.description,
      license: library.license,
      homepage: about.homepage,
      repository: { ...about.repository, directory: "packages/wizards" },
      type: "module",
      exports: libraryExports,
      typesVersions: { "*": typesVersions },
      files: ["dist"],
      dependencies: library.dependencies,
      peerDependencies: library.peerDependencies,
      peerDependenciesMeta: library.peerDependenciesMeta,
      publishConfig: { access: "public" },
    },
    null,
    2,
  )}\n`,
);

// --- 6. pack ----------------------------------------------------------------------------
run("npm", ["pack", "--pack-destination", outDir, "--loglevel=error"], stage);
run("npm", ["pack", "--pack-destination", outDir, "--loglevel=error"], launcherStage);
run("npm", ["pack", "--pack-destination", outDir, "--loglevel=error"], libraryStage);
const tarball = join(outDir, `engenty-wizards-runtime-${version}.tgz`);
const launcherTarball = join(outDir, `wizards-${version}.tgz`);
const libraryTarball = join(outDir, `engenty-wizards-${version}.tgz`);

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(path);
    } else {
      yield path;
    }
  }
}
const sizeOf = (files) => files.reduce((sum, file) => sum + statSync(file).size, 0);
const files = [...walk(stage)];
const launcherFiles = [...walk(launcherStage)];
const libraryFiles = [...walk(libraryStage)];
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const kb = (bytes) => `${Math.ceil(bytes / 1024)} KB`;
console.log(`
${RUNTIME} ${version}
  staged    ${files.length} files, ${mb(sizeOf(files))}  (${stage})
  tarball   ${mb(statSync(tarball).size)}  (${tarball})
  depends   ${Object.keys(dependencies).length} packages, ${bundled.length} bundled (${bundled.join(", ")})

wizards ${version} (the launcher)
  staged    ${launcherFiles.length} files, ${kb(sizeOf(launcherFiles))}  (${launcherStage})
  tarball   ${kb(statSync(launcherTarball).size)}  (${launcherTarball})

${library.name} ${version}
  staged    ${libraryFiles.length} files, ${mb(sizeOf(libraryFiles))}  (${libraryStage})
  tarball   ${kb(statSync(libraryTarball).size)}  (${libraryTarball})
`);
