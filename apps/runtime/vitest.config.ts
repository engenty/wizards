import { defineConfig } from "vitest/config";
import { BaseSequencer, type TestSpecification } from "vitest/node";

/**
 * How many seconds the slowest files take in CI. `--shard` puts the files on runners by it, so
 * every runner is done at about the same time; any other file counts as two. Every runner works
 * the split out by itself: it must not depend on anything but the files and this list.
 */
const SECONDS: Record<string, number> = {
  "durable-turn": 60,
  signals: 45,
  "durable-wait-process": 43,
  "durable-steps": 29,
  "durable-line": 29,
  "mail-watch": 28,
  "durable-person": 17,
  "driver.real": 15,
  "durable-wait": 15,
  failures: 15,
  "durable-person-process": 11,
  "starts-clock": 10,
  sync: 8,
  "durable-retry-process": 7,
};
const seconds = (spec: TestSpecification) =>
  SECONDS[spec.moduleId.slice(spec.moduleId.lastIndexOf("/") + 1).replace(".test.ts", "")] ?? 2;

class Balanced extends BaseSequencer {
  /** The slowest first, so none starts when the others are done. */
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    return (await super.sort(files)).toSorted((a, b) => seconds(b) - seconds(a));
  }

  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const shard = this.ctx.config.shard;
    if (!shard) return files;
    const runners = Array.from({ length: shard.count }, () => ({
      total: 0,
      files: [] as TestSpecification[],
    }));
    const slowestFirst = files.toSorted(
      (a, b) => seconds(b) - seconds(a) || (a.moduleId < b.moduleId ? -1 : 1),
    );
    for (const file of slowestFirst) {
      const free = runners.reduce((least, runner) => (runner.total < least.total ? runner : least));
      free.files.push(file);
      free.total += seconds(file);
    }
    return runners[shard.index - 1].files;
  }
}

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
    sequence: { sequencer: Balanced },
  },
});
