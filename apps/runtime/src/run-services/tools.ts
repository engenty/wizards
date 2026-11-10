import { turnOf } from "@engenty/wizards-engine/steps/turn";
import {
  type StepToolsOptions as EngineStepToolsOptions,
  type StepContext,
  StepError,
  type StepToolDescriptor,
  type StepToolSet,
} from "@engenty/wizards-engine/types";
import {
  type AgentStep,
  classIdOf,
  textClassOf,
  type WizardDefinition,
} from "@engenty/wizards-shared/definition";
import { type AssetRef, note, type StepOutput } from "@engenty/wizards-shared/run";
import {
  type JsonSchema,
  ServiceError,
  type ToolsService,
} from "@engenty/wizards-shared/run-services";
import { z } from "zod";
import { whereOf } from "../broker/call.js";
import { actOnce, effectIdOf, effectOn, hasOwnRows } from "../broker/effect.js";
import { prompt } from "../prompts.js";
import { logCalls, onlyReads, watchActions } from "../tools/acted.js";
import { agentTools, stepOfAgent } from "../tools/agent.js";
import { askOf, toolCallIdOf } from "../tools/code.js";
import { callConnection } from "../tools/connector.js";
import { buildStepTools } from "../tools/index.js";
import { callPluginTool } from "../tools/plugin.js";
import { personUploads } from "../tools/store.js";
import { whoWhere } from "../tools/wizard.js";
import type { InProcessContext } from "./in-process.js";
import type { AgentModel, InProcessServices } from "./index.js";

/** What the runtime builds an agent step's tools with: its model as the runtime has it. */
export interface StepToolsOptions extends EngineStepToolsOptions {
  model: AgentModel;
}

/** `ToolsService`, and the calls an agent step makes while its tools are built in the runtime. */
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
    const inTurn = turnContext(ctx, turn);
    const { tools, assets, instructions } = await buildStepTools(
      step,
      inTurn,
      model.resolved,
      uploads,
    );
    // The wizard's agents the step lists, each a tool that runs an agent step of its own.
    Object.assign(tools, await agentTools(step, ctx, options.runAgent));
    // A call that acts happens once in the turn: a repeat after a restart finds what it did.
    actOnceInTurn(tools, inTurn, turn, assets);
    // A call that may have done something is noted on the run: a retry would do it again.
    watchActions(tools, ctx.resources);
    // Each call is a line of the broker's log, where no other path writes one.
    await logCalls(tools, whoWhere(ctx));
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
          context ?? contextOf(request.effect, turn),
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
        // The step is at work: the engine wrote its turn on the run before it listed its tools.
        const turn = turnOf(c.state, stepId);
        if (!turn) {
          throw new ServiceError({ class: "final" }, `The step ${stepId} has no turn.`);
        }
        const model = await options.agentModel({
          stepId,
          class: textClassOf(step.model ?? "standard"),
          effort: step.effort,
          maker: step.maker ? classIdOf(step, "standard") : undefined,
        });
        return forStep(step, c, { model, uploads: await personUploads(c), turn: turn.id });
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
      // A tool step's one call: a plugin's tool or a connection's action, as the step names it.
      if (step?.type === "tool" && step.call) {
        const c = options.at(request.stepId);
        // A connection's action: the broker keeps its row under the same visit.
        if (!("tool" in step.call)) {
          return { output: await callConnection(step.call, request.input, c) };
        }
        const { tool } = step.call;
        const id = await effectOn(request.effect);
        if (!id) {
          // What a plugin's tool does nobody knows here, so a later try of the step does not repeat it.
          c.resources.acted = true;
          return { output: await callPluginTool(tool, request.input, c) };
        }
        // Once per visit: a later try finds what it answered, or that it may have happened.
        const called = await actOnce(
          { id, runId: c.runId, stepId: request.stepId, tool: `plugin:${tool}` },
          () => callPluginTool(tool, request.input, c),
          { ask: askOf(c), summary: step.title, service: c.def.title, input: request.input },
        );
        if ("unsure" in called) {
          throw new StepError(note("stepMayHaveHappened", { what: step.title }));
        }
        return { output: called.done };
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

/** Aborts when `signal` does, except for a deploy's stop (`abort("stop")` in `stopRunner`). */
function turnSignal(signal: AbortSignal): AbortSignal {
  const own = new AbortController();
  const pass = () => {
    if (signal.reason !== "stop") {
      own.abort(signal.reason);
    }
  };
  if (signal.aborted) {
    pass();
  } else {
    signal.addEventListener("abort", pass, { once: true });
  }
  return own.signal;
}

/**
 * What a turn's tools work with. A cancel reaches them. A deploy's stop does not: what a tool would
 * make of it (an error, a person's "no") would stay in the conversation for the next runner, which
 * goes on at that call as if nothing had stopped.
 */
function turnContext<C extends StepContext>(ctx: C, turn: string): C {
  return {
    ...ctx,
    turn,
    signal: turnSignal(ctx.signal),
    ask: async (ask) => {
      const answer = await ctx.ask(ask);
      // The wait ended because this process stops: nobody said no, the next runner asks again.
      if (ctx.signal.aborted && ctx.signal.reason === "stop") {
        await new Promise(() => undefined);
      }
      return answer;
    },
  };
}

/**
 * Each tool of the turn that acts runs once per call (broker/effect.ts): its row is written before
 * it acts, and a repeat after a restart answers with what it answered then and the files it made.
 * The id is the call's, `<turn>:<toolCallId>`, or for a program's call the one `toolCallIdOf`
 * gives. A read, and a tool whose acts keep rows of their own (`hasOwnRows`), go on as they are.
 */
function actOnceInTurn(
  tools: Record<string, unknown>,
  ctx: InProcessContext,
  turn: string,
  assets: AssetRef[],
) {
  for (const [name, tool] of Object.entries(tools)) {
    const t = tool as { execute?: (input: unknown, context?: unknown) => Promise<unknown> };
    const execute = t.execute;
    if (onlyReads(name) || hasOwnRows(tool) || typeof execute !== "function") {
      continue;
    }
    t.execute = async (input, context) => {
      const id = await effectIdOf(whereOf(ctx), {
        turn,
        toolCallId: toolCallIdOf(context as { agent?: { toolCallId?: string } }, name, input),
      });
      if (!id) {
        return execute.call(t, input, context);
      }
      const before = assets.length;
      const made = await actOnce(
        { id, runId: ctx.runId, stepId: ctx.stepId, tool: `tool:${name}` },
        async () => {
          const output = await execute.call(t, input, context);
          // The files it made go by reference, never their bytes.
          return { output, assets: assets.slice(before) };
        },
        { ask: askOf(ctx), summary: name, service: ctx.def.title, input },
      );
      if ("unsure" in made) {
        return { error: prompt("tools", "note.tool_may_have_happened", { tool: name }) };
      }
      // Found done: the step gets the files the call made then.
      for (const ref of made.done.assets) {
        if (!assets.some((a) => a.id === ref.id)) {
          assets.push(ref);
        }
      }
      return made.done.output;
    };
  }
}

/** What a tool reads of its call: the tool call id of the turn's call. */
function contextOf(effect: string | null, turn: string) {
  // An agent turn's call keeps its id: `<turn>:<toolCallId>` (broker/effect.ts).
  const toolCallId = effect?.startsWith(`${turn}:`) ? effect.slice(turn.length + 1) : undefined;
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
