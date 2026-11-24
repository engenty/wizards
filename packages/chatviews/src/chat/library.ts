// SPDX-License-Identifier: MIT
import { createLibrary, defineAction, defineComponent, defineFunction } from "@openuidev/lang-core";
import { z } from "zod";
import { viewLang } from "../react/texts.js";

/**
 * The views a model writes in a chat, as an OpenUI library: the components of the surface
 * catalog (surface.ts) a chat may show, with their props in the order a program passes them.
 * The order is the language: a stored card is text with positional arguments, so a prop is only
 * ever appended (optional), never moved or renamed. A change that can't keep to that is
 * `engenty:core/2`, and both are kept while cards of the old one are shown.
 *
 * This module has no React: the home checks programs with it and writes the model's prompt.
 * `react/chat.tsx` draws the same components.
 */
export const CHAT_LIBRARY = "engenty:core/1";

/** A component a program passes into another: drawn where the other puts it. */
const child = z.any().describe("a component");
const children = z.array(child);
const text = z.string();
const value = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const rows = z.array(z.record(z.string(), z.any()));

/** A component of the chat library: its name, what it is for, its props in their order. */
export interface ChatComponent {
  name: string;
  description: string;
  props: z.ZodObject;
}

export const CHAT_COMPONENTS: ChatComponent[] = [
  {
    name: "Column",
    description: "Components one under the other; the root of a view",
    props: z.object({ children }),
  },
  {
    name: "Text",
    description: 'One line of plain text; "lead" is the one opening line',
    props: z.object({ text, variant: z.enum(["h3", "h4", "lead", "body", "muted"]).optional() }),
  },
  {
    name: "Markdown",
    description: "Formatted text: bold, lists, links",
    props: z.object({ text }),
  },
  {
    name: "List",
    description: "Rows one under the other",
    props: z.object({ children }),
  },
  {
    name: "Row",
    description: "One row of a List",
    props: z.object({
      title: value,
      subtitle: value.optional(),
      meta: value.optional(),
      badge: value.optional(),
      image: text.optional().describe("a file id"),
    }),
  },
  {
    name: "DetailGrid",
    description: "Facts as label and value",
    props: z.object({ rows: z.array(z.object({ label: text, value })) }),
  },
  {
    name: "Badge",
    description: "A short mark",
    props: z.object({
      label: value,
      tone: z.enum(["default", "success", "warning", "accent"]).optional(),
    }),
  },
  {
    name: "Grid",
    description: "Tiles side by side; min: the narrowest a tile gets in rem (14 for cards)",
    props: z.object({
      children,
      columns: z.number().optional(),
      min: z.number().optional(),
    }),
  },
  {
    name: "Metric",
    description: "A key figure",
    props: z.object({ label: value, value, caption: value.optional() }),
  },
  {
    name: "Table",
    description: "Figures people compare across columns; never a table of things",
    props: z.object({
      rows,
      columns: z.array(z.object({ key: text, label: text })).optional(),
    }),
  },
  {
    name: "Image",
    description: "A picture of the space's files",
    props: z.object({ src: text.describe("a file id"), alt: text.optional() }),
  },
  {
    name: "BarChart",
    description: "Bars; labelKey/valueKey name the columns of points that hold label and number",
    props: z.object({
      points: rows,
      title: text.optional(),
      labelKey: text.optional(),
      valueKey: text.optional(),
    }),
  },
  {
    name: "LineChart",
    description: "A line over points; labelKey/valueKey as for BarChart",
    props: z.object({
      points: rows,
      title: text.optional(),
      labelKey: text.optional(),
      valueKey: text.optional(),
    }),
  },
  {
    name: "DonutChart",
    description: "Shares of a whole; labelKey/valueKey as for BarChart",
    props: z.object({
      slices: rows,
      title: text.optional(),
      labelKey: text.optional(),
      valueKey: text.optional(),
    }),
  },
  {
    name: "Callout",
    description: "A note that stands out",
    props: z.object({
      text,
      title: text.optional(),
      tone: z.enum(["tip", "note", "warning"]).optional(),
    }),
  },
  {
    name: "Chips",
    description: "Short things at a glance; flagKey marks some",
    props: z.object({
      items: z.array(z.any()),
      labelKey: text.optional(),
      flagKey: text.optional(),
      flag: text.optional(),
    }),
  },
  {
    name: "Steps",
    description: "Ordered work, numbered, with times",
    props: z.object({
      items: z.array(z.any()),
      textKey: text.optional(),
      minutesKey: text.optional(),
    }),
  },
  {
    name: "Tabs",
    description: "Two to four views of one answer",
    props: z.object({
      tabs: z.array(z.object({ label: text, child, count: z.number().optional() })),
    }),
  },
  {
    name: "Card",
    description: "One thing: a day, an offer, a person",
    props: z.object({
      title: value,
      children: children.optional(),
      eyebrow: value.optional(),
      subtitle: value.optional(),
      image: text.optional().describe("a file id"),
    }),
  },
  {
    name: "Fold",
    description: "Details that open on a tap",
    props: z.object({ title: text, children, open: z.boolean().optional() }),
  },
  {
    name: "Sources",
    description: "Where it was found, as small chips",
    props: z.object({
      items: z.array(z.object({ title: text, url: text.optional(), open: text.optional() })),
    }),
  },
  {
    name: "File",
    description: "A file of the space with its name; a PDF or picture shows itself",
    props: z.object({
      file: text.describe("a file id"),
      name: text,
      mime: text.optional(),
      preview: z.boolean().optional(),
    }),
  },
  {
    name: "Ref",
    description:
      'A thing of the space: open is what space_search gave as "open" ("p:…", "t:…", "f:…"), or "chat:<id>", "wizard:<id>"',
    props: z.object({
      title: text,
      open: text,
      subtitle: text.optional(),
      meta: text.optional(),
    }),
  },
  {
    name: "Actions",
    description: "Buttons side by side",
    props: z.object({ children }),
  },
  {
    name: "Button",
    description:
      'A button; its action is @ToAssistant("what the person says") to ask you, @Open(ref) to open a thing of the space, @OpenUrl(url)',
    props: z.object({ label: text, action: z.any().describe("an action") }),
  },
  {
    name: "Form",
    description:
      "Asks for answers: its Fields and a send button; the answers come back as the person's message",
    props: z.object({ children, submit: text, title: text.optional() }),
  },
  {
    name: "Field",
    description:
      "One answer of a Form; select and multiselect need options; value prefills what you know",
    props: z.object({
      name: text.describe("letters, digits and _"),
      kind: z.enum([
        "text",
        "textarea",
        "number",
        "select",
        "multiselect",
        "date",
        "email",
        "url",
        "toggle",
        "color",
      ]),
      label: text,
      required: z.boolean().optional(),
      options: z.array(text).optional(),
      value: z.any().optional(),
      placeholder: text.optional(),
    }),
  },
];

/** The words a value becomes: `as` writes a number in the person's language first. */
function written(raw: unknown, as?: string): unknown {
  if (typeof raw === "number" && (as === "number" || as === "percent")) {
    return new Intl.NumberFormat(viewLang(), as === "percent" ? { style: "percent" } : {}).format(
      raw,
    );
  }
  return raw;
}

export const CHAT_FUNCTIONS = [
  defineFunction({
    name: "Map",
    description: 'A value looked up in a table: @Map(true, {"true": "in stock", "false": "order"})',
    params: z.object({ value: z.any(), table: z.record(z.string(), z.any()) }),
    returns: z.any(),
    fn: ({ value: v, table }) => (Object.hasOwn(table, String(v)) ? table[String(v)] : v),
  }),
  defineFunction({
    name: "Format",
    description:
      'A value set into a text, {} is the value; as: "number" or "percent" writes it in the person\'s language: @Format(0.25, "{} done", "percent")',
    params: z.object({
      value: z.any(),
      template: z.string(),
      as: z.enum(["number", "percent"]).optional(),
    }),
    returns: z.string(),
    fn: ({ value: v, template, as }) => {
      const w = written(v, as);
      return w === undefined || w === null || w === ""
        ? ""
        : template.replace("{}", Array.isArray(w) ? w.join(", ") : String(w));
    },
  }),
];

export const CHAT_ACTIONS = [
  defineAction({
    name: "Open",
    description: "Opens a thing of the space (a Ref's open)",
    params: z.object({ ref: z.string() }),
  }),
];

/** The library without its drawing: for the prompt and the checks. */
export const chatLibrarySpec = createLibrary({
  components: CHAT_COMPONENTS.map((c) => defineComponent({ ...c, component: null })),
  functions: CHAT_FUNCTIONS,
  actions: CHAT_ACTIONS,
  root: "Column",
});

/** What a model reads to write a view: the language, the components, how a view is made. */
export function chatViewPrompt(preamble?: string): string {
  return chatLibrarySpec.prompt({
    preamble,
    additionalRules: [
      "Design it like an app, not a report: lead with a headline, the key figure or the chips; one Card per thing; ordered work is Steps. A Table only for figures people compare across columns.",
      "Keep it small: what the person needs to see first, then the details.",
      "Never invent numbers: write the figures you found.",
      "Pictures and files are the space's own, by file id; never an address on the web.",
      "Never ask for passwords, card numbers or other secrets in a Form.",
      "No Query, Mutation or $variables: a view shows what you write into it.",
    ],
    examples: [
      [
        "root = Column([title, figures, days, ask])",
        'title = Text("Next week", "h3")',
        "figures = Grid([open, done], 2)",
        'open = Metric("Open", 12)',
        'done = Metric("Done", @Format(0.4, "{}", "percent"))',
        "days = List([mon, tue])",
        'mon = Row("Monday", "Site visit", "9:00")',
        'tue = Row("Tuesday", "Offer due", "17:00", "today")',
        'ask = Button("Plan Wednesday", @ToAssistant("Plan Wednesday for me"))',
      ].join("\n"),
    ],
  });
}
