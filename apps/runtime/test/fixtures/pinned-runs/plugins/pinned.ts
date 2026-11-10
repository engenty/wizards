import { definePlugin } from "@engenty/wizards/plugin";
import { z } from "zod";

/**
 * The tool of pinned-runs.test.ts: it reaches nothing outside and answers the same for the same
 * input. Each call is kept on `globalThis.__pinnedStamps`, where the test reads it.
 */
export default definePlugin((wizards) => {
  wizards.server.registerTool({
    name: "stamp",
    title: "Stamp",
    description: "Repeats a word and counts its letters.",
    inputSchema: z.object({ word: z.string(), times: z.number().int().min(1).max(5) }),
    execute: async ({ word, times }, ctx) => {
      const g = globalThis as { __pinnedStamps?: unknown[] };
      g.__pinnedStamps ??= [];
      g.__pinnedStamps.push({ run: ctx.runId, step: ctx.stepId, word, times });
      return { stamped: word.repeat(times).toUpperCase(), letters: word.length * times };
    },
  });
});
