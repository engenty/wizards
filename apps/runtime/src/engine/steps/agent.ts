import {
  type AgentStep,
  allFields,
  classIdOf,
  type DataStep,
  stepShape,
  templateRefs,
  textClassOf,
} from "@engenty/wizards-shared/definition";
import type { StepOutput } from "@engenty/wizards-shared/run";
import { note as runNote } from "@engenty/wizards-shared/run";
import {
  fitData,
  labelOf,
  type ObjectShape,
  recordsOf,
  shapeJsonSchema,
  shapeLines,
  shapeZod,
  titleKey,
} from "@engenty/wizards-shared/shape";
import {
  type Surface,
  type SurfaceComponent,
  validateSurface,
} from "@engenty/wizards-shared/surface";
import { Agent } from "@mastra/core/agent";
import { generateText, type JSONSchema7, jsonSchema, Output, parsePartialJson } from "ai";
import type { z } from "zod";
import { loadAsset } from "../../files/storage.js";
import {
  agentModel,
  attachTools,
  costOf,
  isHarnessVendor,
  keepsOwnLoop,
  type ResolvedModel,
  takesTools,
  textModel,
  totalUsage,
} from "../../models.js";
import { prompt } from "../../prompts.js";
import { watchActions } from "../../tools/acted.js";
import { agentTools, stepOfAgent } from "../../tools/agent.js";
import { buildStepTools } from "../../tools/index.js";
import { personUploads, type UploadRef } from "../../tools/store.js";
import { durableTurn, turnContext, turnOf } from "../durable-turn.js";
import { renderTask } from "../template.js";
import { type StepContext, StepError } from "../types.js";
import { decideStep } from "./decision.js";
import { runAgentEach } from "./foreach.js";
import { answersBlock, brandBlock, groundRules, revisionBlock } from "./prompt.js";

// --- agent -------------------------------------------------------------------

/**
 * What the step returns: its schema, its fields as one, or else one table. The model's
 * structured output takes it as JSON Schema; its own JSON is checked against it.
 */
export function outputSchema(step: DataStep) {
  const shape = stepShape(step);
  return { schema: shapeZod(shape) as z.ZodType<Record<string, unknown>>, shape };
}

/**
 * What the agent wrote as JSON itself — its last fenced block, else its answer or the object in
 * it — fitted to the step's shape (a number where text belongs as text; in a short-form table a
 * list in a cell joined, a missing column empty) and checked against the schema. Null where none
 * fits; then a model structures the text.
 */
export function ownJson(
  text: string,
  schema: z.ZodType,
  shape: ObjectShape,
): Record<string, unknown> | null {
  const blocks = [...text.matchAll(/```(?:json)?[ \t]*\n([\s\S]*?)```/g)].map((m) => m[1]);
  const open = text.indexOf("{");
  const close = text.lastIndexOf("}");
  const tries = [
    ...blocks.reverse(),
    text.trim(),
    ...(open >= 0 && close > open ? [text.slice(open, close + 1)] : []),
  ];
  for (const candidate of tries) {
    let value: unknown;
    try {
      value = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const parsed = schema.safeParse(fitData(shape, value));
    if (parsed.success) {
      return parsed.data as Record<string, unknown>;
    }
  }
  return null;
}

/** At most this many entries a step reports while it writes; the rest come with the result. */
const MAX_FOUND = 40;

/**
 * Reports each entry of a top-level list once it is complete in the JSON the agent is writing:
 * "Rezepte: Shakshuka mit Feta". Fed with the text as it comes.
 */
function foundLines(step: AgentStep, ctx: StepContext) {
  const shape = outputSchema(step).shape;
  const reported = new Map<string, number>();
  let told = 0;
  let written = "";
  let checked = 0;
  const report = async () => {
    const start = written.lastIndexOf("```json");
    if (start < 0 || told >= MAX_FOUND) {
      return;
    }
    const body = written.slice(start + 7).replace(/```\s*$/, "");
    const { value } = await parsePartialJson(body);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return;
    }
    const keys = Object.keys(shape.fields);
    for (const [index, [key, field]] of Object.entries(shape.fields).entries()) {
      const list = (value as Record<string, unknown>)[key];
      if (field.kind !== "list" || !Array.isArray(list)) {
        continue;
      }
      // The last entry may still be half written – until a later part has begun.
      const later = keys.slice(index + 1).some((k) => k in (value as Record<string, unknown>));
      const done = later ? list.length : list.length - 1;
      for (let i = reported.get(key) ?? 0; i < done && told < MAX_FOUND; i++) {
        const entry = list[i];
        const name =
          field.of.kind === "object"
            ? String((entry as Record<string, unknown>)?.[titleKey(field.of) ?? ""] ?? "")
            : String(entry ?? "");
        if (name.trim()) {
          told += 1;
          await ctx.emit("info", {
            code: "found",
            params: { label: labelOf(key, field), name: name.trim().slice(0, 80) },
          });
        }
        reported.set(key, i + 1);
      }
    }
  };
  // A model that answers in one piece (a local client) has nothing to report while it writes:
  // its entries come with the result.
  let whole = false;
  return {
    written: () => written,
    text: async (delta: string) => {
      whole ||= delta.length > 2_000;
      written += delta;
      // Parsing the growing answer every few hundred characters is enough to keep up.
      if (!whole && written.length - checked > 300) {
        checked = written.length;
        await report();
      }
    },
  };
}

/** Runs a json step's agent as a stream, with `foundLines`. Returns what `generate` would: the text, the steps and the usage. */
async function streamWithProgress(
  agent: Agent,
  message: Parameters<Agent["stream"]>[0],
  options: { maxSteps: number; abortSignal: AbortSignal },
  step: AgentStep,
  ctx: StepContext,
): Promise<{ text: string; steps?: { text?: string }[]; usage?: unknown; totalUsage?: unknown }> {
  const found = foundLines(step, ctx);
  const stream = await agent.stream(message, options);
  for await (const chunk of stream.fullStream as AsyncIterable<any>) {
    const payload = chunk.payload ?? chunk;
    if (chunk.type === "text-delta") {
      await found.text(payload.text ?? payload.delta ?? "");
    } else if (chunk.type === "error") {
      throw payload.error ?? new Error("step stream error");
    }
  }
  const s = stream as any;
  return {
    text: (await s.text) ?? found.written(),
    steps: await s.steps,
    usage: await s.usage,
    totalUsage: await s.totalUsage,
  };
}

/** An agent step looks at this many photos itself; more are read one by one with read_document. */
const MAX_SEEN = 8;

/** Models that take pictures in a message: the installed clients and the large vendors' models. */
function seesImages(resolved: ResolvedModel<unknown>): boolean {
  return isHarnessVendor(resolved.vendor) || /^(anthropic|openai|google)$/.test(resolved.vendor);
}

/**
 * The photos the step's instructions name ({{imageField}}), handed to the model itself. Looking
 * at them directly is one model call; reading each with read_document is one more call per photo
 * and leaves the step with a description instead of the picture.
 */
async function seenPhotos(
  step: AgentStep,
  ctx: StepContext,
  resolved: ResolvedModel<unknown>,
  uploads: UploadRef[],
) {
  if (!seesImages(resolved)) {
    return [];
  }
  const named = new Set(templateRefs(step.instructions).map((ref) => ref.split(".")[0]));
  const ids = allFields(ctx.def)
    .filter((f) => f.kind === "image" && named.has(f.id))
    .flatMap((f) => {
      const value = ctx.state.values[f.id];
      return (Array.isArray(value) ? value : [value]).filter(
        (id): id is string => typeof id === "string" && id.length > 0,
      );
    })
    .slice(0, MAX_SEEN);
  const out: { upload: UploadRef; id: string; data: Uint8Array; mime: string }[] = [];
  for (const id of ids) {
    const upload = uploads.find((u) => u.ref === `upload:${id}`);
    const found = upload ? await loadAsset(id) : null;
    if (upload && found && /^image\/(jpeg|png|webp)$/.test(found.row.mime)) {
      out.push({ upload, id, data: new Uint8Array(found.data), mime: found.row.mime });
    }
  }
  return out;
}

/** The JSON array in a model's answer, fenced or not. */
function jsonArrayIn(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] ?? text;
  const start = fenced.indexOf("[");
  const end = fenced.lastIndexOf("]");
  if (start < 0 || end <= start) {
    return null;
  }
  try {
    return JSON.parse(fenced.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * The view an agent step composes of its result: the standard class writes components from the
 * surface catalog bound to the step's fields, the catalog's validator checks them, and one try
 * with the issues follows. Without a valid view the plain result shows: the step never fails
 * for its view.
 */
export async function composeSurface(
  step: AgentStep,
  json: Record<string, unknown>,
  ctx: StepContext,
): Promise<Surface | undefined> {
  const shape = outputSchema(step).shape;
  const fields = shapeLines(shape).join("\n");
  const sample = JSON.stringify(json).slice(0, 4000);
  try {
    const writer = await textModel("low", ctx.call);
    let issues: string[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await generateText({
        model: writer.model,
        abortSignal: ctx.signal,
        prompt: [
          prompt("step", "view.compose", { title: ctx.def.title }),
          prompt("authoring", "surfaces"),
          prompt("step", "view.data", { fields, sample }),
          issues.length
            ? `# YOUR LAST ANSWER HAD THESE PROBLEMS — fix them\n${issues.join("\n")}`
            : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      });
      await ctx.chargeUsd(costOf(writer, result.usage));
      const components = jsonArrayIn(result.text);
      issues = validateSurface(components, shape).map((i) => i.message);
      if (!issues.length) {
        return { components: components as SurfaceComponent[], data: json };
      }
    }
    console.warn(`[step ${step.id}] no valid view:`, issues.join("; "));
  } catch (err) {
    if (ctx.signal.aborted) {
      throw err;
    }
    console.warn(`[step ${step.id}] view not composed:`, (err as Error).message);
  }
  return undefined;
}

/**
 * An agent step; `decision`: a decision step, answered in one call where it has no uploads.
 * `agentPart`: the instructions of the wizard's agent that runs it (tools/agent.ts).
 */
export async function runAgentStep(
  step: AgentStep,
  ctx: StepContext,
  decision = false,
  agentPart?: string,
): Promise<StepOutput> {
  if (step.agent) {
    // An agent of the wizard runs the step: its file gives the model and the tools.
    const ran = await stepOfAgent({ ...step, agent: step.agent }, ctx);
    return runAgentStep(ran.step, ctx, decision, ran.instructions);
  }
  if (step.foreach) {
    return runAgentEach(step, ctx, agentPart);
  }
  const resolved = await textModel(textClassOf(step.model ?? "standard"), {
    ...ctx.call,
    effort: step.effort,
    makerClass: step.maker ? classIdOf(step, "standard") : undefined,
  });
  const uploads = await personUploads(ctx);
  // An installed client or the run's device keeps its tool loop in a process of its own: nothing
  // of it could go on elsewhere, so such a step runs as a step without `durable`.
  const going = turnOf(ctx.state, step.id);
  const turn = going && !keepsOwnLoop(resolved) ? going : undefined;
  const { tools, assets, instructions } = await buildStepTools(
    step,
    turn ? turnContext(ctx, turn) : ctx,
    resolved,
    uploads,
  );
  // The wizard's agents the step lists, each a tool that runs an agent step of its own.
  Object.assign(tools, await agentTools(step, ctx, (sub, c) => runAgentStep(sub, c)));
  // A step written for the sandbox on a run without one works on in text: said in the run's log.
  if (step.tools.includes("sandbox") && !ctx.resources.sandboxCapabilities()) {
    await ctx.emit("info", { code: "noSandbox" });
  }
  // A step without tools of its own and without uploads: the run's device may answer it alone.
  attachTools(resolved, tools, step.tools.length === 0 && uploads.length === 0);
  watchActions(
    tools,
    ctx.resources,
    turn &&
      (async () => {
        if (!turn.acted) {
          turn.acted = true;
          await ctx.saveState();
        }
      }),
  );
  const photos = await seenPhotos(step, ctx, resolved, uploads);
  const others = uploads.filter((u) => !photos.some((p) => p.upload === u));
  const formatHint =
    step.output.format === "markdown"
      ? prompt("step", "format.markdown")
      : step.output.format === "text"
        ? prompt("step", "format.text")
        : prompt("step", "format.json", {
            shape: shapeLines(outputSchema(step).shape).join("\n"),
          });
  const setting = await ctx.services.context.forStep(step.id, {
    tools: takesTools(resolved),
    sandbox: step.tools.includes("sandbox"),
  });
  const system = [
    groundRules(ctx),
    agentPart ? `# AGENT\n${agentPart}` : "",
    step.tools.includes("browser") ? prompt("step", "browser_rules") : "",
    instructions ?? "",
    `Today is ${setting.date}.`,
    brandBlock(setting.brand),
    // Knowledge: what the space holds for the run's holder and its wizard, and how to read it.
    setting.knowledge,
    // Skills: always on whole, on demand by name and description (docs/plans/skills.md).
    setting.skills,
    // What the space's plugins hold for its wizards: a wiki, questions and answers.
    ...setting.plugins.blocks,
    formatHint,
  ]
    .filter(Boolean)
    .join("\n\n");
  const request = [
    `# TASK\n${renderTask(step.instructions, ctx.scope)}`,
    answersBlock(ctx),
    photos.length
      ? prompt("step", "photos", {
          photos: photos
            .map((p, i) => `${i + 1}. ${p.upload.ref} — ${p.upload.name}, from "${p.upload.field}"`)
            .join("\n"),
        })
      : "",
    others.length
      ? prompt("step", "files", {
          files: others
            .map((u) => `- ${u.ref} — ${u.name} (${u.mime}), from "${u.field}"`)
            .join("\n"),
        })
      : "",
    await revisionBlock(ctx, step.id),
  ]
    .filter(Boolean)
    .join("\n\n");

  // A decision needs no agent: its questions go to the classifier class in one call.
  if (decision && uploads.length === 0) {
    return decideStep(step, request, ctx);
  }

  if (going && !turn) {
    await ctx.emit("info", { code: "noDurable" });
  }
  // Working through a mailbox or a row of portals takes many small tool calls.
  const maxSteps = step.tools.includes("browser") || step.connections?.length ? 60 : 20;
  for (const [i, photo] of photos.entries()) {
    await ctx.emit("info", { code: "photo", params: { n: i + 1, total: photos.length } }, photo.id);
  }
  const message = photos.length
    ? [
        {
          role: "user" as const,
          content: [
            { type: "text" as const, text: request },
            ...photos.map((p) => ({
              type: "file" as const,
              data: p.data,
              mediaType: p.mime,
              filename: p.upload.name,
            })),
          ],
        },
      ]
    : request;
  let result: { text?: string; steps?: unknown };
  if (turn) {
    const end = await durableTurn(turn, ctx, {
      instructions: system,
      model: agentModel(resolved),
      tools,
      assets,
      message,
      maxSteps,
      // Each model step is booked as it ends: a crash neither repeats nor loses the ones before it.
      onStepUsage: (usage) => ctx.chargeUsd(costOf(resolved, usage)),
      onText: step.output.format === "json" ? foundLines(step, ctx).text : undefined,
    });
    assets.splice(0, assets.length, ...end.assets);
    result = { text: end.text, steps: [{ text: end.closing }] };
  } else {
    const agent = new Agent({
      id: `step-${step.id}`,
      name: step.title,
      instructions: system,
      model: agentModel(resolved),
      tools,
    });
    // A json step streams, so the person sees its entries as they are written (`found`).
    result =
      step.output.format === "json"
        ? await streamWithProgress(agent, message, { maxSteps, abortSignal: ctx.signal }, step, ctx)
        : await agent.generate(message, { maxSteps, abortSignal: ctx.signal });
    await ctx.chargeUsd(costOf(resolved, await totalUsage(result)));
  }
  // `result.text` strings together what the model said between tool calls ("I open the page …").
  // A written result is its last message; structuring keeps everything, numbers may sit anywhere.
  const closing = String((result as any).steps?.at?.(-1)?.text ?? "").trim();
  const everything = (result.text ?? "").trim();
  const text = step.output.format === "json" ? everything : closing || everything;

  if (step.output.format !== "json") {
    if (!text && !assets.length) {
      throw new StepError(runNote("stepNotReturnResult"));
    }
    return { text, assets: assets.length ? assets : undefined, at: new Date().toISOString() };
  }

  const { schema, shape } = outputSchema(step);
  // The agent mostly writes the JSON itself; a second model only structures what does not fit.
  // Having it copy kilobytes of JSON again is slow and can fail on its own.
  let output = ownJson(text, schema, shape);
  if (!output) {
    const structurer = await textModel("classifier", ctx.call);
    const structured = await generateText({
      model: structurer.model,
      abortSignal: ctx.signal,
      // The JSON Schema built from the shape, strict: every key required, no other keys.
      output: Output.object({
        schema: jsonSchema<Record<string, unknown>>(shapeJsonSchema(shape) as JSONSchema7, {
          validate: (value) => {
            const parsed = schema.safeParse(value);
            return parsed.success
              ? { success: true, value: parsed.data }
              : { success: false, error: parsed.error };
          },
        }),
      }),
      prompt: prompt("step", "structure", { text }),
    });
    await ctx.chargeUsd(costOf(structurer, structured.usage));
    output = structured.output as Record<string, unknown>;
  }
  const json = recordsOf(shape, output) as Record<string, unknown>;
  // A view written once is bound to this run's data; `true` asks a model for one.
  const surface = Array.isArray(step.output.surface)
    ? { components: step.output.surface, data: json }
    : step.output.surface
      ? await composeSurface(step, json, ctx)
      : undefined;
  return {
    text,
    json,
    ...(surface ? { surface } : {}),
    assets: assets.length ? assets : undefined,
    at: new Date().toISOString(),
  };
}
