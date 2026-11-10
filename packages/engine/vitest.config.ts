import { defineConfig } from "vitest/config";

// "wizards-source": the workspace's packages are read as TypeScript, so tests need no build.
export default defineConfig({
  resolve: { conditions: ["wizards-source"] },
  ssr: { resolve: { conditions: ["wizards-source"] } },
  test: {
    root: ".",
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
