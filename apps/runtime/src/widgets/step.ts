import {
  allFields,
  dataRef,
  type WidgetStep,
  widgetSize,
} from "@engenty-wizards/shared/definition";
import { runTheme } from "@engenty-wizards/shared/projects";
import type { StepOutput } from "@engenty-wizards/shared/run";
import { note } from "@engenty-wizards/shared/run";
import type { WorkspaceFile } from "@engenty-wizards/shared/workspace";
import { resolveRef } from "../engine/template.js";
import { type ProjectRow, type StepContext, StepError } from "../engine/types.js";
import { extFor, inlineAssetRefs, loadAsset } from "../files/storage.js";
import { snapshotDataImages } from "../files/web-images.js";
import { type AiOrigin, markMedia } from "../media/marking.js";
import { mainLogoId } from "../services/brand.js";
import { snapshotFile } from "../services/files.js";
import { bundleWidget, type WidgetBrand } from "./bundle.js";
import { FILM_MEDIA_ORIGIN, type FilmMedia, probeWidget, renderFilm } from "./render.js";

export async function widgetBrand(project: ProjectRow): Promise<WidgetBrand> {
  const logoId = await mainLogoId(project.id);
  const logo = logoId ? await loadAsset(logoId) : null;
  const colors = project.brand.colors ?? [];
  return {
    name: project.brand.name ?? "",
    accent: colors[0]?.value ?? null,
    logo: logo ? `data:${logo.row.mime};base64,${logo.data.toString("base64")}` : null,
    colors,
    facts: Object.fromEntries(
      project.facts.filter((f) => f.value.trim()).map((f) => [f.key, f.value]),
    ),
    theme: runTheme(project.brand),
  };
}

/** A widget inlines media up to this size; a film gets its media from the renderer instead. */
const INLINE_LIMIT = 5_000_000;

const MEDIA_KINDS = { image: "image", video: "video", voice: "audio" } as const;

/**
 * The step's data map resolved against the run: raw values; uploads and the images, clips and
 * voice-over earlier steps made as URLs the page can show — data URLs, or for a film addresses
 * its renderer answers (kept in `media`).
 */
async function widgetData(step: WidgetStep, ctx: StepContext) {
  const out: Record<string, unknown> = {};
  const media = new Map<string, FilmMedia>();
  const fields = allFields(ctx.def);
  // Which of the run's media a model made or changed: what the widget shows of it makes the
  // widget's own result AI media too.
  const made = new Map(
    Object.values(ctx.state.outputs)
      .flatMap((o) => o.assets ?? [])
      .filter((a) => a.ai)
      .map((a) => [a.id, a.ai]),
  );
  const seen = { generated: 0, edited: 0, own: 0 };
  const urlOf = async (id: unknown): Promise<string | null> => {
    const found = typeof id === "string" && id ? await loadAsset(id) : null;
    if (!found || found.row.runId !== ctx.runId) {
      return null;
    }
    seen[made.get(found.row.id) ?? "own"]++;
    if (step.video) {
      const url = `${FILM_MEDIA_ORIGIN}/${found.row.id}.${extFor(found.row.mime)}`;
      media.set(url, { bytes: new Uint8Array(found.data), mime: found.row.mime });
      return url;
    }
    return found.data.byteLength < INLINE_LIMIT
      ? `data:${found.row.mime};base64,${found.data.toString("base64")}`
      : null;
  };
  for (const [key, raw] of Object.entries(step.data)) {
    const ref = dataRef(raw);
    const field = fields.find((f) => f.id === ref);
    if (field && (field.kind === "image" || field.kind === "file" || field.kind === "signature")) {
      const value = ctx.state.values[ref];
      out[key] = Array.isArray(value)
        ? (await Promise.all(value.map(urlOf))).filter(Boolean)
        : await urlOf(value);
      continue;
    }
    const kept = ref.match(/^steps\.([^.]+)\.assets$/);
    const keeper = kept && ctx.def.steps.find((s) => s.id === kept[1]);
    if (keeper && keeper.type === "agent") {
      // The pictures an agent step kept (screenshots, drawn or exported images), by asset id:
      // its JSON names them by id, the widget looks the URL up here.
      const assets = (ctx.state.outputs[keeper.id]?.assets ?? []).filter((a) => a.kind === "image");
      const urls: Record<string, string> = {};
      for (const a of assets) {
        const url = await urlOf(a.id);
        if (url) {
          urls[a.id] = url;
        }
      }
      out[key] = urls;
      continue;
    }
    const source = ctx.def.steps.find((s) => `steps.${s.id}` === ref);
    if (source?.type === "generate" && source.asset in MEDIA_KINDS) {
      const kind = MEDIA_KINDS[source.asset as keyof typeof MEDIA_KINDS];
      const assets = (ctx.state.outputs[source.id]?.assets ?? []).filter((a) => a.kind === kind);
      const urls = (await Promise.all(assets.map((a) => urlOf(a.id)))).filter(Boolean);
      out[key] = source.each ? urls : (urls[0] ?? null);
      continue;
    }
    out[key] = resolveRef(ref, ctx.scope) ?? null;
  }
  // Only generated media: a model made the film's pictures. Edited pictures, or AI media among
  // the person's own: the result is edited material.
  const origin: AiOrigin | undefined =
    seen.generated || seen.edited ? (seen.edited || seen.own ? "edited" : "generated") : undefined;
  return { data: out, media, origin };
}

/** A film: the widget's timeline rendered to an MP4 with sound — that video is the result. */
async function runFilmStep(
  step: WidgetStep,
  ctx: StepContext,
  html: string,
  data: Record<string, unknown>,
  media: Map<string, FilmMedia>,
  origin: AiOrigin | undefined,
): Promise<StepOutput> {
  await ctx.emit("info", { code: "filmCutting" });
  let told = 0;
  const film = await renderFilm(html, widgetSize(step), media, (done) => {
    if (done - told >= 0.25) {
      told = done;
      void ctx.emit("info", { code: "filmProgress", params: { pct: Math.round(done * 100) } });
    }
  });
  if (!film) {
    throw new StepError(note("filmNotRenderedNeeds"));
  }
  if (film.errors.length) {
    await ctx.emit("info", {
      code: "filmError",
      params: { detail: film.errors[0].slice(0, 200) },
    });
  }
  const assets = [
    await ctx.saveAsset({
      stepId: step.id,
      kind: "video",
      mime: "video/mp4",
      name: `${step.id}.mp4`,
      // Cutting re-encodes every frame, which drops what the clips and stills carried.
      data: origin ? markMedia(film.mp4, "video/mp4", { origin }) : film.mp4,
      ai: origin,
    }),
    await ctx.saveAsset({
      stepId: step.id,
      kind: "poster",
      mime: "image/png",
      name: `${step.id}.png`,
      data: origin ? markMedia(film.png, "image/png", { origin }) : film.png,
      ai: origin,
    }),
  ];
  return {
    json: data,
    assets,
    widget: { duration: film.duration, errors: film.errors },
    at: new Date().toISOString(),
  };
}

/** A widget step makes no model call: it binds this run's data into the widget and keeps the file. */
export async function runWidgetStep(step: WidgetStep, ctx: StepContext): Promise<StepOutput> {
  const { data: raw, media, origin } = await widgetData(step, ctx);
  // Photos the data points to on the web (a listing, a product) are kept with the run: the
  // page may load none itself.
  const data = await snapshotDataImages(raw, ctx.saveAsset, step.id, ctx.signal);
  const html = await bundleWidget({
    entry: step.entry,
    files: ctx.files,
    data,
    brand: await widgetBrand(ctx.project),
    media: step.video ? FILM_MEDIA_ORIGIN : undefined,
    ai: origin,
  });
  // What is shown and rendered carries those pictures inline; the kept page keeps the asset refs.
  const shown = await inlineAssetRefs(html);
  if (step.video) {
    return runFilmStep(step, ctx, shown, data, media, origin);
  }
  let probe: Awaited<ReturnType<typeof probeWidget>> | null = null;
  try {
    probe = await probeWidget(shown, widgetSize(step));
  } catch (err) {
    console.error(`[widget ${step.id}]`, err);
  }
  if (probe?.errors.length) {
    await ctx.emit("info", {
      code: "widgetError",
      params: { detail: probe.errors[0].slice(0, 200) },
    });
  }
  const assets = [
    await ctx.saveAsset({
      stepId: step.id,
      kind: "widget",
      mime: "text/html",
      name: `${step.id}.html`,
      data: html,
    }),
  ];
  if (probe) {
    assets.push(
      await ctx.saveAsset({
        stepId: step.id,
        kind: "poster",
        mime: "image/png",
        name: `${step.id}.png`,
        data: probe.png,
      }),
    );
  }
  return {
    json: data,
    assets,
    widget: { duration: probe?.duration ?? null, errors: probe?.errors ?? [] },
    at: new Date().toISOString(),
  };
}

/** The widget with its sample data (or none) — for the studio preview and the architect's check. */
export async function widgetPreviewHtml(
  step: WidgetStep,
  files: WorkspaceFile[],
  project: ProjectRow,
  data?: unknown,
): Promise<string> {
  let sample: unknown = data ?? {};
  if (data === undefined && step.sample) {
    const found = await snapshotFile(files, step.sample);
    if (found) {
      try {
        sample = JSON.parse(found.data.toString("utf8"));
      } catch {
        sample = {};
      }
    }
  }
  return bundleWidget({
    entry: step.entry,
    files,
    data: sample,
    brand: await widgetBrand(project),
  });
}
