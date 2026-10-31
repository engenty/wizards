import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { readableIds } from "../broker/rwx.js";
import { runReport, startRun } from "../services/runs.js";
import { listWizards } from "../services/wizards.js";
import { attempt } from "../tools/shared.js";
import type { ElementCaller } from "./caller.js";
import { elementCall } from "./gate.js";

/**
 * The space's published wizards as tools of the catalogue: list them (`r` on each) and run one
 * (`x`) as the person calling, who answers its pages as anyone running it does. Only a signed-in
 * person runs a wizard this way: a guest reaches a wizard by its link, Goose and a run's step do
 * not start runs.
 */

/** Whether the caller is a person who may start runs. */
const runsAs = (caller: ElementCaller) =>
  (caller.who.kind === "person" || caller.who.kind === "admin") && caller.who.id
    ? caller.who.id
    : null;

export async function wizardTools(caller: ElementCaller): Promise<Record<string, any>> {
  const userId = runsAs(caller);
  if (!userId) {
    return {};
  }
  const spaceId = caller.space.id;
  return {
    wizard_list: createTool({
      id: "wizard_list",
      description:
        "Lists the space's published wizards you may run: their id, title and what they do. Run one with wizard_run.",
      inputSchema: z.object({}),
      execute: (input) =>
        attempt(() =>
          elementCall(caller, { action: "wizard_list", perm: "r", input }, async () => {
            const published = (await listWizards(userId, spaceId)).filter((w) => w.published);
            const ok = new Set(
              await readableIds(
                spaceId,
                caller.subjects,
                "wizard",
                published.map((w) => w.id),
              ),
            );
            return {
              wizards: published
                .filter((w) => ok.has(w.id))
                .map((w) => ({ id: w.id, title: w.title, description: w.description ?? "" })),
            };
          }),
        ),
    }),
    wizard_run: createTool({
      id: "wizard_run",
      description:
        "Runs one of the space's published wizards as the person you work for, with answers for its first page. Returns the run: its result, or the page or confirmation it waits for.",
      inputSchema: z.object({
        wizardId: z.string().describe("The wizard's id, as wizard_list gives it"),
        answers: z.record(z.string(), z.unknown()).default({}),
        waitSeconds: z.number().int().min(0).max(45).default(20),
      }),
      execute: (input) =>
        attempt(() =>
          elementCall(
            caller,
            {
              action: "wizard_run",
              resource: { kind: "wizard", id: input.wizardId },
              perm: "x",
              input,
            },
            async () => {
              const published = (await listWizards(userId, spaceId)).find(
                (w) => w.id === input.wizardId && w.published,
              );
              if (!published) {
                throw new Error(`No published wizard "${input.wizardId}" in this space.`);
              }
              const { runId, refused } = await startRun(userId, input.wizardId, input.answers);
              const report = await runReport(userId, runId, input.waitSeconds);
              return { ...report, ...(refused ? { refusedAnswers: refused } : {}) };
            },
          ),
        ),
    }),
  };
}
