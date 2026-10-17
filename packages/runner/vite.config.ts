import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defaultClientConditions, defineConfig } from "vite";
import dts from "vite-plugin-dts";

/**
 * The package as a host without this monorepo takes it (the WordPress plugin): ES modules with
 * React external, the shared package and the libraries bundled in. `runner.css` is written by
 * scripts/css.mjs afterwards.
 */
export default defineConfig({
  plugins: [react(), dts({ rollupTypes: false, include: ["src"] })],
  resolve: { conditions: ["wizards-source", ...defaultClientConditions] },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    lib: {
      entry: {
        index: fileURLToPath(new URL("./src/index.ts", import.meta.url)),
        check: fileURLToPath(new URL("./src/check.ts", import.meta.url)),
        ui: fileURLToPath(new URL("./src/ui.tsx", import.meta.url)),
        i18n: fileURLToPath(new URL("./src/i18n.ts", import.meta.url)),
      },
      formats: ["es"],
    },
    rollupOptions: {
      external: ["react", "react-dom", "react/jsx-runtime", "react-dom/client"],
      output: { chunkFileNames: "chunks/[name]-[hash].js" },
    },
  },
});
