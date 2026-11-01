import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { readableIds, subjectsOf } from "../broker/rwx.js";
import type { StepContext } from "../engine/types.js";
import { prompt } from "../prompts.js";
import { runPages, writeRunPage } from "../services/space-data.js";
import { attempt, clip } from "./shared.js";
import { pageReadInput, readKnowledgePage } from "./space.js";

/**
 * Pages for a step that lists "pages": Markdown its wizard keeps for every run — notes, a log, a
 * summary that grows — its memory, shown in the studio's Memory tab and under Space → Data. Its
 * page_read also reads the pages of Knowledge, by path. A test run reads the wizard's pages but
 * writes into a copy of its own in the run's state, which goes with the run.
 */
export function pageTools(ctx: StepContext) {
  const spaceId = ctx.dataSpace.id;
  const wizardId = ctx.store.wizardId;
  /**
   * The wizard's pages as this run sees them: those its holder may read, a test run's own
   * writes over the real ones.
   */
  const pages = async (): Promise<{ title: string; markdown: string }[]> => {
    const all = await runPages(spaceId, wizardId);
    const ok = new Set(
      await readableIds(
        spaceId,
        subjectsOf(ctx),
        "page",
        all.map((p) => p.id),
      ),
    );
    const real = all.filter((p) => ok.has(p.id));
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
      description: prompt("tools", "tool.page_read"),
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
      description: prompt("tools", "tool.page_write"),
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
          const page = await writeRunPage(spaceId, wizardId, input);
          await ctx.emit("tool", { code: "writesPage", params: { title: page.title } });
          return page;
        }),
    }),
  };
}
