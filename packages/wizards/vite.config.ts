import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defaultClientConditions, defineConfig } from "vite";

const entry = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * `/openui` as the published package ships it (scripts/build.mjs): the runner and the shared
 * modules bundled in from their sources, every other package left as an import, so the libraries
 * are the host's own `dependencies` and React, OpenUI and zod its peers.
 */
export default defineConfig({
  plugins: [react()],
  resolve: { conditions: ["wizards-source", ...defaultClientConditions] },
  build: {
    outDir: "dist/openui",
    emptyOutDir: false,
    sourcemap: true,
    lib: {
      entry: { index: entry("./src/openui/index.ts"), server: entry("./src/openui/server.ts") },
      formats: ["es"],
    },
    rollupOptions: {
      external: (id) =>
        !(id.startsWith(".") || id.startsWith("/") || id.startsWith("\0")) &&
        !id.startsWith("@engenty-wizards/") &&
        !/^[A-Za-z]:[\\/]/.test(id),
      output: { chunkFileNames: "chunks/[name]-[hash].js" },
    },
  },
});
