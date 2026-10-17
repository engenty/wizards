import { defineConfig } from "vitest/config";

// "wizards-source": the shared package is read as TypeScript, so tests need no build of it.
export default defineConfig({
  resolve: { conditions: ["wizards-source"] },
  ssr: { resolve: { conditions: ["wizards-source"] } },
  test: { root: ".", include: ["test/**/*.test.ts"], environment: "node" },
});
