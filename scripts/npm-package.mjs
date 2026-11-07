// Stages and packs the npm packages of a release:
//
//   @engenty/wizards-runtime  the runtime (built server, built SPA, plugin template, the modules),
//                             the `wizards` command and the workspace packages inside it: what the
//                             installer (apps/web/public/install.sh), the updates and the desktop
//                             app install into ~/.engenty/wizards
//   wizards                   the launcher `npx wizards` runs: bin/wizards.mjs and the installers,
//                             no dependencies, a few dozen KB. It installs the runtime with the
//                             installer and hands over to it (bin/wizards.mjs).
//   @engenty/wizards          what code outside this repo imports: packages/wizards/dist as its
//                             build leaves it (packages/wizards/scripts/build.mjs)
//   @engenty/decision-model, @engenty/search-index, @engenty/search-libsql, @engenty/goose
//                             the MIT libraries in packages/: each its dist/ as tsc leaves it
//                             (tsconfig.build.json), its LICENSE and README, at the release's
//                             version. search-libsql names the other two at that version.
//
//   node scripts/npm-package.mjs [--skip-build] [--version 1.2.3] [--apple <wizards-apple>]
//
// --skip-build  reuse the dist/ folders of the checkout instead of building
// --version     the version to publish (default: the root package.json's)
// --apple       the `wizards-apple` helper built on a Mac (apps/runtime/scripts/build-apple.mjs),
//               for a package made elsewhere; a Mac's own build ships as it is
//
// Out: dist/npm/runtime/, dist/npm/wizards/, dist/npm/engenty-wizards/ and
// dist/npm/engenty-<library>/ (the staged folders), dist/npm/engenty-wizards-runtime-<version>.tgz,
// dist/npm/wizards-<version>.tgz, dist/npm/engenty-wizards-<version>.tgz and
// dist/npm/engenty-<library>-<version>.tgz for each MIT library.
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
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const outDir = join(root, "dist", "npm");
const stage = join(outDir, "runtime");
const launcherStage = join(outDir, "wizards");
const libraryStage = join(outDir, "engenty-wizards");
const RUNTIME = "@engenty/wizards-runtime";
// The MIT libraries, by their folder in packages/; one that another needs comes first.
const LIBRARIES = ["decision-model", "search-index", "search-libsql", "goose"];

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
  ...LIBRARIES.map((dir) => `packages/${dir}/dist`),
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
  "LICENSE-FIGURES",
  "TRADEMARKS.md",
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
      // The workspace folder pnpm linked the package from.
      const linked = installed[name]?.path;
      if (!linked) {
        throw new Error(`${name} (${dir}) is not linked — run pnpm install.`);
      }
      const from = relative(root, linked);
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
      license: `${pkg.license} AND CC-BY-4.0`,
      type: "module",
      bin: { wizards: "bin/wizards.mjs" },
      engines: pkg.engines,
      files: ["apps", "bin", "modules", "plugin", "LICENSE-FIGURES", "TRADEMARKS.md"],
      dependencies: sorted(Object.keys(dependencies)),
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
for (const file of ["install.sh", "install.ps1"]) {
  cpSync(join(root, "apps", "web", "public", file), join(launcherStage, file));
}
for (const file of ["LICENSE", "LICENSE-FIGURES", "TRADEMARKS.md", "README.md"]) {
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
      license: `${pkg.license} AND CC-BY-4.0`,
      files: ["bin", "install.sh", "install.ps1", "LICENSE-FIGURES", "TRADEMARKS.md"],
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

// --- 6. the MIT libraries ---------------------------------------------------------------
// Each its build's dist/, LICENSE and README, and a package.json for npm: the release's version,
// `exports` without the condition that points at the sources, and the workspace libraries it
// needs at the release's version too (they are published together). No scripts, no
// devDependencies. Every path `exports` names must be in the folder: nothing outside it ships.
const libraries = LIBRARIES.map((dir) => {
  const from = join(root, "packages", dir);
  const manifest = readJson(`packages/${dir}/package.json`);
  if (manifest.license !== "MIT") {
    throw new Error(`packages/${dir} is not MIT: it doesn't ship as a library.`);
  }
  const to = join(outDir, `engenty-${dir}`);
  mkdirSync(to, { recursive: true });
  cpSync(join(from, "dist"), join(to, "dist"), { recursive: true });
  cpSync(join(from, "LICENSE"), join(to, "LICENSE"));
  if (existsSync(join(from, "README.md"))) {
    cpSync(join(from, "README.md"), join(to, "README.md"));
  }
  const exports = Object.fromEntries(
    Object.entries(manifest.exports).map(([key, value]) => {
      if (typeof value === "string") {
        return [key, value];
      }
      const { "wizards-source": _source, ...published } = value;
      return [key, published];
    }),
  );
  const targets = [manifest.main, manifest.types, ...Object.values(exports).flatMap(Object.values)];
  for (const target of targets.filter(Boolean)) {
    if (!existsSync(join(to, target))) {
      throw new Error(`${manifest.name}: ${target} is not in the package — build it first.`);
    }
  }
  const subpaths = Object.entries(exports).filter(([key]) => key !== ".");
  const dependencies = Object.fromEntries(
    Object.entries(manifest.dependencies ?? {}).map(([name, range]) => {
      if (!range.startsWith("workspace:")) {
        return [name, range];
      }
      if (!LIBRARIES.some((dir) => readJson(`packages/${dir}/package.json`).name === name)) {
        throw new Error(`${manifest.name} needs ${name}, which is not published with it.`);
      }
      return [name, version];
    }),
  );
  writeFileSync(
    join(to, "package.json"),
    `${JSON.stringify(
      {
        name: manifest.name,
        version,
        description: manifest.description,
        license: manifest.license,
        repository: manifest.repository,
        type: manifest.type,
        main: manifest.main,
        types: manifest.types,
        exports,
        ...(subpaths.length
          ? {
              typesVersions: {
                "*": Object.fromEntries(
                  subpaths.map(([key, value]) => [key.slice(2), [value.types]]),
                ),
              },
            }
          : {}),
        files: manifest.files,
        ...(Object.keys(dependencies).length ? { dependencies } : {}),
        peerDependencies: manifest.peerDependencies,
        peerDependenciesMeta: manifest.peerDependenciesMeta,
        publishConfig: manifest.publishConfig,
      },
      null,
      2,
    )}\n`,
  );
  return { name: manifest.name, stage: to, tarball: join(outDir, `engenty-${dir}-${version}.tgz`) };
});

// --- 7. pack ----------------------------------------------------------------------------
run("npm", ["pack", "--pack-destination", outDir, "--loglevel=error"], stage);
run("npm", ["pack", "--pack-destination", outDir, "--loglevel=error"], launcherStage);
run("npm", ["pack", "--pack-destination", outDir, "--loglevel=error"], libraryStage);
for (const { stage: dir } of libraries) {
  run("npm", ["pack", "--pack-destination", outDir, "--loglevel=error"], dir);
}
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
for (const { name, stage: dir, tarball: file } of libraries) {
  const staged = [...walk(dir)];
  console.log(`${name} ${version} (MIT)
  staged    ${staged.length} files, ${kb(sizeOf(staged))}  (${dir})
  tarball   ${kb(statSync(file).size)}  (${file})
`);
}
