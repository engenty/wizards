import { existsSync, writeFileSync } from "node:fs";
import { describe, it, vi } from "vitest";

// The second runtime process of doors-host-process.test.ts: a runner that serves its routes over
// HTTP and holds the runs placed on it. Run without HOST_PORT_FILE, as a test file like any
// other, it does nothing.
const PORT_FILE = process.env.HOST_PORT_FILE;

/** How often `flaky` ran: its first try breaks. */
const tries = vi.hoisted(() => ({ flaky: 0 }));

vi.mock("@engenty/wizards-engine/steps/index", async (original) => ({
  ...(await original<typeof import("@engenty/wizards-engine/steps/index")>()),
  runAutomaticStep: async (
    step: { id: string },
    ctx: { ask(ask: unknown): Promise<{ type: string } | null> },
  ) => {
    if (step.id === "flaky" && tries.flaky++ === 0) {
      throw new Error("The first try breaks.");
    }
    if (step.id === "asking") {
      const answer = await ctx.ask({
        kind: "confirm",
        service: "Notes",
        action: { id: "notes.write", summary: "Write a note", destructive: false },
        input: "{}",
        once: true,
      });
      return { text: `asked: ${answer?.type}`, at: new Date().toISOString() };
    }
    return { text: `made ${step.id}`, at: new Date().toISOString() };
  },
}));
vi.mock("../src/engine/requirements.js", async (original) => ({
  ...(await original<typeof import("../src/engine/requirements.js")>()),
  missingModelsSaid: async () => [],
}));
vi.mock("../src/credits/credits.js", async (original) => ({
  ...(await original<typeof import("../src/credits/credits.js")>()),
  reserveForRun: async () => true,
  releaseRun: async () => undefined,
  canSpend: async () => true,
}));

describe.runIf(PORT_FILE)("the runtime process a run is placed on", () => {
  it("serves its runs until it is told to stop", { timeout: 600_000 }, async () => {
    const client = await import("../src/db/client");
    await client.migrateControlDb();
    const runner = await import("../src/engine/runner");
    const app = (await import("../src/app")).default;
    const { serve } = await import("@hono/node-server");
    runner.startRunner();
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) =>
      writeFileSync(PORT_FILE ?? "", String(info.port)),
    );
    const stop = `${PORT_FILE}.stop`;
    while (!existsSync(stop)) {
      await new Promise((r) => setTimeout(r, 100));
    }
    await runner.stopRunner();
    server.close();
  });
});
