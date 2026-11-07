import { defineConfig } from "vitest/config";

// "wizards-source": workspace packages are read as TypeScript, so tests need no build of them.
export default defineConfig({
  resolve: { conditions: ["wizards-source"] },
  ssr: { resolve: { conditions: ["wizards-source"] } },
  test: { root: ".", include: ["src/**/*.test.ts"], environment: "node" },
});
