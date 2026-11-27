import { defineConfig } from "vite";

/**
 * The portal's server as one file, `dist/server/index.js`: the shared package (the public page's
 * look, words and stylesheet, `@engenty/wizards-shared/page-*`) is read as TypeScript and built
 * in, since the image ships only the server's own dependencies (hono). The SPA has its own build
 * (vite.config.ts).
 */
export default defineConfig({
  resolve: { conditions: ["wizards-source"] },
  ssr: {
    resolve: { conditions: ["wizards-source"], externalConditions: ["node"] },
    noExternal: ["@engenty/wizards-shared"],
    target: "node",
  },
  esbuild: { jsx: "automatic", jsxImportSource: "hono/jsx" },
  build: {
    ssr: "server/index.ts",
    outDir: "dist/server",
    emptyOutDir: true,
    target: "node22",
    rollupOptions: { output: { entryFileNames: "index.js", format: "es" } },
  },
});
