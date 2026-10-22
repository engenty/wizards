import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The studio's logic without a browser. "wizards-source": the shared package is read as
// TypeScript, so tests need no build of it.
export default defineConfig({
  resolve: {
    conditions: ["wizards-source"],
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  ssr: { resolve: { conditions: ["wizards-source"] } },
  test: { include: ["src/**/*.test.ts"], environment: "node" },
});
