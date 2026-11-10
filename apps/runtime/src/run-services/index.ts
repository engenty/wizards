import { textClassOf } from "@engenty/wizards-shared/definition";
import type { StepOutput } from "@engenty/wizards-shared/run";
import {
  type DataStatementRequest,
  type FileSave,
  type JsonSchema,
  type ModelsService,
  type RunServices,
  ServiceError,
  type ToolDescriptor,
  type TurnMessage,
  type TurnPart,
  type TurnRequest,
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
import { z } from "zod";
import { subjectsOf } from "../broker/rwx.js";
import { addLocalCost } from "../credits/credits.js";
import { db, schema } from "../db/client.js";
import { stepCaller } from "../elements/caller.js";
import { decide } from "../engine/decide.js";
import { noticesFor, noticeWrites } from "../engine/notices.js";
import { runGenerateStep } from "../engine/steps/generate.js";
import { type RunRow, type StepContext, StepError } from "../engine/types.js";
import { loadAsset, saveAsset } from "../files/storage.js";
import { agentModel, costOf, embeddingModel, type ResolvedModel, textModel } from "../models.js";
import { runMotionGraphicsStep } from "../motion-graphics/step.js";
import { signedUrl } from "../secrets/signing.js";
import { runData } from "../store/data-access.js";
import { listRows } from "../store/index.js";
import { buildStepTools, type StepTools } from "../tools/index.js";
import { assertPublicUrl, safeFetch } from "../tools/net-guard.js";
import { personUploads } from "../tools/store.js";
import { runWidgetStep } from "../widgets/step.js";
import { contextService } from "./context.js";

/**
 * The run's services inside the runtime (docs/plans/runs-on-their-own.md, "The run's services"):
 * each call is one of the functions step code calls today, with the run and its step context
 * filled in. Nothing here acts differently from those functions.
 *
 * `models.agentModel` is the one call beyond `RunServices`: an agent step's loop still runs in
 * Mastra's `Agent`, which takes the model itself, until the engine keeps its own loop (phase 2).
 */
export interface InProcessServices extends RunServices {
  models: ModelsService & {
    agentModel(
      request: Pick<TurnRequest, "stepId" | "class" | "effort" | "maker">,
    ): Promise<{ resolved: ResolvedModel<LanguageModel>; model: MastraModelConfig }>;
  };
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

  // An agent step's tools, built once per step as the step builds them.
  const built = new Map<string, Promise<StepTools>>();
  const toolsOf = (stepId: string): Promise<StepTools> => {
    let found = built.get(stepId);
    if (!found) {
      found = (async () => {
        const step = stepOf(stepId);
        if (step?.type !== "agent") {
          return { tools: {}, assets: [] };
        }
        const c = at(stepId);
        const resolved = await resolve({
          stepId,
          class: textClassOf(step.model ?? "standard"),
          effort: step.effort,
          maker: step.maker,
        });
        return buildStepTools(step, c, resolved, await personUploads(c));
      })();
      built.set(stepId, found);
    }
    return found;
  };

  return {
    models: {
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
        return { resolved, model: agentModel(resolved) };
      },
    },

    tools: {
      async list(stepId) {
        const { tools } = await toolsOf(stepId);
        return Object.entries(tools).map(([name, t]) => descriptorOf(name, t));
      },
      async call(request) {
        const stepTools = await toolsOf(request.stepId);
        const found = stepTools.tools[request.name] as
          | { execute?: (input: unknown, context: unknown) => Promise<unknown> }
          | undefined;
        if (!found?.execute) {
          throw new ServiceError({ class: "final" }, `No tool ${request.name} in this step.`);
        }
        // An agent turn's call keeps its id: `<turn>:<toolCallId>` (broker/effect.ts).
        const turn = ctx().turn;
        const toolCallId =
          turn && request.effect?.startsWith(`${turn}:`)
            ? request.effect.slice(turn.length + 1)
            : undefined;
        const before = stepTools.assets.length;
        const output = await found.execute(
          request.input,
          toolCallId ? { agent: { toolCallId } } : {},
        );
        const assets = stepTools.assets.slice(before);
        return assets.length ? { output, assets } : { output };
      },
    },

    context: contextService(run, at),

    files: {
      async read(ref) {
        const found = await loadAsset(ref);
        if (!found) {
          return null;
        }
        const { row, data } = found;
        return {
          ref: { id: row.id, kind: row.kind, mime: row.mime, name: row.name },
          data: new Uint8Array(data),
        };
      },
      async save(file) {
        const { mime, data } = "url" in file ? await fetched(file, ctx().signal) : file;
        return saveAsset({
          runId: run.id,
          stepId: file.stepId ?? ctx().stepId,
          kind: file.kind,
          mime,
          name: file.name,
          data,
          ...(file.ai ? { ai: file.ai } : {}),
        });
      },
      link: async (ref) => signedUrl(`/api/runs/${run.id}/assets/${ref}`),
    },

    data: {
      query: (request) => statement(at(request.stepId), request, "read"),
      exec: (request) => statement(at(request.stepId), request, "write"),
      async rows(listId) {
        const c = ctx();
        const def = run.definition.lists?.find((l) => l.id === listId);
        if (!def) {
          throw new ServiceError({ class: "final" }, `No list ${listId} in this wizard.`);
        }
        return { def, rows: await listRows(c.store, def, subjectsOf(c)) };
      },
      async counts() {
        const c = ctx();
        const who = subjectsOf(c);
        const counts: Record<string, number> = {};
        for (const def of run.definition.lists ?? []) {
          counts[def.id] = (await listRows(c.store, def, who)).length;
        }
        return counts;
      },
    },

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

/** A tool as the model is told of it: a provider's own tool has no schema of ours. */
function descriptorOf(name: string, t: unknown): ToolDescriptor {
  const found = t as { type?: string; description?: string; inputSchema?: unknown };
  if (found.type === "provider" || found.type === "provider-defined") {
    return { name, description: "", inputSchema: {}, provider: true };
  }
  return { name, description: found.description ?? "", inputSchema: schemaOf(found.inputSchema) };
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

/** One statement on the wizard's own database, as the data tools and the data step run it. */
function statement(c: StepContext, request: DataStatementRequest, mode: "read" | "write") {
  return runData(
    stepCaller(c),
    { def: c.def, files: c.files, store: c.store },
    {
      action: request.by === "wizard" ? "data_step" : mode === "read" ? "data_query" : "data_exec",
      by: request.by,
      scope: request.scope,
      sql: request.sql,
      params: request.params,
      mode,
    },
  );
}

/** A file saved by its address: fetched from the open web, never from this network. */
async function fetched(file: Extract<FileSave, { url: string }>, signal: AbortSignal) {
  const url = await assertPublicUrl(file.url);
  const res = await safeFetch(url.toString(), {
    signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
  });
  if (!res.ok) {
    throw new StepError(`${url.hostname} answered ${res.status}.`);
  }
  const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  return {
    mime: file.mime ?? (type || "application/octet-stream"),
    data: new Uint8Array(await res.arrayBuffer()),
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
