import type { DecisionModel } from "@engenty/decision-model";
import {
  createCatalogSearch,
  defineEmbedder,
  memoryVectors,
  type SearchEmbedder,
} from "@engenty/search-index";
import {
  createToolHarness,
  type HarnessTool,
  type InputSchema,
  levelOf,
  TOOL_CALL,
  TOOL_SEARCH,
  throughHarness,
  toolJudge,
} from "@engenty/tool-harness";
import { createTool } from "@mastra/core/tools";
import { embedMany } from "ai";
import { z } from "zod";
import { decide } from "../engine/decide.js";
import { embeddingModel, keepsOwnLoop, type ResolvedModel, systemOneAccess } from "../models.js";
import { currentTenant } from "../tenants/tenant.js";
import { connectionTools } from "./connections.js";
import { assistantToolPlugin } from "./plugin.js";
import { attempt } from "./shared.js";

/**
 * The harness around a chat's tools (@engenty/tool-harness), as wizards.bot has it: Goose and the
 * space's AI. What every turn needs stays in the prompt; a space's connections and the plugins'
 * tools, one tool per action and many of them, are found by words and meaning and run with
 * `tool_call`. The tool that runs is the chat's own, with its gate and its record. An installed
 * client reads all tools over MCP and searches them itself.
 */

type AnyTool = {
  description?: string;
  inputSchema?: unknown;
  execute?: (input: unknown, context?: unknown) => Promise<unknown>;
};
type Held = HarnessTool & { tool: AnyTool };

/** Vectors of a model that says no length of its own: their first call tells it. */
const DIMENSIONS = 1;

async function embedder(): Promise<SearchEmbedder | null> {
  const resolved = await embeddingModel().catch(() => null);
  return resolved
    ? defineEmbedder(
        async (texts) =>
          (await embedMany({ model: resolved.model, values: texts })).embeddings.map((v) =>
            Array.from(v),
          ),
        { dimensions: DIMENSIONS, modelId: resolved.ref },
      )
    : null;
}

/** Jev, where the runtime reaches it: never the decision model of the local Ollama. */
async function decision(): Promise<DecisionModel | null> {
  const access = await systemOneAccess().catch(() => null);
  if (!access || access.local) {
    return null;
  }
  return {
    way: "runtime",
    model: access.model ?? "classifier",
    systemOne: async ({ state, questions }) => {
      const made = await decide({
        state,
        questions: questions as Parameters<typeof decide>[0]["questions"],
        deadlineMs: 3000,
        modelOnly: true,
      });
      return { model: access.model ?? "classifier", answers: made.answers as never };
    },
  };
}

/** Vectors by their model and text, in this process: the same action's are the same everywhere. */
const vectors = memoryVectors();
/** One search per tenant: it embeds on the tenant's own model. */
const searches = new Map<string, ReturnType<typeof createCatalogSearch>>();

function search() {
  const tenant = currentTenant();
  const known = searches.get(tenant);
  if (known) {
    return known;
  }
  const made = createCatalogSearch({ embedder, store: vectors, judge: toolJudge(decision) });
  searches.set(tenant, made);
  return made;
}

function inputOf(tool: AnyTool): InputSchema {
  try {
    return z.toJSONSchema(tool.inputSchema as z.ZodType, { unrepresentable: "any" }) as InputSchema;
  } catch {
    return {};
  }
}

/** A connection's action or a plugin's tool: there are many, and one chat uses few of them. */
export const oneOfMany = (tool: unknown): boolean =>
  typeof tool === "object" &&
  tool !== null &&
  (connectionTools.has(tool) || assistantToolPlugin.has(tool));

export interface Harnessed {
  /** What the model gets: the tools of every turn, and the harness's two. */
  tools: Record<string, any>;
  /** The tools that may fit a message, for its context; empty where none is hidden. */
  hint(message: string, signal?: AbortSignal): Promise<string>;
}

/** The tools of a turn behind the harness. `folds`: the ones that need not be in every prompt. */
export function harnessed(
  tools: Record<string, any>,
  resolved: ResolvedModel<unknown>,
  folds: (name: string, tool: AnyTool) => boolean,
): Harnessed {
  const held: Held[] = Object.entries(tools)
    // A provider's own tool (web search) is the model's: nothing here runs it.
    .filter(([, tool]) => typeof tool?.execute === "function")
    .map(([name, tool]) => ({
      name,
      description: String(tool.description ?? ""),
      input: inputOf(tool),
      tool,
    }));
  const harness = createToolHarness({
    tools: held,
    core: ({ name, tool }) => keepsOwnLoop(resolved) || !folds(name, tool),
    level: levelOf({ model: resolved.ref }),
    search: search(),
  });
  if (!harness.meta.length) {
    return { tools, hint: async () => "" };
  }
  const shown = new Set(harness.shown.map((tool) => tool.name));
  const about = (name: string) =>
    harness.meta.find((tool) => tool.name === name)?.description ?? "";
  return {
    tools: {
      ...Object.fromEntries(
        Object.entries(tools).filter(
          ([name, tool]) => shown.has(name) || typeof tool?.execute !== "function",
        ),
      ),
      [TOOL_SEARCH]: createTool({
        id: TOOL_SEARCH,
        description: about(TOOL_SEARCH),
        inputSchema: z.object({ query: z.string().describe("What you need to do.") }),
        execute: async ({ query }) => ({ found: await harness.find(query) }),
      }),
      [TOOL_CALL]: createTool({
        id: TOOL_CALL,
        description: about(TOOL_CALL),
        inputSchema: z.looseObject({
          name: z.string().describe("The tool's name."),
          input: z.record(z.string(), z.unknown()).optional().describe("Its input."),
        }),
        execute: (raw, context) =>
          attempt(async () => {
            const meant = harness.resolve(raw);
            if (!meant.ok) {
              return { error: meant.say };
            }
            const schema = meant.tool.tool.inputSchema as z.ZodType | undefined;
            const read = schema?.safeParse?.(meant.input);
            if (read && !read.success) {
              return { error: `Nothing was done. ${z.prettifyError(read.error)}` };
            }
            return meant.tool.tool.execute?.(read ? read.data : meant.input, context);
          }),
      }),
    },
    hint: (message, signal) => harness.hint(message, { signal }).catch(() => ""),
  };
}

/** A model whose direct calls of tools outside the prompt go through the harness. */
export const harnessedModel = <T>(resolved: ResolvedModel<T>): ResolvedModel<T> =>
  keepsOwnLoop(resolved) || typeof resolved.model !== "object" || !resolved.model
    ? resolved
    : { ...resolved, model: throughHarness(resolved.model as object) as T };
