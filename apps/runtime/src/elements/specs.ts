import { whereSchema } from "@engenty/wizards-shared/knowledge";
import { z } from "zod";
import { prompt } from "../prompts.js";

/**
 * What each tool of the catalogue takes, and the scope an outside client needs for it
 * (docs/plans/modular.md, phase 2). The catalogue's modules make their tools with these inputs;
 * MCP (mcp/elements.ts) and the API (routes/elements.ts) are made from this list, so the three
 * never drift. No input names who calls or for whom (I1): the caller is fixed before.
 */

/** What an outside client must be granted: reading data, reading elements, running them. */
export type ElementScope = "data:read" | "elements:read" | "elements:run";

const where = whereSchema.optional().describe(prompt("tools", "tool.space.where"));

export const pageReadInput = {
  path: z.string().describe("The page's path, as space_search or space_list give it: pages/…"),
  section: z
    .string()
    .optional()
    .describe("Only this section: a heading of the page, or the start of one"),
  from: z.number().int().min(0).optional().describe("Character to continue a long page at"),
};

export const ELEMENT_SPECS = {
  space_search: {
    scope: "data:read",
    description: () => prompt("tools", "tool.space_search"),
    input: z.object({
      query: z.string().describe("What to look for: a question or keywords"),
      where,
      limit: z.number().int().min(1).max(12).optional().describe("Items to get, 6 by default"),
    }),
  },
  space_list: {
    scope: "data:read",
    description: () => prompt("tools", "tool.space_list"),
    input: z.object({ where }),
  },
  page_read: {
    scope: "data:read",
    description: () => prompt("tools", "tool.page_read.knowledge"),
    input: z.object(pageReadInput),
  },
  table_read: {
    scope: "data:read",
    description: () => prompt("tools", "tool.table_read"),
    input: z.object({
      path: z.string().describe("The table's path: tables/…"),
      where: whereSchema.optional().describe("Filter by columns, by their names"),
      columns: z.array(z.string()).max(40).optional().describe("Only these columns"),
      limit: z.number().int().min(1).max(1000).optional(),
      offset: z.number().int().min(0).optional(),
    }),
  },
  space_document: {
    scope: "data:read",
    description: () => prompt("tools", "tool.space_document"),
    input: z.object({
      path: z
        .string()
        .describe("The file's path: files/…, as the page's front matter or a hit names it"),
      from: z.number().int().min(0).optional().describe("Character to start at"),
    }),
  },
  skill_list: {
    scope: "elements:read",
    description: () =>
      "Lists the space's skills you may read: their name and what each is for. Load one with skill_load.",
    input: z.object({}),
  },
  skill_load: {
    scope: "elements:read",
    description: () =>
      "Loads one of the space's skills by its name: its instructions and the files it brings. skill_list names them.",
    input: z.object({ name: z.string().describe("The skill's name, as listed") }),
  },
  skill_read: {
    scope: "elements:read",
    description: () => prompt("tools", "tool.skill_read"),
    input: z.object({
      name: z.string().describe("The skill's name"),
      path: z.string().describe("The file's path in the skill, e.g. references/forms.md"),
      from: z.number().int().min(0).optional().describe("Character to continue a long file at"),
    }),
  },
  connection_list: {
    scope: "elements:read",
    description: () =>
      "Lists the actions of the space's connections (mail, calendar, CRM …) you may use: each action's name, what it does, whether it reads or writes, and its input. Call one with connection_call.",
    input: z.object({}),
  },
  connection_call: {
    scope: "elements:run",
    description: () =>
      "Calls one action of the space's connections, as connection_list names it, with its input. A read runs at once; a write, a send or a delete runs only where the space's rules allow it without a person's yes: otherwise it is refused and says why.",
    input: z.object({
      name: z.string().describe("The action's name, as connection_list gives it"),
      input: z.record(z.string(), z.unknown()).default({}),
    }),
  },
  wizard_list: {
    scope: "elements:read",
    description: () =>
      "Lists the space's published wizards you may run: their id, title and what they do. Run one with wizard_run.",
    input: z.object({}),
  },
  wizard_run: {
    scope: "elements:run",
    description: () =>
      "Runs one of the space's published wizards as the person you work for, with answers for its first page. Returns the run: its result, or the page or confirmation it waits for.",
    input: z.object({
      wizardId: z.string().describe("The wizard's id, as wizard_list gives it"),
      answers: z.record(z.string(), z.unknown()).default({}),
      waitSeconds: z.number().int().min(0).max(45).default(20),
    }),
  },
} satisfies Record<string, { scope: ElementScope; description: () => string; input: z.ZodObject }>;

export type ElementToolName = keyof typeof ELEMENT_SPECS;

/** The names the catalogue can give. */
export const ELEMENT_TOOL_NAMES = Object.keys(ELEMENT_SPECS) as ElementToolName[];
