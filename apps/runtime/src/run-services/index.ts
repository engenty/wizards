import type {
  AgentModel as EngineAgentModel,
  StepContext,
  StepServices,
} from "@engenty/wizards-engine/types";
import type {
  ModelsService,
  TurnMessage,
  TurnPart,
  TurnRequest,
} from "@engenty/wizards-shared/run-services";
import { Agent } from "@mastra/core/agent";
import type { MastraModelConfig } from "@mastra/core/llm";
import {
  type AssistantModelMessage,
  embedMany,
  jsonSchema,
  type LanguageModel,
  type ModelMessage,
  Output,
  streamText,
  tool,
  type UserModelMessage,
} from "ai";
import { eq } from "drizzle-orm";
import { addLocalCost } from "../credits/credits.js";
import { db, schema } from "../db/client.js";
import { decide } from "../decide.js";
import { durableTurn } from "../engine/durable-turn.js";
import { noticesFor, noticeWrites } from "../engine/notices.js";
import type { RunRow } from "../engine/types.js";
import {
  agentModel,
  attachTools,
  costOf,
  embeddingModel,
  isHarnessVendor,
  keepsOwnLoop,
  type ResolvedModel,
  takesTools,
  textModel,
  totalUsage,
} from "../models.js";
import type { RunAgentStep } from "../tools/agent.js";
import { contextService } from "./context.js";
import { dataService } from "./data.js";
import { filesService, type InProcessFiles } from "./files.js";
import type { InProcessContext } from "./in-process.js";
import { type InProcessSteps, stepsService } from "./steps.js";
import { type InProcessTools, inProcessTools } from "./tools.js";

/**
 * The run's services inside the runtime (docs/plans/runs-on-their-own.md, "The run's services"):
 * each call is one of the functions step code calls today, with the run and its step context
 * filled in. Nothing here acts differently from those functions.
 *
 * They are the engine's `StepServices`: `models.agentModel`, `tools.forStep` and `tools.ofAgent`
 * are the calls beyond `RunServices`, since an agent step's loop still runs in Mastra's `Agent`,
 * which takes the model and its tools itself, until the engine keeps its own loop (package 2.4).
 * `files` has calls beyond them (./files.ts) for the runtime's own code; `steps` answers with the
 * output, never `pending`.
 */
export interface InProcessServices extends StepServices {
  files: InProcessFiles;
  models: ModelsService & {
    agentModel(
      request: Pick<TurnRequest, "stepId" | "class" | "effort" | "maker">,
    ): Promise<AgentModel>;
  };
  tools: InProcessTools;
  steps: InProcessSteps;
}

/**
 * The model of an agent step whose loop runs in Mastra's `Agent`, as the runtime has it: the
 * engine's, with what the `Agent` takes and what the step's tools are built for.
 */
export interface AgentModel extends EngineAgentModel {
  /** What the `Agent` takes. */
  model: MastraModelConfig;
  /** The class's model as resolved: the step's tools are built for it. */
  resolved: ResolvedModel<LanguageModel>;
}

/**
 * Runs an `Agent` as a stream, its text handed to `onText` as it comes. Returns what `generate`
 * would: the text, the steps and the usage.
 */
async function streamed(
  agent: Agent,
  message: unknown,
  options: { maxSteps: number; abortSignal: AbortSignal },
  onText: (delta: string) => Promise<void>,
): Promise<{ text: string; steps?: { text?: string }[]; usage?: unknown; totalUsage?: unknown }> {
  let written = "";
  const stream = await agent.stream(message as Parameters<Agent["stream"]>[0], options);
  for await (const chunk of stream.fullStream as AsyncIterable<any>) {
    const payload = chunk.payload ?? chunk;
    if (chunk.type === "text-delta") {
      const delta = payload.text ?? payload.delta ?? "";
      written += delta;
      await onText(delta);
    } else if (chunk.type === "error") {
      throw payload.error ?? new Error("step stream error");
    }
  }
  const s = stream as any;
  return {
    text: (await s.text) ?? written,
    steps: await s.steps,
    usage: await s.usage,
    totalUsage: await s.totalUsage,
  };
}

/**
 * The services of one run. `ctx`: the step context they were made with, asked when a call needs
 * it; a call for another step works with the same context under that step's id. `runAgent`: the
 * engine's agent step, for the tools that hand a task to one of the wizard's agents.
 */
export function inProcessServices(
  run: RunRow,
  ctx: () => InProcessContext,
  runAgent: RunAgentStep,
): InProcessServices {
  const at = (stepId: string): InProcessContext => {
    const c = ctx();
    return c.stepId === stepId ? c : { ...c, stepId, call: { ...c.call, stepId } };
  };
  // A step context the engine made of its own (a foreach entry's, a turn's, a wizard's agent's),
  // with this process's rows and functions. Its services are the ones the runtime gave it.
  const within = (c: StepContext): InProcessContext => ({
    ...ctx(),
    call: { ...ctx().call, stepId: c.stepId },
    ...c,
    services: c.services as InProcessServices,
  });
  const stepOf = (stepId: string) => run.definition.steps.find((s) => s.id === stepId) ?? null;
  const resolve = (r: Pick<TurnRequest, "stepId" | "class" | "effort" | "maker">) =>
    textModel(r.class, {
      ...ctx().call,
      stepId: r.stepId,
      effort: r.effort,
      makerClass: r.maker,
    });

  const models: InProcessServices["models"] = {
    async *turn(request, signal) {
      const resolved = await resolve(request);
      const out = streamText({
        model: resolved.model,
        system: request.system,
        messages: request.messages.map(modelMessage),
        tools: Object.fromEntries(
          (request.tools ?? [])
            .filter((d) => !d.provider)
            .map((d) => [
              d.name,
              tool({ description: d.description, inputSchema: jsonSchema(d.inputSchema) }),
            ]),
        ),
        ...(request.output
          ? { output: Output.object({ schema: jsonSchema(request.output) }) }
          : {}),
        ...(request.maxOutputTokens ? { maxOutputTokens: request.maxOutputTokens } : {}),
        abortSignal: signal,
      });
      for await (const part of out.fullStream) {
        if (part.type === "text-delta") {
          yield { type: "text", text: part.text };
        } else if (part.type === "reasoning-delta") {
          yield { type: "reasoning", text: part.text };
        } else if (part.type === "tool-call") {
          yield {
            type: "tool-call",
            toolCallId: part.toolCallId,
            name: part.toolName,
            input: part.input,
          };
        } else if (part.type === "error") {
          throw part.error;
        } else if (part.type === "finish") {
          // Whoever spends books: a model the runtime resolves itself costs the run here.
          const usd = costOf(resolved, part.totalUsage);
          if (usd > 0) {
            await addLocalCost(run.id, request.stepId, usd);
          }
          yield {
            type: "finish",
            reason: part.finishReason,
            usage: {
              inputTokens: part.totalUsage.inputTokens ?? 0,
              outputTokens: part.totalUsage.outputTokens ?? 0,
            },
            model: resolved.ref,
          } satisfies TurnPart;
        }
      }
    },
    decide: (request, signal) =>
      decide({
        state: request.state,
        questions: request.questions,
        call: { ...ctx().call, stepId: request.stepId },
        signal,
        deadlineMs: request.deadlineMs,
        charge: (usd) => addLocalCost(run.id, request.stepId, usd),
      }),
    async embed(values, signal) {
      const resolved = await embeddingModel();
      if (!resolved) {
        return null;
      }
      const { embeddings } = await embedMany({
        model: resolved.model,
        values,
        abortSignal: signal,
      });
      return { model: resolved.ref, vectors: embeddings.map((e) => Array.from(e)) };
    },
    async agentModel(request) {
      const resolved = await resolve(request);
      const charge = async (usage: unknown) => {
        const usd = costOf(resolved, usage);
        if (usd > 0) {
          await addLocalCost(run.id, request.stepId, usd);
        }
      };
      const model = agentModel(resolved);
      return {
        model,
        resolved,
        get ownLoop() {
          return keepsOwnLoop(resolved);
        },
        get takesTools() {
          return takesTools(resolved);
        },
        get seesImages() {
          return (
            isHarnessVendor(resolved.vendor) || /^(anthropic|openai|google)$/.test(resolved.vendor)
          );
        },
        attach: (tools, ignorable) => attachTools(resolved, tools, ignorable),
        charge,
        chargeTotal: async (result) => charge(await totalUsage(result)),
        generate: ({ id, name, instructions, tools, message, maxSteps, signal, onText }) => {
          const agent = new Agent({ id, name, instructions, model, tools: tools as any });
          return onText
            ? streamed(agent, message, { maxSteps, abortSignal: signal }, onText)
            : agent.generate(message as any, { maxSteps, abortSignal: signal });
        },
        durableTurn: (turn, c, input) => durableTurn(turn, c, { ...input, model }),
      };
    },
  };

  return {
    models,
    tools: inProcessTools({
      definition: run.definition,
      at,
      within,
      agentModel: models.agentModel,
      runAgent,
    }),

    context: contextService(run, at),

    files: filesService(run, ctx),

    data: dataService(run, ctx, at),

    steps: stepsService(at),

    people: {
      async tell(notice) {
        const rows = await noticesFor(run, notice.kind, {
          detail: notice.detail,
          waitKey: notice.waitKey,
          step: notice.stepId ? stepOf(notice.stepId) : null,
          ...(notice.dueAt ? { dueAt: new Date(notice.dueAt) } : {}),
        });
        if (rows.length) {
          await db.batch(noticeWrites(rows, eq(schema.run.id, run.id)) as never);
        }
      },
    },
  };
}

/** A message as the AI SDK takes it. */
function modelMessage(m: TurnMessage): ModelMessage {
  const parts =
    typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
  if (m.role === "tool") {
    return {
      role: "tool",
      content: parts.flatMap((p) =>
        p.type === "tool-result"
          ? [
              {
                type: "tool-result" as const,
                toolCallId: p.toolCallId,
                toolName: p.name,
                output: { type: "json" as const, value: p.output as never },
              },
            ]
          : [],
      ),
    };
  }
  if (m.role === "assistant") {
    return {
      role: "assistant",
      content: parts.flatMap((p): Exclude<AssistantModelMessage["content"], string> => {
        if (p.type === "text") {
          return [{ type: "text" as const, text: p.text }];
        }
        if (p.type === "tool-call") {
          return [
            {
              type: "tool-call" as const,
              toolCallId: p.toolCallId,
              toolName: p.name,
              input: p.input,
            },
          ];
        }
        return [];
      }),
    };
  }
  return {
    role: "user",
    content: parts.flatMap((p): Exclude<UserModelMessage["content"], string> => {
      if (p.type === "text") {
        return [{ type: "text" as const, text: p.text }];
      }
      if (p.type === "file") {
        return [
          {
            type: "file" as const,
            data: new URL(p.url),
            mediaType: p.mediaType,
            ...(p.name ? { filename: p.name } : {}),
          },
        ];
      }
      return [];
    }),
  };
}
