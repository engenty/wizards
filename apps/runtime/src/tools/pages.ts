import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { StepContext } from "../engine/types.js";
import { runPages, writeRunPage } from "../services/space-data.js";
import { pageReadInput, readKnowledgePage } from "./project.js";
import { attempt, clip } from "./shared.js";

/**
 * Pages for a step that lists "pages": Markdown its wizard keeps for every run — notes, a log, a
 * summary that grows — its memory, shown in the studio's Memory tab and under Space → Data. Its
 * page_read also reads the pages of Knowledge, by path. A test run reads the wizard's pages but
 * writes into a copy of its own in the run's state, which goes with the run.
 */
export function pageTools(ctx: StepContext) {
  const projectId = ctx.project.id;
  const wizardId = ctx.store.wizardId;
  /** The wizard's pages as this run sees them: a test run's own writes over the real ones. */
  const pages = async (): Promise<{ title: string; markdown: string }[]> => {
    const real = await runPages(projectId, wizardId);
    const copy = ctx.test ? (ctx.state.memory ?? {}) : {};
    const lower = (t: string) => t.toLowerCase();
    const written = Object.entries(copy).map(([title, markdown]) => ({ title, markdown }));
    return [
      ...real.filter((p) => !written.some((w) => lower(w.title) === lower(p.title))),
      ...written,
    ].sort((a, b) => a.title.localeCompare(b.title));
  };
  return {
    page_read: createTool({
      id: "page_read",
      description:
        "Read a page: one this wizard wrote, by its title, or a page of Knowledge, by its path (pages/…). Without either it lists the wizard's pages.",
      inputSchema: z.object({
        title: z.string().optional().describe("A page this wizard wrote"),
        path: pageReadInput.path.optional(),
        section: pageReadInput.section,
        from: pageReadInput.from,
      }),
      execute: ({ title, path, section, from }) => {
        if (path?.trim()) {
          return readKnowledgePage(ctx, { path, section, from });
        }
        return attempt(async () => {
          const all = await pages();
          if (!title?.trim()) {
            return { pages: all.map((p) => ({ title: p.title, chars: p.markdown.length })) };
          }
          const page = all.find((p) => p.title.toLowerCase() === title.trim().toLowerCase());
          if (!page) {
            return { error: `No page "${title}".`, pages: all.map((p) => p.title) };
          }
          return { title: page.title, markdown: clip(page.markdown, 40_000) };
        });
      },
    }),
    page_write: createTool({
      id: "page_write",
      description:
        "Write a page of this wizard in Markdown, kept for every later run and shown to the admin in the studio. A page with the same title is replaced — or added to with append: true (a log, a list that grows). Pages of Knowledge are read-only.",
      inputSchema: z.object({
        title: z.string().min(1).max(200),
        markdown: z.string().max(200_000),
        append: z.boolean().optional(),
      }),
      execute: (input) =>
        attempt(async () => {
          if (ctx.test) {
            const title = input.title.trim();
            const before = (await pages()).find(
              (p) => p.title.toLowerCase() === title.toLowerCase(),
            );
            const markdown =
              before && input.append
                ? `${before.markdown.trimEnd()}\n\n${input.markdown.trim()}`
                : input.markdown;
            ctx.state.memory = { ...ctx.state.memory, [before?.title ?? title]: markdown };
            await ctx.emit("tool", {
              code: "writesPage",
              params: { title: before?.title ?? title },
            });
            return { title: before?.title ?? title, chars: markdown.length, test: true };
          }
          const page = await writeRunPage(projectId, wizardId, input);
          await ctx.emit("tool", { code: "writesPage", params: { title: page.title } });
          return page;
        }),
    }),
  };
}
