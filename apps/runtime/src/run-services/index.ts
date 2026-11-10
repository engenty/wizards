import { runAgentStep } from "@engenty/wizards-engine/steps/index";
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
import {
  type AssistantModelMessage,
  embedMany,
  jsonSchema,
  type LanguageModel,
  type ModelMessage,
  Output,
  streamText,
  type ToolSet,
  tool,
  type UserModelMessage,
} from "ai";
import { eq } from "drizzle-orm";
import { addLocalCost } from "../credits/credits.js";
import { db, schema } from "../db/client.js";
import { decide } from "../decide.js";
import { noticesFor, noticeWrites } from "../engine/notices.js";
import type { RunRow } from "../engine/types.js";
import {
  attachTools,
  costOf,
  embeddingModel,
  isHarnessVendor,
  keepsOwnLoop,
  type ResolvedModel,
  takesTools,
  textModel,
} from "../models.js";
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
 * are the calls beyond `RunServices`: an agent step's tools are built here with their code, and a
 * model that runs its tools itself (an installed client, the run's device) has them attached.
 * `files` has calls beyond them (./files.ts) for the runtime's own code; `steps` answers a film or
 * a video with `pending` when `runServices` is on (./jobs.ts).
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

/** The model of an agent step as the runtime has it: the engine's, with what its tools are built for. */
export interface AgentModel extends EngineAgentModel {
  /** The class's model as resolved: the step's tools are built for it. */
  resolved: ResolvedModel<LanguageModel>;
}

/**
 * The services of one run. `ctx`: the step context they were made with, asked when a call needs
 * it; a call for another step works with the same context under that step's id.
 */
export function inProcessServices(run: RunRow, ctx: () => InProcessContext): InProcessServices {
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

  const files = filesService(run, ctx);
  /**
   * One model call with a resolved model. `provider`: the provider's own tools a step's model was
   * given (a web search), by name; the provider runs them within the call.
   */
  async function* turnWith(
    resolved: ResolvedModel<LanguageModel>,
    request: TurnRequest,
    signal: AbortSignal | undefined,
    provider: Record<string, unknown> = {},
  ): AsyncIterable<TurnPart> {
    const tools: ToolSet = {};
    for (const d of request.tools ?? []) {
      if (!d.provider) {
        tools[d.name] = tool({
          description: d.description,
          inputSchema: jsonSchema(d.inputSchema),
        });
      } else if (provider[d.name]) {
        tools[d.name] = provider[d.name] as ToolSet[string];
      }
    }
    const out = streamText({
      model: resolved.model,
      system: request.system,
      messages: await modelMessages(request.messages, async (id) => {
        const found = await files.read(id);
        return found?.data ?? null;
      }),
      tools,
      ...(request.output ? { output: Output.object({ schema: jsonSchema(request.output) }) } : {}),
      ...(request.maxOutputTokens ? { maxOutputTokens: request.maxOutputTokens } : {}),
      abortSignal: signal,
    });
    for await (const part of out.fullStream) {
      if (part.type === "text-delta") {
        yield { type: "text", text: part.text };
      } else if (part.type === "reasoning-delta") {
        yield { type: "reasoning", text: part.text };
      } else if (part.type === "tool-call" && !part.providerExecuted) {
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
  }

  const models: InProcessServices["models"] = {
    async *turn(request, signal) {
      yield* turnWith(await resolve(request), request, signal);
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
      const provider: Record<string, unknown> = {};
      return {
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
        attach: (tools, ignorable) => {
          for (const [name, t] of Object.entries(tools)) {
            const type = (t as { type?: string }).type;
            if (type === "provider" || type === "provider-defined") {
              provider[name] = t;
            }
          }
          attachTools(resolved, tools, ignorable);
        },
        turn: (turnRequest, signal) => turnWith(resolved, turnRequest, signal, provider),
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
      // The engine's agent step, for the tools that hand a task to one of the wizard's agents.
      runAgent: runAgentStep,
    }),

    context: contextService(run, at),

    files,

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

/**
 * The messages as the AI SDK takes them. A file part's `upload:<id>` is a file of the run:
 * `read` gives its bytes.
 */
async function modelMessages(
  messages: TurnMessage[],
  read: (id: string) => Promise<Uint8Array | null>,
): Promise<ModelMessage[]> {
  const bytes = new Map<string, Uint8Array | null>();
  for (const m of messages) {
    for (const p of typeof m.content === "string" ? [] : m.content) {
      if (p.type === "file" && p.url.startsWith("upload:") && !bytes.has(p.url)) {
        bytes.set(p.url, await read(p.url.slice("upload:".length)));
      }
    }
  }
  return messages.map((m) => modelMessage(m, bytes));
}

/** A message as the AI SDK takes it. */
function modelMessage(m: TurnMessage, bytes: Map<string, Uint8Array | null>): ModelMessage {
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
        const data = p.url.startsWith("upload:") ? bytes.get(p.url) : new URL(p.url);
        if (!data) {
          return [];
        }
        return [
          {
            type: "file" as const,
            data,
            mediaType: p.mediaType,
            ...(p.name ? { filename: p.name } : {}),
          },
        ];
      }
      return [];
    }),
  };
}
