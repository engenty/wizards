import { createTool } from "@mastra/core/tools";
import { readableIds } from "../broker/rwx.js";
import { currentRole } from "../services/access.js";
import { runReport, startRun } from "../services/runs.js";
import { readsOf } from "../services/space-parent.js";
import { listWizards } from "../services/wizards.js";
import { attempt } from "../tools/shared.js";
import type { ElementCaller } from "./caller.js";
import { elementCall } from "./gate.js";
import { ELEMENT_SPECS } from "./specs.js";

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
  // With `orgSpaces` a space under the organization's root runs its own wizards and the root's;
  // a run of the root's belongs to the space (docs/plans/org-spaces.md).
  const reads = await readsOf(caller.space.id);
  const sources = reads ? [caller.space.id, reads.parentId] : [caller.space.id];
  /** The published wizards of a source the caller may read. */
  const readable = async (spaceId: string) => {
    const published = (await listWizards(userId, spaceId)).filter((w) => w.published);
    const ok = new Set(
      await readableIds(
        spaceId,
        caller.subjects,
        "wizard",
        published.map((w) => w.id),
      ),
    );
    return published.filter((w) => ok.has(w.id));
  };
  /** Where a wizard is: the first source that has it published. */
  const sourceOf = async (wizardId: string) => {
    for (const spaceId of sources) {
      const found = (await listWizards(userId, spaceId)).find(
        (w) => w.id === wizardId && w.published,
      );
      if (found) {
        return spaceId;
      }
    }
    return null;
  };
  return {
    wizard_list: createTool({
      id: "wizard_list",
      description: ELEMENT_SPECS.wizard_list.description(),
      inputSchema: ELEMENT_SPECS.wizard_list.input,
      execute: (input) =>
        attempt(() =>
          elementCall(
            caller,
            { action: "wizard_list", about: "wizards", perm: "r", input },
            async () => {
              const all = (await Promise.all(sources.map(readable))).flat();
              return {
                wizards: all.map((w) => ({
                  id: w.id,
                  title: w.title,
                  description: w.description ?? "",
                })),
              };
            },
          ),
        ),
    }),
    wizard_run: createTool({
      id: "wizard_run",
      description: ELEMENT_SPECS.wizard_run.description(),
      inputSchema: ELEMENT_SPECS.wizard_run.input,
      execute: async (input) => {
        const from = (await sourceOf(input.wizardId)) ?? caller.space.id;
        return attempt(() =>
          elementCall(
            caller,
            {
              action: "wizard_run",
              resource: { kind: "wizard", id: input.wizardId },
              rulesIn: from,
              perm: "x",
              input,
            },
            async () => {
              if (!(await sourceOf(input.wizardId))) {
                throw new Error(`No published wizard "${input.wizardId}" in this space.`);
              }
              const { runId, refused } = await startRun(userId, input.wizardId, input.answers, {
                // A wizard of the root runs with its data here; a client's run is kept in the
                // space they are in, whichever wizard it is.
                clientSpaceId:
                  from === caller.space.id && currentRole() !== "client" ? null : caller.space.id,
                // Started in a Work chat: its folder lists the result.
                chatId: caller.where.chatId ?? null,
              });
              const report = await runReport(userId, runId, input.waitSeconds);
              return { ...report, ...(refused ? { refusedAnswers: refused } : {}) };
            },
          ),
        );
      },
    }),
  };
}
