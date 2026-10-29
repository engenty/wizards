import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { dataRef, MOTION_SIZES, type MotionGraphicsStep } from "@engenty/wizards-shared/definition";
import { gradientCss, ruleLines, textStyleLine } from "@engenty/wizards-shared/spaces";
import { unzipSync } from "fflate";
import { logoSectionLine, renderTemplate, resolveRef } from "../engine/template.js";
import type { StepContext } from "../engine/types.js";
import { env } from "../env.js";
import { getBlob } from "../files/blobs.js";
import { extFor, loadAsset } from "../files/storage.js";
import { prompt } from "../prompts.js";
import { contentPolicy } from "../safety.js";
import { spaceFileContent } from "../services/space-files.js";
import { placeSkills } from "./skills.js";
import { soundCatalog } from "./sounds.js";
import { runHyperframes } from "./tools.js";

/**
 * The folder a video is made in: one per run and step, kept after the run so a later change edits
 * the code instead of starting over. Laid out for the client:
 *
 *   BRIEF.md            what to make (the step's brief, the format, the length)
 *   CLAUDE.md, AGENTS.md the rules of the folder
 *   .claude/skills/     the skill packages
 *   showcase/           the wizard's style kit, the bar to reach
 *   brand/              the space's brand: brand.json, logos
 *   input/              what this run made before: voice lines, pictures, texts, uploads
 *   audio-catalog/      the only sounds the video may use
 *   video/               the HyperFrames project; renders/video.mp4 is the result
 */
export function motionRoot(runId: string, stepId: string): string {
  return join(env.dataDir, "motion-graphics", runId, stepId);
}

const SESSION = join(".engenty", "session");

export async function savedSession(root: string): Promise<string | null> {
  try {
    return (await readFile(join(root, SESSION), "utf8")).trim() || null;
  } catch {
    return null;
  }
}

export async function saveSession(root: string, id: string) {
  await mkdir(join(root, ".engenty"), { recursive: true });
  await writeFile(join(root, SESSION), id);
}

/** Writes bytes to a path inside `root`; a name that would leave it is refused. */
async function put(root: string, rel: string, data: Uint8Array | string) {
  const path = normalize(join(root, rel));
  if (!path.startsWith(`${root}/`)) {
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
}

const safeName = (name: string) =>
  name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "file";

/** Where the client starts, by how video/ began. */
function startRules(start: MotionStart): string {
  return prompt("step", `motion.start.${start}`);
}

function rules(step: MotionGraphicsStep, skills: string[], start: MotionStart): string {
  const size = MOTION_SIZES[step.format];
  return `${prompt("step", "motion.rules", {
    start: startRules(start),
    skills: skills.join(", "),
    width: size.width,
    height: size.height,
  })}\n\n${contentPolicy()}\n`;
}

const BRAND_STAMP = join(".engenty", "brand");

/**
 * Writes the space's brand into brand/ as it is now (brand.json, logos). True when it differs
 * from what the folder had before — the video's code then still carries the old one.
 */
async function writeBrand(
  root: string,
  ctx: StepContext,
): Promise<{ changed: boolean; stamp: string }> {
  const b = ctx.scope.brand;
  const hash = createHash("sha256");
  const files: { name: string; data: Uint8Array }[] = [];
  const fileName = (dir: string, f: { name: string; mime: string }) =>
    `${dir}/${safeName(f.name.replace(/\.[^.]+$/, ""))}.${extFor(f.mime) === "bin" ? (f.name.split(".").pop() ?? "bin") : extFor(f.mime)}`;
  const patterns: { file: string; name: string; description?: string; tile: boolean }[] = [];
  for (const p of b.patterns ?? []) {
    const f = ctx.spaceFiles.find((x) => x.id === p.file);
    try {
      if (f) {
        const { data } = await spaceFileContent(f.spaceId, f.id);
        const name = fileName("patterns", f);
        files.push({ name, data });
        hash.update(name).update(data);
        patterns.push({
          file: name,
          name: p.name,
          ...(p.description ? { description: p.description } : {}),
          tile: Boolean(p.tile),
        });
      }
    } catch {
      // a pattern less
    }
  }
  const logos: { file: string; section?: string; description?: string }[] = [];
  for (const f of ctx.spaceFiles.filter((p) => p.kind === "logo")) {
    try {
      const { data } = await spaceFileContent(f.spaceId, f.id);
      const name = fileName("logos", f);
      files.push({ name, data });
      hash.update(name).update(data);
      const section = logoSectionLine(b.logoSections, f.id);
      logos.push({
        file: name,
        ...(section ? { section } : {}),
        ...(f.description ? { description: f.description } : {}),
      });
    } catch {
      // a logo less
    }
  }
  const json = JSON.stringify(
    {
      note: prompt("step", "motion.brand_note"),
      name: b.name ?? "",
      about: b.about ?? "",
      colors: (b.colors ?? []).map((c) => {
        const s = b.colorSections?.find((x) => x.id === c.section);
        return { name: c.name, value: c.value, ...(s ? { section: s.title } : {}) };
      }),
      ...(b.gradients?.length
        ? {
            gradients: b.gradients.map((g) => ({
              name: g.name,
              ...(g.description ? { description: g.description } : {}),
              section: b.colorSections?.find((x) => x.id === g.section)?.title,
              css: gradientCss(g),
            })),
          }
        : {}),
      ...(patterns.length ? { patterns } : {}),
      logos,
      ...(b.colorRules?.length ? { colorRules: ruleLines(b.colorRules).split("\n") } : {}),
      ...(b.fonts?.length
        ? {
            fonts: b.fonts.map(({ family, role, weights, license, uses }) => ({
              family,
              role,
              weights,
              ...(license ? { license } : {}),
              ...(uses?.length ? { uses } : {}),
            })),
          }
        : {}),
      ...(b.textStyles?.length
        ? {
            textStyles: b.textStyles.map((t) => ({
              name: t.name,
              style: textStyleLine(t, b.fonts ?? []),
            })),
          }
        : {}),
      ...(b.typeRules?.length ? { typeRules: ruleLines(b.typeRules).split("\n") } : {}),
      ...(b.logoRules?.length ? { logoRules: ruleLines(b.logoRules).split("\n") } : {}),
      facts: (b.facts ?? []).map((f) => `${f.label}: ${f.value}`),
    },
    null,
    1,
  );
  const stamp = hash.update(json).digest("hex");
  let changed = false;
  try {
    changed = (await readFile(join(root, BRAND_STAMP), "utf8")) !== stamp;
  } catch {
    // A folder from before the stamp: its brand.json tells; a new folder has none.
    const old = await readFile(join(root, "brand", "brand.json"), "utf8").catch(() => null);
    changed = old !== null && old !== json;
  }
  await rm(join(root, "brand"), { recursive: true, force: true });
  for (const f of files) {
    await put(join(root, "brand"), f.name, f.data);
  }
  await put(join(root, "brand"), "brand.json", json);
  await put(root, BRAND_STAMP, stamp);
  return { changed, stamp };
}

/** How the video/ project began: from the kit's base, from an earlier motion-graphics step, or empty. */
export type MotionStart = "base" | "from" | "init";

const START = join(".engenty", "start");
const BASE = join(".engenty", "base");

/**
 * The brand base: what a video made once from the space's brand for the kit's base (the base's
 * BRAND.md says what — theme.json at least), kept per space for the kit and the brand as they are.
 * A changed brand or kit is another key, so it is made again.
 */
function brandBaseDir(ctx: StepContext, kitHash: string, brandStamp: string): string {
  const key = createHash("sha256").update(`${kitHash}:${brandStamp}`).digest("hex").slice(0, 24);
  return join(env.dataDir, "brand-bases", ctx.space.id, key);
}

/** What in video/brand/ is the brand base: everything but the brand itself. */
const isBrandItself = (name: string) =>
  name === "brand.json" || name === "logos" || name === "patterns";

/**
 * Brings the brand into a space that started from a base: brand.json and the logos as they are
 * now, and the brand base kept for them when there is one. A base that no longer fits the brand
 * is removed — the video makes it again, as BRAND.md says.
 */
async function brandIntoMotion(root: string, brandChanged: boolean) {
  const base = await readFile(join(root, BASE), "utf8").catch(() => "");
  if (!base) {
    return;
  }
  const target = join(root, "video", "brand");
  await mkdir(target, { recursive: true });
  for (const name of await readdir(target)) {
    if (isBrandItself(name) || (brandChanged && !existsSync(base))) {
      await rm(join(target, name), { recursive: true, force: true });
    }
  }
  await cp(join(root, "brand"), target, { recursive: true });
  if (existsSync(base) && (brandChanged || !existsSync(join(target, "theme.json")))) {
    await cp(base, target, { recursive: true });
  }
}

/** A new brand is another brand base: the marker points at the one for the brand as it is now. */
async function refreshBrandBase(root: string, ctx: StepContext, step: MotionGraphicsStep) {
  if (!existsSync(join(root, BASE))) {
    return;
  }
  const kitHash = ctx.files.find((f) => f.path === step.kit)?.hash ?? "";
  const stamp = await readFile(join(root, BRAND_STAMP), "utf8");
  await put(root, BASE, brandBaseDir(ctx, kitHash, stamp));
}

/** After a video: keeps what it made from the brand for the next videos in this space. */
export async function keepBrandBase(root: string) {
  const base = await readFile(join(root, BASE), "utf8").catch(() => "");
  const source = join(root, "video", "brand");
  if (!base || !existsSync(join(source, "theme.json"))) {
    return;
  }
  await rm(base, { recursive: true, force: true });
  await mkdir(base, { recursive: true });
  for (const name of await readdir(source)) {
    if (!isBrandItself(name)) {
      await cp(join(source, name), join(base, name), { recursive: true });
    }
  }
}

/** Sets up the folder for a first attempt; a later attempt finds it as it was left. */
export async function prepareMotionFolder(
  step: MotionGraphicsStep,
  ctx: StepContext,
): Promise<{ root: string; brief: string; brandChanged: boolean; start: MotionStart }> {
  const root = motionRoot(ctx.runId, step.id);
  const brief = renderTemplate(step.brief, ctx.scope).trim();
  // An earlier video to start from, when it ran.
  const fromId = step.from ? dataRef(step.from).replace(/^steps\./, "") : null;
  const fromDir = fromId ? join(motionRoot(ctx.runId, fromId), "video") : null;
  const from = fromId && fromDir && existsSync(join(fromDir, "index.html")) ? fromId : null;
  // The same brief and material as last time: the video is there to go on with or to change.
  const stamp = createHash("sha256")
    .update(
      JSON.stringify([
        brief,
        Object.values(step.inputs).map((raw) => {
          const ref = dataRef(raw);
          const [head, id] = ref.split(".");
          return head === "steps" ? ctx.state.outputs[id]?.at : ctx.state.values[ref];
        }),
        from ? ctx.state.outputs[from]?.at : null,
      ]),
    )
    .digest("hex");
  const stampFile = join(root, ".engenty", "inputs");
  const same = existsSync(stampFile) && (await readFile(stampFile, "utf8")) === stamp;
  if (same && existsSync(join(root, "video", "index.html")) && (await savedSession(root))) {
    // The brand is the space's as it is now, also for a change: colours or a logo may be new.
    const { changed } = await writeBrand(root, ctx);
    const start = ((await readFile(join(root, START), "utf8").catch(() => "")) ||
      "init") as MotionStart;
    if (changed) {
      await refreshBrandBase(root, ctx, step);
    }
    await brandIntoMotion(root, changed);
    return { root, brief, brandChanged: changed, start };
  }
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });

  const skills = await placeSkills(step.skills, ctx.files, join(root, ".claude", "skills"));
  const size = MOTION_SIZES[step.format];

  const spec = [
    step.format,
    `${size.width}×${size.height}`,
    step.seconds ? `about ${step.seconds} s` : "",
  ]
    .filter(Boolean)
    .join(", ");
  await put(
    root,
    "BRIEF.md",
    `# Brief\n\nFormat ${spec}. ${prompt("step", "motion.brief")}\n\n${brief}\n`,
  );

  // The style kit: the showcase to look at, and the base a video starts from when it has one.
  const kitFile = step.kit ? ctx.files.find((f) => f.path === step.kit) : undefined;
  const base: Record<string, Uint8Array> = {};
  if (kitFile) {
    const entries = unzipSync(new Uint8Array(await getBlob(kitFile.hash)));
    for (const [name, data] of Object.entries(entries)) {
      if (name.endsWith("/")) {
        continue;
      }
      if (name.startsWith("base/")) {
        base[name.slice("base/".length)] = data;
      } else {
        await put(join(root, "showcase"), name.replace(/^showcase\//, ""), data);
      }
    }
  }

  const { stamp: brandStamp } = await writeBrand(root, ctx);

  // What the run made before.
  const listed: string[] = [];
  for (const [name, raw] of Object.entries(step.inputs)) {
    const ref = dataRef(raw);
    const [head, id] = ref.split(".");
    const output = head === "steps" ? ctx.state.outputs[id] : undefined;
    const assetIds =
      head === "steps"
        ? (output?.assets ?? []).map((a) => a.id)
        : ([ctx.state.values[ref]].flat().filter((v) => typeof v === "string") as string[]);
    let n = 0;
    for (const assetId of assetIds) {
      const found = await loadAsset(assetId);
      if (found && found.row.runId === ctx.runId) {
        const file = `${name}/${safeName(found.row.name)}`;
        await put(join(root, "input"), file, found.data);
        listed.push(`- \`input/${file}\` (${found.row.mime})`);
        n++;
      }
    }
    if (head === "steps" && output?.json !== undefined) {
      await put(join(root, "input"), `${name}.json`, JSON.stringify(output.json, null, 1));
      listed.push(`- \`input/${name}.json\``);
    } else if (head === "steps" && output?.text) {
      await put(join(root, "input"), `${name}.md`, output.text);
      listed.push(`- \`input/${name}.md\``);
    } else if (!n) {
      const value = resolveRef(ref, ctx.scope);
      if (value !== undefined && value !== null && value !== "") {
        await put(
          join(root, "input"),
          `${name}.md`,
          typeof value === "string" ? value : JSON.stringify(value, null, 1),
        );
        listed.push(`- \`input/${name}.md\``);
      }
    }
  }
  await put(
    join(root, "input"),
    "README.md",
    `${prompt("step", "motion.input", { files: listed.join("\n") || "(none)" })}\n`,
  );

  await cp(await soundCatalog(), join(root, "audio-catalog"), { recursive: true });

  // The HyperFrames project: the earlier video, the kit's base in this format, or a new one.
  const index = `index.${step.format.replace(":", "x")}.html`;
  let start: MotionStart;
  if (from && fromDir) {
    start = "from";
    await cp(fromDir, join(root, "video"), {
      recursive: true,
      filter: (path) => !/\/(renders|snapshots)(\/|$)/.test(path.slice(fromDir.length)),
    });
    const fromBase = await readFile(join(motionRoot(ctx.runId, from), BASE), "utf8").catch(
      () => "",
    );
    if (fromBase) {
      await put(root, BASE, fromBase);
    }
  } else if (base[index]) {
    start = "base";
    for (const [name, data] of Object.entries(base)) {
      if (!/^index\.\d+x\d+\.html$/.test(name)) {
        await put(join(root, "video"), name, data);
      }
    }
    await put(join(root, "video"), "index.html", base[index]);
    await put(root, BASE, brandBaseDir(ctx, kitFile?.hash ?? "", brandStamp));
  } else {
    start = "init";
    const preset = { "16:9": "landscape", "9:16": "portrait", "1:1": "square" }[step.format];
    const init = await runHyperframes(
      ["init", "video", "--non-interactive", "--skip-transcribe", `--resolution=${preset}`],
      { cwd: root, signal: ctx.signal, timeoutMs: 5 * 60_000 },
    );
    if (init.code !== 0 || !existsSync(join(root, "video"))) {
      throw new Error(`The video project could not be set up: ${init.out.slice(-300)}`);
    }
  }
  await brandIntoMotion(root, false);
  const text = rules(step, skills, start);
  await put(root, "CLAUDE.md", text);
  await put(root, "AGENTS.md", text);
  await put(root, START, start);
  await put(root, ".engenty/inputs", stamp);
  return { root, brief, brandChanged: false, start };
}
