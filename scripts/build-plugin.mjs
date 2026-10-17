// Builds the studio half of a plugin (docs/content/dev/plugins): `ui/plugin.tsx` becomes `dist/client.js`
// and `dist/client.css`, the two files the runtime serves and the studio loads.
//
//   node scripts/build-plugin.mjs <plugin folder> [--watch]
//
// --watch  build again whenever a file of the studio half changes; a runtime that watches its
//          plugins (PLUGINS_WATCH=1, the default from source) tells the open studio
//
// client.js   one script. React, the router, the query cache, the studio's components and the
//             plugin SDK are not in it: it takes them from the studio that loads it
//             (`__WIZARDS_STUDIO__`, apps/web/src/plugins/host.tsx), so both draw with one React.
// client.css  the Tailwind utilities the plugin's files use, built against the studio's theme
//             by reference: the studio's names (`bg-paper-2`), none of its variables or resets.
//             Every rule holds only inside the plugin's own part of the page
//             (`[data-plugin="<id>"]`) and sits in a layer above the studio's utilities, so a
//             plugin's stylesheet never changes how the studio itself looks.
//
// The server half needs no build: the runtime reads `src/plugin.ts` as it is.
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const web = join(root, "apps", "web");

const args = process.argv.slice(2);
const watch = args.includes("--watch");
const folder = args.find((arg) => !arg.startsWith("--"));
if (!folder) {
  console.error("Usage: node scripts/build-plugin.mjs <plugin folder> [--watch]");
  process.exit(1);
}
const plugin = resolve(folder);

const manifestFile = join(plugin, "engenty.plugin.json");
if (!existsSync(manifestFile)) {
  console.error(
    `${manifestFile} is missing: a plugin with a studio half is a folder with a manifest.`,
  );
  process.exit(1);
}
const { id } = JSON.parse(readFileSync(manifestFile, "utf8"));
if (!/^[a-z][a-z0-9-]{0,39}$/.test(id ?? "")) {
  console.error(
    `${manifestFile}: "id" must be lower case, digits and "-", starting with a letter.`,
  );
  process.exit(1);
}

const entry = ["ui/plugin.tsx", "ui/plugin.ts"].map((file) => join(plugin, file)).find(existsSync);
if (!entry) {
  console.log(`${id}: no ui/plugin.tsx — the plugin has no studio half.`);
  process.exit(0);
}

// The build tools are the studio's own, so a plugin is built with what the studio is built with.
const fromWeb = createRequire(join(web, "package.json"));
const load = (name) => import(pathToFileURL(fromWeb.resolve(name)).href);
const { build } = await load("vite");
const { default: react } = await load("@vitejs/plugin-react");
const { default: tailwindcss } = await load("@tailwindcss/vite");

/** What the studio hands over, and where a plugin's script finds each. */
const SHARED = {
  react: "__WIZARDS_STUDIO__.react",
  "react/jsx-runtime": "__WIZARDS_STUDIO__.jsx",
  "react-dom": "__WIZARDS_STUDIO__.reactDom",
  "react-router": "__WIZARDS_STUDIO__.router",
  "@tanstack/react-query": "__WIZARDS_STUDIO__.query",
  "@engenty-wizards/web/ui": "__WIZARDS_STUDIO__.ui",
  "@engenty/wizards/plugin/studio": "__WIZARDS_STUDIO__.sdk",
  // The name plugins written before `@engenty/wizards/plugin/studio` import.
  "@engenty-wizards/plugin-sdk/studio": "__WIZARDS_STUDIO__.sdk",
};

// The entry Vite builds: the plugin's own, plus the stylesheet made for it.
const work = mkdtempSync(join(tmpdir(), `wizards-plugin-${id}-`));
const css = (path) => JSON.stringify(path);
writeFileSync(
  join(work, "tailwind.css"),
  `@import ${css(fromWeb.resolve("tailwindcss/theme.css"))} theme(inline reference);
@import ${css(join(root, "packages/runner/src/theme.css"))} theme(reference);
@layer wizards-plugin {
  [data-plugin="${id}"] {
    @tailwind utilities source(none);
  }
}
@source ${css(join(plugin, "ui"))};
/* The studio's components a plugin draws carry the studio's classes: the same rules, in the
   plugin's own order, so its stylesheet decides alone inside its part of the page. */
@source ${css(join(web, "src/ui"))};
@source ${css(join(root, "packages/runner/src/ui.tsx"))};
`,
);
writeFileSync(
  join(work, "entry.ts"),
  `import "./tailwind.css";\nexport { default } from ${JSON.stringify(entry)};\n`,
);

/** A package the plugin's folder does not have (an icon set, say) comes from the studio's. */
const studioPackages = {
  name: "wizards:studio-packages",
  async resolveId(source, importer, options) {
    if (!importer || source.startsWith(".") || source.startsWith("/") || source.startsWith("\0")) {
      return null;
    }
    const own = await this.resolve(source, importer, { ...options, skipSelf: true });
    return own ?? this.resolve(source, join(web, "src/main.tsx"), { ...options, skipSelf: true });
  },
};

const outDir = join(plugin, "dist");
try {
  const result = await build({
    configFile: false,
    root: plugin,
    logLevel: "warn",
    plugins: [studioPackages, react(), tailwindcss()],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: {
      outDir,
      // dist/ may hold more than the studio half.
      emptyOutDir: false,
      watch: watch ? {} : null,
      lib: {
        entry: join(work, "entry.ts"),
        formats: ["iife"],
        // What the studio reads the plugin from once the script ran.
        name: `__wizardsPlugin_${id.replaceAll("-", "_")}`,
        fileName: () => "client.js",
        cssFileName: "client",
      },
      rollupOptions: { external: Object.keys(SHARED), output: { globals: SHARED } },
    },
  });
  const size = (file) => `${(statSync(join(outDir, file)).size / 1024).toFixed(1)} kB`;
  const report = () =>
    console.log(
      `${id}: dist/client.js ${size("client.js")}, dist/client.css ${size("client.css")}`,
    );
  if (watch) {
    result.on("event", (event) => {
      if (event.code === "END") {
        report();
      } else if (event.code === "ERROR") {
        console.error(`${id}:`, event.error.message);
      }
    });
    process.on("SIGINT", () => {
      rmSync(work, { recursive: true, force: true });
      process.exit(0);
    });
  } else {
    report();
  }
} finally {
  if (!watch) {
    rmSync(work, { recursive: true, force: true });
  }
}
