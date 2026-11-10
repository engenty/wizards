import {
  allFields,
  classIdOf,
  dataRef,
  type GenerateStep,
  textClassOf,
} from "@engenty/wizards-shared/definition";
import type { AssetRef, StepOutput } from "@engenty/wizards-shared/run";
import { note as runNote } from "@engenty/wizards-shared/run";
import { mainLogo, runTheme } from "@engenty/wizards-shared/spaces";
import { generateText } from "ai";
import { extFor, loadAsset } from "../../files/storage.js";
import { snapshotHtmlImages } from "../../files/web-images.js";
import {
  type GeneratedMedia,
  generateImageMedia,
  generateSpeechMedia,
  generateVideoMedia,
  type MediaReference,
} from "../../media/generate.js";
import { type AiOrigin, markMedia } from "../../media/marking.js";
import { costOf, textModel } from "../../models.js";
import { prompt } from "../../prompts.js";
import { contentPolicy } from "../../safety.js";
import { spaceContextOf } from "../../tools/plugin.js";
import { skillsBlock, skillsOf } from "../../tools/skills.js";
import {
  assetSectionLine,
  logoSectionLine,
  renderTemplate,
  resolveRef,
  type TemplateScope,
} from "../template.js";
import { type StepContext, StepError } from "../types.js";
import { inParallel } from "./foreach.js";
import { answersBlock, brandBlock, groundRules, revisionBlock, today } from "./prompt.js";

// --- generate ----------------------------------------------------------------

/** The images a name stands for: an image field's uploads, or the images an earlier step made. */
function imagesOf(name: string, ctx: StepContext): string[] {
  const field = allFields(ctx.def).find((f) => f.id === name);
  if (field) {
    const value = ctx.state.values[name];
    return (Array.isArray(value) ? value : [value]).filter(
      (id): id is string => typeof id === "string" && id.length > 0,
    );
  }
  return (ctx.state.outputs[name]?.assets ?? [])
    .filter((a) => a.mime.startsWith("image/") && a.kind !== "poster")
    .map((a) => a.id);
}

async function loadReference(id: string | undefined, ctx: StepContext) {
  const found = id ? await loadAsset(id) : null;
  return found && found.row.runId === ctx.runId
    ? ({ bytes: new Uint8Array(found.data), mediaType: found.row.mime } satisfies MediaReference)
    : null;
}

/** One result a generate step makes: what its prompt reads as {{item}}, and the image it starts from. */
interface Entry {
  item: unknown;
  index: number;
  count: number;
  reference: string | undefined;
}

/** A step makes at most this many results; more entries are left out. */
const MAX_ENTRIES = 8;

/** The entries of a step with `foreach` — or the single one of a step without. */
function entriesOf(step: GenerateStep, ctx: StepContext): Entry[] {
  const references = step.referenceImage ? imagesOf(step.referenceImage, ctx) : [];
  if (!step.foreach) {
    return [{ item: null, index: 0, count: 1, reference: references[0] }];
  }
  const ref = dataRef(step.foreach);
  let items: { item: unknown; own?: string }[];
  if (ref.startsWith("steps.") && ref.split(".").length > 2) {
    const value = resolveRef(ref, ctx.scope);
    items = (Array.isArray(value) ? value : []).map((item) => ({ item }));
  } else {
    // Images: every entry is one of them, and starts from it unless another image is named.
    items = imagesOf(ref.replace(/^steps\./, ""), ctx).map((id) => ({ item: id, own: id }));
  }
  items = items.slice(0, MAX_ENTRIES);
  return items.map(({ item, own }, index) => ({
    item,
    index,
    count: items.length,
    reference:
      references.length > 1 ? (references[index] ?? references[0]) : (references[0] ?? own),
  }));
}

/** The document templates a document step can name; each is a `document.*` section. */
const DOCUMENT_TEMPLATES = new Set(["invoice", "offer", "briefing", "letter", "report", "free"]);

/** Images a document may place: earlier generated images, uploads, the space's logos and images. */
function placeableImages(step: GenerateStep, ctx: StepContext): { id: string; label: string }[] {
  const out: { id: string; label: string }[] = [];
  const index = ctx.def.steps.indexOf(step);
  for (const s of ctx.def.steps.slice(0, index)) {
    for (const a of ctx.state.outputs[s.id]?.assets ?? []) {
      if (a.mime.startsWith("image/")) {
        out.push({ id: a.id, label: s.title });
      }
    }
    if (s.type === "form") {
      for (const f of s.fields) {
        const v = ctx.state.values[f.id];
        if (f.kind === "signature" && typeof v === "string" && v) {
          out.push({
            id: v,
            label: `${f.label} (signature drawn by the person, dark ink on clear)`,
          });
        }
        if (f.kind !== "image") {
          continue;
        }
        const ids = (Array.isArray(v) ? v : [v]).filter(
          (id): id is string => typeof id === "string" && id.length > 0,
        );
        for (const [i, id] of ids.entries()) {
          const n = ids.length > 1 ? ` ${i + 1}/${ids.length}` : "";
          out.push({ id, label: `${f.label}${n} (uploaded by the person)` });
        }
      }
    }
  }
  const logos = ctx.spaceFiles.filter((f) => f.kind === "logo");
  const main = mainLogo(logos, ctx.scope.brand.logoSections);
  for (const f of logos) {
    const section = logoSectionLine(ctx.scope.brand.logoSections, f.id);
    out.push({
      id: f.id,
      label: [
        f === main ? "Company logo" : "Logo variant",
        section ? ` — section ${section}` : "",
        f.description ? `: ${f.description}` : "",
      ].join(""),
    });
  }
  for (const p of ctx.scope.brand.patterns ?? []) {
    const file = ctx.spaceFiles.find((f) => f.id === p.file);
    const section = ctx.scope.brand.colorSections?.find((s) => s.id === p.section);
    if (file) {
      out.push({
        id: file.id,
        label: `${p.tile ? "Pattern to tile" : "Background fill"}: ${p.name || file.name}${p.description ? ` – ${p.description}` : ""}${section ? ` (${section.title})` : ""}`,
      });
    }
  }
  for (const f of ctx.spaceFiles) {
    if (f.kind === "asset" && f.mime.startsWith("image/")) {
      const section = assetSectionLine(ctx.scope.brand.assetSections, f.id);
      out.push({
        id: f.id,
        label: `${f.description || f.name} (from the space's assets${section ? `, section ${section}` : ""})`,
      });
    }
  }
  return out;
}

async function writeHtml(
  step: GenerateStep,
  ctx: StepContext,
  kind: "document" | "dashboard",
): Promise<string> {
  const brief = renderTemplate(step.prompt, ctx.scope);
  const images = placeableImages(step, ctx);
  // The look comes from the space's brand, as on the run page; what it does not say, the runner's own.
  const theme = runTheme(ctx.scope.brand);
  const accent = theme.accent ?? "#e0531b";
  const look = [
    prompt("step", "look.type", {
      display: theme.display ? `"${theme.display}"` : "a characterful sans",
      body: theme.body ? `"${theme.body}"` : "a clean sans",
    }),
    prompt("step", "look.accent", { accent }),
    theme.second ? prompt("step", "look.second", { color: theme.second }) : "",
    theme.background ? prompt("step", "look.ground", { color: theme.background }) : "",
  ]
    .filter(Boolean)
    .join(", ");
  const template = step.options?.template ?? "free";
  const guide =
    kind === "dashboard"
      ? prompt("step", "html.dashboard", { look })
      : prompt("step", "html.document", {
          guide: DOCUMENT_TEMPLATES.has(template) ? prompt("step", `document.${template}`) : "",
          look,
        });
  const system = [
    groundRules(ctx),
    `Today is ${today(ctx)}.`,
    brandBlock(ctx),
    // The skills always on hold for what a step writes, a document too.
    skillsBlock(await skillsOf(ctx), { tools: false }),
    guide,
    // What plugins hold for the space's look: a UI library, say.
    ...(await spaceContextOf(ctx)).html,
    images.length
      ? prompt("step", "html.images", {
          images: images.map((i) => `- asset://${i.id} — ${i.label}`).join("\n"),
        })
      : "",
    prompt("step", "html.return"),
  ]
    .filter(Boolean)
    .join("\n\n");
  const request = [`# BRIEF\n${brief}`, answersBlock(ctx), await revisionBlock(ctx, step.id)]
    .filter(Boolean)
    .join("\n\n");
  const writer = await textModel(textClassOf(step.model ?? "standard"), {
    ...ctx.call,
    effort: step.effort,
    makerClass: step.maker ? classIdOf(step, "standard") : undefined,
  });
  const result = await generateText({
    model: writer.model,
    system,
    prompt: request,
    abortSignal: ctx.signal,
    maxOutputTokens: 32_000,
  });
  await ctx.chargeUsd(costOf(writer, result.usage));
  const html = result.text
    .replace(/^```(?:html)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  if (!/<html|<!doctype/i.test(html)) {
    throw new StepError(runNote("documentNotCreated"));
  }
  // On screen (preview, PNG) a print document needs the margin its @page rule gives it on paper.
  return kind === "document"
    ? html.replace(
        /<\/head>/i,
        "<style>@media screen{body{padding:48px 56px;background:#fff}}</style></head>",
      )
    : html;
}

/** For image/video: let a fast model turn the brief + answers into one strong visual prompt. */
async function visualPrompt(step: GenerateStep, ctx: StepContext, entry: Entry): Promise<string> {
  const scope: TemplateScope = { ...ctx.scope, entry };
  const brief = renderTemplate(step.prompt, scope);
  const note = ctx.state.notes[step.id];
  const prompter = await textModel("low", ctx.call);
  const from = entry.reference
    ? step.asset === "video"
      ? prompt("step", "visual.from_image")
      : prompt("step", "visual.reference")
    : "";
  const result = await generateText({
    model: prompter.model,
    abortSignal: ctx.signal,
    system: [
      [
        step.asset === "video" ? prompt("step", "visual.video") : prompt("step", "visual.image"),
        from,
      ]
        .filter(Boolean)
        .join(" "),
      contentPolicy(),
    ].join("\n\n"),
    prompt: [
      `Brief:\n${brief}`,
      step.options?.style ? `Style: ${step.options.style}` : "",
      note ? `Change requested by the person after seeing the last version: ${note}` : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
  });
  await ctx.chargeUsd(costOf(prompter, result.usage));
  return result.text.trim() || brief;
}

/** Images and video clips: one per entry. A revision can name the entries to make again. */
async function runMediaStep(
  step: GenerateStep,
  ctx: StepContext,
  asset: "image" | "video",
): Promise<StepOutput> {
  const entries = entriesOf(step, ctx);
  if (!entries.length) {
    throw new StepError(runNote("stepMissingSourcesImages"));
  }
  const previous = ctx.state.outputs[step.id];
  const before = previous?.assets?.filter((a) => a.kind === asset) ?? [];
  const beforeText = (previous?.text ?? "").split("\n\n");
  const redo = ctx.state.redo?.[step.id];
  // Only the named entries are made again — as long as the rest is still there to keep.
  const keep = (e: Entry) =>
    Boolean(redo?.length) && before.length === entries.length && !redo?.includes(e.index);
  const todo = entries.filter((e) => !keep(e));
  if (asset === "video") {
    await ctx.emit(
      "info",
      todo.length > 1
        ? { code: "clipsRendering", params: { count: todo.length } }
        : { code: "videoRendering" },
    );
  }
  let finished = 0;
  const note = ctx.state.notes[step.id];
  // The pictures the person gave: a result that starts from one of them is an edited picture.
  const given = new Set(
    allFields(ctx.def)
      .filter((f) => f.kind === "image" || f.kind === "file")
      .flatMap((f) => ctx.state.values[f.id])
      .filter((id): id is string => typeof id === "string"),
  );
  const made = await inParallel(todo, asset === "image" ? 4 : 3, async (entry) => {
    // An entry's brief was written for it by the step that made the table: it goes to the model
    // as it is. One brief for all, or a change the person asked for, is turned into a prompt first.
    const visual =
      step.foreach && !note
        ? [
            renderTemplate(step.prompt, { ...ctx.scope, entry }),
            step.options?.style ? `Style: ${step.options.style}` : "",
          ]
            .filter(Boolean)
            .join("\n")
        : await visualPrompt(step, ctx, entry);
    if (entry.reference && todo.length > 1) {
      await ctx.emit(
        "info",
        {
          code: asset === "image" ? "editing" : "filming",
          params: { n: entry.index + 1, total: entries.length },
        },
        entry.reference,
      );
    }
    const reference = await loadReference(entry.reference, ctx);
    const media: GeneratedMedia =
      asset === "image"
        ? await generateImageMedia({
            call: ctx.call,
            prompt: visual,
            aspectRatio: step.options?.aspectRatio,
            reference,
            abortSignal: ctx.signal,
          })
        : await generateVideoMedia({
            call: ctx.call,
            prompt: visual,
            aspectRatio: step.options?.aspectRatio,
            duration: step.options?.duration,
            reference,
            abortSignal: ctx.signal,
          });
    await ctx.chargeUsd(media.costUsd);
    const n = entries.length > 1 ? `-${entry.index + 1}` : "";
    // A picture changed from one the person gave is "edited"; everything else a model made.
    const origin: AiOrigin =
      asset === "image" && entry.reference && given.has(entry.reference) ? "edited" : "generated";
    const ref = await ctx.saveAsset({
      stepId: step.id,
      kind: asset,
      mime: media.mime,
      name: `${step.id}${n}.${extFor(media.mime)}`,
      data: markMedia(media.bytes, media.mime, { origin, system: media.system }),
      ai: origin,
    });
    finished++;
    if (todo.length > 1) {
      await ctx.emit(
        "info",
        { code: "batchDone", params: { done: finished, total: todo.length } },
        asset === "image" ? ref.id : undefined,
      );
    }
    return { index: entry.index, prompt: visual, ref };
  });
  const byIndex = new Map(made.map((m) => [m.index, m]));
  const assets: AssetRef[] = [];
  const prompts: string[] = [];
  for (const entry of entries) {
    const fresh = byIndex.get(entry.index);
    assets.push(fresh?.ref ?? before[entry.index]);
    prompts.push(fresh?.prompt ?? beforeText[entry.index] ?? "");
  }
  return { text: prompts.join("\n\n"), assets, at: new Date().toISOString() };
}

export async function runGenerateStep(step: GenerateStep, ctx: StepContext): Promise<StepOutput> {
  const at = new Date().toISOString();
  switch (step.asset) {
    case "image":
    case "video":
      return runMediaStep(step, ctx, step.asset);
    case "voice": {
      const text = renderTemplate(step.prompt, ctx.scope).trim().slice(0, 4000);
      if (!text) {
        throw new StepError(runNote("noTextReadAloud"));
      }
      const note = ctx.state.notes[step.id];
      const media = await generateSpeechMedia({
        call: ctx.call,
        text,
        // The style may name the person's answer: "{{voiceStyle}}, natural pace".
        style:
          [step.options?.style && renderTemplate(step.options.style, ctx.scope).trim(), note]
            .filter(Boolean)
            .join(". ") || undefined,
        abortSignal: ctx.signal,
      });
      await ctx.chargeUsd(media.costUsd);
      const ref = await ctx.saveAsset({
        stepId: step.id,
        kind: "audio",
        mime: media.mime,
        name: `${step.id}.${extFor(media.mime)}`,
        data: media.bytes,
        ai: "generated",
      });
      return { text, assets: [ref], at };
    }
    case "document":
    case "dashboard": {
      // Pictures the model took from the web stay: the page itself may load none.
      const html = await snapshotHtmlImages(
        await writeHtml(step, ctx, step.asset),
        ctx.saveAsset,
        step.id,
        ctx.signal,
      );
      const ref: AssetRef = await ctx.saveAsset({
        stepId: step.id,
        kind: "html",
        mime: "text/html",
        name: `${step.id}.html`,
        data: html,
      });
      return { assets: [ref], at };
    }
  }
}
