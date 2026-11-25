import type { CatalogEntry, CatalogSearch } from "@engenty/search-index";
import { type Level, reaches } from "./levels.js";
import { callOf, type InputSchema, inputNames, inputText, inputWords, missing } from "./schema.js";

/** A tool as the harness knows it. The host's own tool stays beside it. Texts are English. */
export interface HarnessTool {
  name: string;
  description: string;
  input: InputSchema;
  /** More words it is found by: what people ask for when they mean it. */
  uses?: string;
  /** The least a model has to be. Without one: `basic`. */
  needs?: Level;
}

export interface HarnessOptions<T extends HarnessTool> {
  /** What the caller may use now. Only these are found, and only these run. */
  tools: T[];
  /** The few that are always in the prompt. */
  core: (tool: T) => boolean;
  /** What the model that answers can be trusted with. */
  level: Level;
  search: CatalogSearch;
  /** Below this many characters of schemas the rest stays in the prompt too. */
  foldFrom?: number;
}

/** A tool of the harness's own, for the prompt. */
export interface MetaTool {
  name: string;
  description: string;
  input: InputSchema;
}

export type Resolved<T> =
  | { ok: true; tool: T; input: Record<string, unknown> }
  /** `say`: what the model reads instead. */
  | { ok: false; say: string };

export interface ToolHarness<T extends HarnessTool> {
  /** The real tools in the prompt, by name: the same order keeps a provider's cache. */
  shown: T[];
  /** `tool_search` and `tool_call`; none where everything is in the prompt. */
  meta: MetaTool[];
  /** Embeds the rest ahead, so that the first search need not wait. */
  prepare(): Promise<void>;
  /** What `tool_search` answers. */
  find(query: string, options?: { signal?: AbortSignal }): Promise<string>;
  /**
   * The tools that may fit a message, for the newest message's context: a model that does not
   * think of searching still reads them. Empty where nothing is hidden or found by meaning.
   */
  hint(message: string, options?: { signal?: AbortSignal }): Promise<string>;
  /** What a `tool_call` runs, or what the model reads instead. */
  resolve(raw: unknown): Resolved<T>;
}

export const TOOL_SEARCH = "tool_search";
export const TOOL_CALL = "tool_call";

const FOLD_FROM = 6000;
/** Characters of a search's answer: several large ones and a model stops calling tools at all. */
const BUDGET = 6000;
const FOUND = 6;
const HINTED = 4;
const HINT_BUDGET = 3500;
/** Names a wrong call is answered with. */
const NEAR = 6;

const letters = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");
const byName = (a: HarnessTool, b: HarnessTool) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

const entryOf = <T extends HarnessTool>(tool: T): CatalogEntry & { tool: T } => ({
  id: tool.name,
  title: tool.name.replaceAll("_", " "),
  description: [tool.description, tool.uses].filter(Boolean).join(" "),
  details: inputWords(tool.input),
  tool,
});

/** The tools as a model reads them: in full while there is room, then their inputs' names. */
function listed(tools: HarnessTool[], budget: number): string {
  let left = budget;
  return tools
    .map((tool) => {
      const full = `- ${tool.name}: ${tool.description}\n  input: ${inputText(tool.input)}`;
      if (full.length <= left) {
        left -= full.length;
        return full;
      }
      const short = `- ${tool.name}: ${tool.description.split(/(?<=[.!?])\s/)[0] ?? ""}\n  input: ${inputNames(tool.input)} (search for "${tool.name}" to read them in full)`;
      left -= short.length;
      return short;
    })
    .join("\n");
}

export function createToolHarness<T extends HarnessTool>(
  options: HarnessOptions<T>,
): ToolHarness<T> {
  const { level, search } = options;
  const all = [...options.tools].sort(byName);
  const usable = all.filter((tool) => reaches(level, tool.needs ?? "basic"));
  const beyond = all.filter((tool) => !usable.includes(tool));
  const others = usable.filter((tool) => !options.core(tool));
  const size = others.reduce(
    (sum, tool) => sum + tool.description.length + JSON.stringify(tool.input).length,
    0,
  );
  const folded = size >= (options.foldFrom ?? FOLD_FROM);
  const rest = folded ? others : [];
  const shown = folded ? usable.filter(options.core) : usable;
  const known = new Map(all.map((tool) => [tool.name, tool]));
  // What is out of this model's reach is found too, to say so instead of saying it does not exist.
  const entries = [...rest, ...beyond].map(entryOf);
  const meta: MetaTool[] = entries.length
    ? [
        {
          name: TOOL_SEARCH,
          description: [
            "Find tools for what you need to do, with their input. Search before you say that something cannot be done. Write the query in English, as an action and its object: “set a repeating task”.",
            rest.length ? `Tools you can find: ${rest.map((tool) => tool.name).join(", ")}.` : "",
          ]
            .filter(Boolean)
            .join(" "),
          input: {
            type: "object",
            properties: { query: { type: "string", description: "What you need to do." } },
            required: ["query"],
          },
        },
        {
          name: TOOL_CALL,
          description:
            "Run a tool that tool_search found or that is named with the newest message, with exactly its input.",
          input: {
            type: "object",
            properties: {
              name: { type: "string", description: "The tool's name." },
              input: { type: "object", description: "Its input." },
            },
            required: ["name", "input"],
          },
        },
      ]
    : [];

  const outOfReach = (tools: HarnessTool[]) =>
    tools.length
      ? `Not for the model that answers now (it needs a more capable one; tell the person so, and that they can choose one): ${tools.map((tool) => tool.name).join(", ")}.`
      : "";

  return {
    shown,
    meta,
    async prepare() {
      await search.prepare(entries);
    },
    async find(query, { signal } = {}) {
      // A name, or several: they are read out, in full.
      const named = query
        .split(/[\s,]+/)
        .flatMap((word) => entries.filter((entry) => entry.id === word));
      const hits = named.length
        ? named
        : (await search.search(entries, query, { limit: FOUND, signal })).hits.map(
            (hit) => hit.entry,
          );
      const found = hits.map((entry) => entry.tool);
      if (!found.length) {
        return `Nothing fits “${query}”. Try other English words for the action and its object. If nothing fits then, say that you cannot do it. Do not pretend that you did.`;
      }
      const runnable = found.filter((tool) => !beyond.includes(tool));
      return [
        runnable.length
          ? `Found. Nothing has been done yet: run one with ${TOOL_CALL}.\n${listed(runnable, BUDGET)}`
          : "",
        outOfReach(found.filter((tool) => beyond.includes(tool))),
      ]
        .filter(Boolean)
        .join("\n");
    },
    async hint(message, { signal } = {}) {
      if (!entries.length) {
        return "";
      }
      const result = await search.search(entries, message, { limit: HINTED, signal });
      // Words alone miss half of what is asked for, and then name what does not fit.
      if (result.by === "words" && !result.judged) {
        return "";
      }
      const found = result.hits.map((hit) => hit.entry.tool);
      const runnable = found.filter((tool) => !beyond.includes(tool));
      if (!runnable.length) {
        return "";
      }
      return `Tools that may fit this message (run one with ${TOOL_CALL}; use none if none fits):\n${listed(runnable, HINT_BUDGET)}`;
    },
    resolve(raw) {
      const { name, input } = callOf(raw);
      const tool = known.get(name);
      if (!tool) {
        const want = letters(name);
        const near = all.filter((candidate) => {
          const has = letters(candidate.name);
          return (
            want.length > 2 &&
            (has.includes(want) || want.includes(has) || has.slice(0, 4) === want.slice(0, 4))
          );
        });
        return {
          ok: false,
          say: [
            `There is no tool “${name}”, and nothing was done.`,
            near.length
              ? `Named alike: ${near
                  .slice(0, NEAR)
                  .map((t) => t.name)
                  .join(", ")}.`
              : "",
            `Find one with ${TOOL_SEARCH}.`,
          ]
            .filter(Boolean)
            .join(" "),
        };
      }
      if (beyond.includes(tool)) {
        return { ok: false, say: `Nothing was done. ${outOfReach([tool])}` };
      }
      if (name === TOOL_CALL || name === TOOL_SEARCH) {
        return { ok: false, say: "Nothing was done. Call that tool directly." };
      }
      const open = missing(tool.input, input);
      if (open.length) {
        return {
          ok: false,
          say: `Nothing was done: ${name} needs ${open.join(", ")}. Its input: ${inputText(tool.input)}. If you do not know a value, ask the person. Do not make one up.`,
        };
      }
      return { ok: true, tool, input };
    },
  };
}
