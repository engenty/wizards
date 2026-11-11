import { definePlugin } from "@engenty/wizards/plugin";
import { z } from "zod";

/**
 * The tool of edge-waits-deploys-stops.test.ts: it holds until the test lets it go
 * (`globalThis.__edgeHeld`), then answers. It reaches nothing outside.
 */
export default definePlugin((wizards) => {
  wizards.server.registerTool({
    name: "hold",
    title: "Hold",
    description: "Holds until it is let go, then repeats the word in capitals.",
    inputSchema: z.object({ word: z.string() }),
    execute: async ({ word }, ctx) => {
      const held = (
        globalThis as {
          __edgeHeld?: { entered(runId: string): void; until(runId: string): Promise<void> };
        }
      ).__edgeHeld;
      held?.entered(ctx.runId);
      await held?.until(ctx.runId);
      return { said: word.toUpperCase() };
    },
  });
});
