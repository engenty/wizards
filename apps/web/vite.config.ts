import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defaultClientConditions, defineConfig } from "vite";

const apiPort = Number(process.env.API_PORT ?? 24368);
// The path the app is served under, e.g. "/wizards" for https://example.com/wizards. Empty: an origin's root.
const basePath = (process.env.APP_BASE_PATH ?? "").replace(/\/+$/, "");
// The release the app says it is: the version of the root package.json.
const appVersion: string = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
).version;

export default defineConfig(({ command }) => ({
  // Built, the app's files sit below the studio (`/studio/assets`, `/studio/icons`): the root of
  // the host belongs to others. The server serves `install.sh`, `install.ps1`, `embed.js` and `sw.js` at the
  // root as well. In development everything is served at the root.
  base: command === "build" ? `${basePath}/studio/` : "/",
  plugins: [react(), tailwindcss()],
  define: {
    "import.meta.env.VITE_APP_VERSION": JSON.stringify(appVersion),
    "import.meta.env.VITE_APP_BASE": JSON.stringify(basePath),
  },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    // "wizards-source": the shared package is read as TypeScript, so the web app needs no build of it.
    conditions: ["wizards-source", ...defaultClientConditions],
  },
  server: {
    port: Number(process.env.PORT ?? 5181),
    strictPort: true,
    allowedHosts: true,
    proxy: {
      "/api": { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false, xfwd: true },
      "/.well-known": { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false, xfwd: true },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
}));
