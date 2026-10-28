import { defineConfig } from "vitest/config";

// "wizards-source": the shared package is read as TypeScript, so tests need no build of it.
export default defineConfig({
  resolve: { conditions: ["wizards-source"] },
  ssr: { resolve: { conditions: ["wizards-source"] } },
  test: {
    root: ".",
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    environment: "node",
    // The first test of a file starts the app and its database; on a loaded machine or runner
    // that alone can pass vitest's five seconds (v0.2.41's CI, and a local run beside a build).
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
