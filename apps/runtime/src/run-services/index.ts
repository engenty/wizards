import type { StepOutput } from "@engenty/wizards-shared/run";
import type {
  ModelsService,
  RunServices,
  TurnMessage,
  TurnPart,
  TurnRequest,
} from "@engenty/wizards-shared/run-services";
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
import { noticesFor, noticeWrites } from "../engine/notices.js";
import { runAgentStep } from "../engine/steps/agent.js";
import { runGenerateStep } from "../engine/steps/generate.js";
import type { RunRow, StepContext } from "../engine/types.js";
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
import { runMotionGraphicsStep } from "../motion-graphics/step.js";
import { runWidgetStep } from "../widgets/step.js";
import { contextService } from "./context.js";
import { dataService } from "./data.js";
import { filesService, type InProcessFiles } from "./files.js";
import { type InProcessTools, inProcessTools } from "./tools.js";

/**
 * The run's services inside the runtime (docs/plans/runs-on-their-own.md, "The run's services"):
 * each call is one of the functions step code calls today, with the run and its step context
 * filled in. Nothing here acts differently from those functions.
 *
 * `models.agentModel`, `tools.forStep` and `tools.ofAgent` are the calls beyond `RunServices`: an
 * agent step's loop still runs in Mastra's `Agent`, which takes the model and its tools itself,
 * until the engine keeps its own loop (phase 2).
 * `files` has calls beyond it too (./files.ts).
 */
export interface InProcessServices extends RunServices {
  files: InProcessFiles;
  models: ModelsService & {
    agentModel(
      request: Pick<TurnRequest, "stepId" | "class" | "effort" | "maker">,
    ): Promise<AgentModel>;
  };
  tools: InProcessTools;
}

/** The model of an agent step whose loop runs in Mastra's `Agent`, and what the step asks of it. */
export interface AgentModel {
  /** What the `Agent` takes. */
  model: MastraModelConfig;
  /** The class's model as resolved: the step's tools are built for it. */
  resolved: ResolvedModel<LanguageModel>;
  /** Its tool loop runs in a process of its own: an installed client, the run's device. */
  readonly ownLoop: boolean;
  /** It can call tools: an installed client that runs none cannot. */
  readonly takesTools: boolean;
  /** It takes pictures in a message: the installed clients and the large vendors' models. */
  readonly seesImages: boolean;
  /** Hands the step's tools to a model that runs them itself; `ignorable`: the device may answer alone. */
  attach(tools: Record<string, unknown>, ignorable: boolean): void;
  /** Books what one model step used. */
  charge(usage: unknown): Promise<void>;
  /** Books what an `Agent` call used over all its steps. */
  chargeTotal(result: object): Promise<void>;
}

/**
 * The services of one run. `ctx`: the step context they were made with, asked when a call needs
 * it; a call for another step works with the same context under that step's id.
 */
export function inProcessServices(run: RunRow, ctx: () => StepContext): InProcessServices {
  const at = (stepId: string): StepContext => {
    const c = ctx();
    return c.stepId === stepId ? c : { ...c, stepId, call: { ...c.call, stepId } };
  };
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
      return {
        model: agentModel(resolved),
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
      };
    },
  };

  return {
    models,
    tools: inProcessTools({
      definition: run.definition,
      at,
      agentModel: models.agentModel,
      runAgent: (step, c) => runAgentStep(step, c),
    }),

    context: contextService(run, at),

    files: filesService(run, ctx),

    data: dataService(run, ctx, at),

    steps: {
      run(step): Promise<StepOutput> {
        const c = at(step.id);
        switch (step.type) {
          case "generate":
            return runGenerateStep(step, c);
          case "widget":
            return runWidgetStep(step, c);
          case "motion-graphics":
            return runMotionGraphicsStep(step, c);
        }
      },
    },

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
