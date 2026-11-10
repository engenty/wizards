import {
  type AgentStep,
  classIdOf,
  listWriteInputSchema,
  textClassOf,
  type WizardDefinition,
} from "@engenty/wizards-shared/definition";
import type { AssetRef, RunTurn, StepOutput } from "@engenty/wizards-shared/run";
import {
  type JsonSchema,
  ServiceError,
  type ToolCallRequest,
  type ToolDescriptor,
  type ToolResult,
  type ToolsService,
} from "@engenty/wizards-shared/run-services";
import { z } from "zod";
import { turnContext } from "../engine/durable-turn.js";
import type { StepContext } from "../engine/types.js";
import { onlyReads, watchActions } from "../tools/acted.js";
import { agentTools, stepOfAgent } from "../tools/agent.js";
import { callConnection } from "../tools/connector.js";
import { buildStepTools } from "../tools/index.js";
import { callPluginTool } from "../tools/plugin.js";
import { personUploads, type UploadRef, writeListOnce } from "../tools/store.js";
import type { InProcessContext } from "./in-process.js";
import type { AgentModel, InProcessServices } from "./index.js";

/** A tool of an agent step, as the step's model is told of it inside the runtime. */
export interface StepToolDescriptor extends ToolDescriptor {
  /**
   * The tool as Mastra's `Agent` takes it, without its code: its id, its schema as built, how its
   * result reaches the model; a provider's own tool whole. The step's model is told of each tool
   * as before, until the engine keeps its own loop (phase 2) and builds it from the descriptor.
   */
  mastra: Record<string, unknown>;
}

/** The tools of one agent step as it runs: built once, over the step's own context. */
export interface StepToolSet {
  list(): StepToolDescriptor[];
  /** `context`: what Mastra's loop hands the tool, passed on to it as it is. */
  call(request: Omit<ToolCallRequest, "stepId">, context?: unknown): Promise<ToolResult>;
  /** The array the tools add the files they make to (screenshots, images, exported files). */
  assets: AssetRef[];
  /** How to write a program over the tools, with the `code` tool. */
  instructions?: string;
  /** The run has a sandbox for a step that lists the sandbox tool. */
  readonly sandbox: boolean;
}

export interface StepToolsOptions {
  model: AgentModel;
  uploads: UploadRef[];
  /** The durable turn the step runs in: its tools work in the turn's context. */
  turn?: RunTurn;
}

/** `ToolsService`, and the calls an agent step makes while its loop runs in Mastra's `Agent`. */
export interface InProcessTools extends ToolsService {
  /**
   * The tools of an agent step: `ctx` is its own (a foreach entry's, a wizard's agent's), which a
   * step id alone does not name.
   */
  forStep(step: AgentStep, ctx: StepContext, options: StepToolsOptions): Promise<StepToolSet>;
  /** The step as the wizard's agent it names runs it: the agent's file gives model and tools. */
  ofAgent(
    step: AgentStep & { agent: string },
    ctx: StepContext,
  ): Promise<{ step: AgentStep; instructions: string }>;
}

/**
 * The run's tools inside the runtime: each step's tools are built as before (`buildStepTools`,
 * the wizard's agents) and stay here with their code; a step lists them and calls them by name.
 */
export function inProcessTools(options: {
  definition: WizardDefinition;
  /** The step context for a step id. */
  at(stepId: string): InProcessContext;
  /** A step context the engine made of its own, with this process's rows and functions. */
  within(ctx: StepContext): InProcessContext;
  agentModel: InProcessServices["models"]["agentModel"];
  /** Runs an agent step of the wizard's own agents, for the tools that hand a task to one. */
  runAgent(step: AgentStep, ctx: StepContext): Promise<StepOutput>;
}): InProcessTools {
  const stepOf = (stepId: string) => options.definition.steps.find((s) => s.id === stepId) ?? null;

  async function forStep(
    step: AgentStep,
    own: StepContext,
    { model, uploads, turn }: StepToolsOptions,
  ): Promise<StepToolSet> {
    const ctx = options.within(own);
    const { tools, assets, instructions } = await buildStepTools(
      step,
      turn ? turnContext(ctx, turn) : ctx,
      model.resolved,
      uploads,
    );
    // The wizard's agents the step lists, each a tool that runs an agent step of its own.
    Object.assign(tools, await agentTools(step, ctx, options.runAgent));
    // A call that may have done something is noted on the run: a retry would do it again.
    watchActions(tools, ctx.resources);
    const descriptors = Object.entries(tools).map(([name, t]) => describe(name, t));
    return {
      list: () => descriptors,
      async call(request, context) {
        const found = tools[request.name] as
          | { execute?: (input: unknown, context: unknown) => Promise<unknown> }
          | undefined;
        if (!found?.execute) {
          throw new ServiceError({ class: "final" }, `No tool ${request.name} in this step.`);
        }
        const output = await found.execute(
          request.input,
          context ?? contextOf(request.effect, turn?.id),
        );
        return { output };
      },
      assets,
      ...(instructions ? { instructions } : {}),
      get sandbox() {
        return ctx.resources.sandboxCapabilities() !== null;
      },
    };
  }

  // An agent step's tools, asked for by step id: built once per step as the step builds them.
  const built = new Map<string, Promise<StepToolSet | null>>();
  const setOf = (stepId: string): Promise<StepToolSet | null> => {
    let found = built.get(stepId);
    if (!found) {
      found = (async () => {
        const step = stepOf(stepId);
        if (step?.type !== "agent") {
          return null;
        }
        const c = options.at(stepId);
        const model = await options.agentModel({
          stepId,
          class: textClassOf(step.model ?? "standard"),
          effort: step.effort,
          maker: step.maker ? classIdOf(step, "standard") : undefined,
        });
        return forStep(step, c, { model, uploads: await personUploads(c) });
      })();
      built.set(stepId, found);
    }
    return found;
  };

  return {
    forStep,
    ofAgent: (step, ctx) => stepOfAgent(step, ctx),

    async list(stepId) {
      const set = await setOf(stepId);
      return set ? set.list().map(({ mastra: _, ...d }) => d) : [];
    },

    async call(request) {
      const step = stepOf(request.stepId);
      // A tool step's one call: a plugin's tool, list_write or a connection's action, as the step names it.
      if (step?.type === "tool" && step.call) {
        const c = options.at(request.stepId);
        if ("tool" in step.call && step.call.tool === "list_write") {
          // The wizard's own list, once per visit: the input is checked as the AI step's tool is.
          const input = listWriteInputSchema.safeParse(request.input);
          if (!input.success) {
            throw new ServiceError({ class: "final" }, `list_write: ${input.error.message}`);
          }
          return { output: await writeListOnce(c, input.data) };
        }
        if ("tool" in step.call) {
          // What a plugin's tool does nobody knows here, so a later try of the step does not repeat it.
          c.resources.acted = true;
          return { output: await callPluginTool(step.call.tool, request.input, c) };
        }
        return { output: await callConnection(step.call, request.input, c) };
      }
      const set = await setOf(request.stepId);
      if (!set) {
        throw new ServiceError({ class: "final" }, `No tool ${request.name} in this step.`);
      }
      const before = set.assets.length;
      const { output } = await set.call(request);
      const assets = set.assets.slice(before);
      return assets.length ? { output, assets } : { output };
    },
  };
}

/** What a tool reads of its call when no loop hands it one: the tool call id, in a turn. */
function contextOf(effect: string | null, turn: string | undefined) {
  // An agent turn's call keeps its id: `<turn>:<toolCallId>` (broker/effect.ts).
  const toolCallId =
    turn && effect?.startsWith(`${turn}:`) ? effect.slice(turn.length + 1) : undefined;
  return toolCallId ? { agent: { toolCallId } } : {};
}

/** A tool as the model is told of it: a provider's own tool has no schema of ours. */
function describe(name: string, t: unknown): StepToolDescriptor {
  const found = t as {
    type?: string;
    description?: string;
    inputSchema?: unknown;
    execute?: unknown;
  };
  if (found.type === "provider" || found.type === "provider-defined") {
    return {
      name,
      description: "",
      inputSchema: {},
      provider: true,
      onlyReads: onlyReads(name),
      mastra: found as Record<string, unknown>,
    };
  }
  const { execute: _, ...mastra } = found as Record<string, unknown>;
  return {
    name,
    description: found.description ?? "",
    get inputSchema() {
      return schemaOf(found.inputSchema);
    },
    onlyReads: onlyReads(name),
    mastra,
  };
}

function schemaOf(input: unknown): JsonSchema {
  if (!input) {
    return { type: "object", properties: {} };
  }
  if (input instanceof z.ZodType) {
    return z.toJSONSchema(input, { unrepresentable: "any", io: "input" }) as JsonSchema;
  }
  // The AI SDK's own schema (`jsonSchema(...)`) carries its JSON Schema.
  const own = (input as { jsonSchema?: unknown }).jsonSchema;
  return (own && typeof own === "object" ? own : { type: "object" }) as JsonSchema;
}
