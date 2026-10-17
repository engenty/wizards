import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { dataRef, FILM_SIZES, type FilmStep } from "@engenty-wizards/shared/definition";
import { gradientCss, ruleLines, textStyleLine } from "@engenty-wizards/shared/projects";
import { unzipSync } from "fflate";
import { logoSectionLine, renderTemplate, resolveRef } from "../engine/template.js";
import type { StepContext } from "../engine/types.js";
import { env } from "../env.js";
import { getBlob } from "../files/blobs.js";
import { extFor, loadAsset } from "../files/storage.js";
import { projectFileContent } from "../services/project-files.js";
import { placeSkills } from "./skills.js";
import { soundCatalog } from "./sounds.js";
import { runHyperframes } from "./tools.js";

/**
 * The folder a film is made in: one per run and step, kept after the run so a later change edits
 * the code instead of starting over. Laid out for the client:
 *
 *   BRIEF.md            what to make (the step's brief, the format, the length)
 *   CLAUDE.md, AGENTS.md the rules of the folder
 *   .claude/skills/     the skill packages
 *   showcase/           the wizard's style kit, the bar to reach
 *   brand/              the space's brand: brand.json, logos
 *   input/              what this run made before: voice lines, pictures, texts, uploads
 *   audio-catalog/      the only sounds the film may use
 *   film/               the HyperFrames project; renders/film.mp4 is the result
 */
export function filmRoot(runId: string, stepId: string): string {
  return join(env.dataDir, "films", runId, stepId);
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

/** Where the client starts, by how film/ began. */
function startRules(start: FilmStart): string {
  if (start === "base") {
    return `- **What to make:** BRIEF.md. **Start here:** film/ is already the wizard's base project in this
  format — read film/PARTS.md first: its scene templates carry the look. Compose the film from them in
  the one file PARTS.md names, timed to the voice; write a new scene only where no template fits, then
  in the style of showcase/ (SHOWCASE.md says how each technique is made).
- **The brand:** film/brand/ holds brand.json and the logos. If film/brand/theme.json is missing, make
  it first as film/BRAND.md says — it is kept for the next films of this space, so get it right.
  Colours, logo and fonts come from there only.
`;
  }
  if (start === "from") {
    return `- **What to make:** BRIEF.md. **Start here:** film/ holds a finished film of this run in another
  format. Lay it out for this one: scenes, timing, words and sound stay; only the layout changes
  (film/PARTS.md says how when it exists). The look is showcase/'s.
- **The brand:** film/brand/ when it is there, else brand/brand.json and brand/logos/ — colours, logo
  and fonts come from there only.
`;
  }
  return `- **What to make:** BRIEF.md. **The bar:** showcase/ (read showcase/SHOWCASE.md and showcase/frame.md
  first when it exists, look at its stills, reuse its helpers from showcase/assets/). **The brand:**
  brand/brand.json and brand/logos/ — colours, logo and fonts come from there only.
`;
}

function rules(step: FilmStep, skills: string[], start: FilmStart): string {
  const size = FILM_SIZES[step.format];
  return `# The film folder

You make one film here, autonomously, to the end. Nobody answers questions: where a skill asks the
person, decide yourself and note it in PROGRESS.md.

${startRules(start)}- **Material:** input/ (see input/README.md). Use nothing from the web; you have no network.
- **Skills:** ${skills.join(", ")} in .claude/skills/<name>/SKILL.md. Start with \`hyperframes\` and
  read the skill files directly; do not update or install skills.
- **The HyperFrames project is film/** (${size.width}×${size.height}). Keep every file of the film
  inside film/.
- **Running HyperFrames:** only through the \`hyperframes\` tool (MCP server \`film\`), e.g.
  \`["lint","film"]\`, \`["check","film"]\`, \`["snapshot","film","--at","1,4,8"]\`,
  \`["render","film","-q","draft"]\`, \`["transcribe","input/voice/l01.wav","--json","-d","input/voice"]\`.
  \`npx\`, \`npm\` and network do not work in the shell.
- **Look at your work:** snapshot the frames and read the PNGs, fix what is wrong. Before you finish,
  render a draft and look at a frame every second of the whole film: empty areas, cut-off text,
  overlaps, jumps.
- **Finish** only when \`["check","film"]\` passes and \`["render","film","-q","draft"]\` succeeds, with \`film/index.html\` complete. The runtime renders the final MP4 itself.
  End with a short summary: what the film shows, what you decided.

## Sound (hard rules)

- Sounds come only from audio-catalog/ (catalog.json lists each file with tags, keywords, licence).
  Copy the picked files into film/assets/ and list them in film/AUDIO.md (file, source, licence, use).
- Never generate, synthesize or download audio: no ffmpeg tone or noise, no TTS, no music models. Voice
  lines come only from input/. Mixing is HyperFrames' job (\`<audio>\` with start, duration, volume).
- Install nothing (no pip, brew, npm).
`;
}

const BRAND_STAMP = join(".engenty", "brand");

/**
 * Writes the space's brand into brand/ as it is now (brand.json, logos). True when it differs
 * from what the folder had before — the film's code then still carries the old one.
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
    const f = ctx.projectFiles.find((x) => x.id === p.file);
    try {
      if (f) {
        const { data } = await projectFileContent(f.projectId, f.id);
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
  for (const f of ctx.projectFiles.filter((p) => p.kind === "logo")) {
    try {
      const { data } = await projectFileContent(f.projectId, f.id);
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
      note: "The space's brand. Colours are named by what they are for; the first is the accent. A logo's section, a gradient's or a pattern's description says when to use it; colorRules, logoRules and typeRules, where there are any, say how colours, logos and type may be used; text is set in the fonts — a font with `uses` that leave out video is not used in a film: its text gets a system font.",
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

/** How the film/ project began: from the kit's base, from an earlier film step, or empty. */
export type FilmStart = "base" | "from" | "init";

const START = join(".engenty", "start");
const BASE = join(".engenty", "base");

/**
 * The brand base: what a film made once from the space's brand for the kit's base (the base's
 * BRAND.md says what — theme.json at least), kept per space for the kit and the brand as they are.
 * A changed brand or kit is another key, so it is made again.
 */
function brandBaseDir(ctx: StepContext, kitHash: string, brandStamp: string): string {
  const key = createHash("sha256").update(`${kitHash}:${brandStamp}`).digest("hex").slice(0, 24);
  return join(env.dataDir, "brand-bases", ctx.project.id, key);
}

/** What in film/brand/ is the brand base: everything but the brand itself. */
const isBrandItself = (name: string) =>
  name === "brand.json" || name === "logos" || name === "patterns";

/**
 * Brings the brand into a project that started from a base: brand.json and the logos as they are
 * now, and the brand base kept for them when there is one. A base that no longer fits the brand
 * is removed — the film makes it again, as BRAND.md says.
 */
async function brandIntoFilm(root: string, brandChanged: boolean) {
  const base = await readFile(join(root, BASE), "utf8").catch(() => "");
  if (!base) {
    return;
  }
  const target = join(root, "film", "brand");
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
async function refreshBrandBase(root: string, ctx: StepContext, step: FilmStep) {
  if (!existsSync(join(root, BASE))) {
    return;
  }
  const kitHash = ctx.files.find((f) => f.path === step.kit)?.hash ?? "";
  const stamp = await readFile(join(root, BRAND_STAMP), "utf8");
  await put(root, BASE, brandBaseDir(ctx, kitHash, stamp));
}

/** After a film: keeps what it made from the brand for the next films in this space. */
export async function keepBrandBase(root: string) {
  const base = await readFile(join(root, BASE), "utf8").catch(() => "");
  const source = join(root, "film", "brand");
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
export async function prepareFilmFolder(
  step: FilmStep,
  ctx: StepContext,
): Promise<{ root: string; brief: string; brandChanged: boolean; start: FilmStart }> {
  const root = filmRoot(ctx.runId, step.id);
  const brief = renderTemplate(step.brief, ctx.scope).trim();
  // An earlier film to start from, when it ran.
  const fromId = step.from ? dataRef(step.from).replace(/^steps\./, "") : null;
  const fromDir = fromId ? join(filmRoot(ctx.runId, fromId), "film") : null;
  const from = fromId && fromDir && existsSync(join(fromDir, "index.html")) ? fromId : null;
  // The same brief and material as last time: the film is there to go on with or to change.
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
  if (same && existsSync(join(root, "film", "index.html")) && (await savedSession(root))) {
    // The brand is the space's as it is now, also for a change: colours or a logo may be new.
    const { changed } = await writeBrand(root, ctx);
    const start = ((await readFile(join(root, START), "utf8").catch(() => "")) ||
      "init") as FilmStart;
    if (changed) {
      await refreshBrandBase(root, ctx, step);
    }
    await brandIntoFilm(root, changed);
    return { root, brief, brandChanged: changed, start };
  }
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });

  const skills = await placeSkills(step.skills, ctx.files, join(root, ".claude", "skills"));
  const size = FILM_SIZES[step.format];

  await put(
    root,
    "BRIEF.md",
    `# Brief\n\nFormat ${step.format}, ${size.width}×${size.height}${
      step.seconds ? `, about ${step.seconds} s` : ""
    }. Language of all text on screen: the brief's language.\n\n${brief}\n`,
  );

  // The style kit: the showcase to look at, and the base a film starts from when it has one.
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
    `# Material for this film\n\n${listed.join("\n") || "(none)"}\n\nVoice lines play one after another in their order; their lengths decide the timing.\n`,
  );

  await cp(await soundCatalog(), join(root, "audio-catalog"), { recursive: true });

  // The HyperFrames project: the earlier film, the kit's base in this format, or a new one.
  const index = `index.${step.format.replace(":", "x")}.html`;
  let start: FilmStart;
  if (from && fromDir) {
    start = "from";
    await cp(fromDir, join(root, "film"), {
      recursive: true,
      filter: (path) => !/\/(renders|snapshots)(\/|$)/.test(path.slice(fromDir.length)),
    });
    const fromBase = await readFile(join(filmRoot(ctx.runId, from), BASE), "utf8").catch(() => "");
    if (fromBase) {
      await put(root, BASE, fromBase);
    }
  } else if (base[index]) {
    start = "base";
    for (const [name, data] of Object.entries(base)) {
      if (!/^index\.\d+x\d+\.html$/.test(name)) {
        await put(join(root, "film"), name, data);
      }
    }
    await put(join(root, "film"), "index.html", base[index]);
    await put(root, BASE, brandBaseDir(ctx, kitFile?.hash ?? "", brandStamp));
  } else {
    start = "init";
    const preset = { "16:9": "landscape", "9:16": "portrait", "1:1": "square" }[step.format];
    const init = await runHyperframes(
      ["init", "film", "--non-interactive", "--skip-transcribe", `--resolution=${preset}`],
      { cwd: root, signal: ctx.signal, timeoutMs: 5 * 60_000 },
    );
    if (init.code !== 0 || !existsSync(join(root, "film"))) {
      throw new Error(`The film project could not be set up: ${init.out.slice(-300)}`);
    }
  }
  await brandIntoFilm(root, false);
  const text = rules(step, skills, start);
  await put(root, "CLAUDE.md", text);
  await put(root, "AGENTS.md", text);
  await put(root, START, start);
  await put(root, ".engenty/inputs", stamp);
  return { root, brief, brandChanged: false, start };
}
