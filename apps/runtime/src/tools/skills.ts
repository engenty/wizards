import { skillMd } from "@engenty/wizards-shared/skills";
import { createTool } from "@mastra/core/tools";
import { readableIds } from "../broker/rwx.js";
import { type ElementCaller, stepCaller } from "../elements/caller.js";
import { elementCall, mayDo } from "../elements/gate.js";
import { ELEMENT_SPECS } from "../elements/specs.js";
import type { StepContext } from "../engine/types.js";
import { getBlob } from "../files/blobs.js";
import { prompt } from "../prompts.js";
import type { Sandbox } from "../sandbox/index.js";
import { activeSkills } from "../services/skills.js";
import { attempt, clip } from "./shared.js";

/**
 * Skills in an AI step (docs/plans/skills.md). A skill always on stands whole in the step's
 * instructions; one on demand is named there with its description, and the step reads it with
 * `skill_load` when it fits the task, and a file it points to with `skill_read`. Goose gets the
 * same tools for the space it works in.
 *
 * A skill whose scripts may run (`runScripts`, switched on by a person) gets its folder written
 * into the run's sandbox when a step that has the sandbox loads it: `skills/<name>/` in the
 * working directory, where `run_command` runs its scripts. Without the sandbox its scripts stay
 * text, as every other skill's do.
 */

type Skills = Awaited<ReturnType<typeof activeSkills>>;
type Skill = Skills["always"][number];

const found = new WeakMap<StepContext, Promise<Skills>>();

/** The space's skills that count, asked once per step. */
export function skillsOf(ctx: StepContext): Promise<Skills> {
  let skills = found.get(ctx);
  if (!skills) {
    skills = activeSkills(ctx.space.id);
    found.set(ctx, skills);
  }
  return skills;
}

/** The run's sandbox, for a step that has the sandbox tool on a server where it is on. */
export interface SkillSandbox {
  handle: () => Sandbox;
  workdir: string;
}

/** A skill whose scripts may run, with files for them to be. */
const runnable = (k: Skill) => k.runScripts && (k.files.length > 0 || k.blobFiles.length > 0);

/** Where a skill's folder goes, from the sandbox's working directory. */
export const skillFolder = (name: string) => `skills/${name}`;

/** A sandbox's skill folders written so far, by name and version: each once per run. */
const placed = new WeakMap<Sandbox, Map<string, Promise<void>>>();

/** Writes a skill's folder, `SKILL.md` and every file, into the sandbox; a few files at a time. */
async function writeFolder(sandbox: Sandbox, k: Skill): Promise<void> {
  const folder = skillFolder(k.name);
  await sandbox.exec(`rm -rf ${folder}`);
  const files: [string, () => Promise<string | Uint8Array>][] = [
    ["SKILL.md", async () => skillMd(k)],
    ...k.files.map((f): [string, () => Promise<string>] => [f.path, async () => f.text]),
    ...k.blobFiles.map((f): [string, () => Promise<Uint8Array>] => [
      f.path,
      async () => new Uint8Array(await getBlob(f.hash)),
    ]),
  ];
  // Each write is a command or two in the sandbox: eight go at once.
  for (let i = 0; i < files.length; i += 8) {
    await Promise.all(
      files
        .slice(i, i + 8)
        .map(async ([path, data]) => sandbox.writeFile(`${folder}/${path}`, await data())),
    );
  }
}

/** Puts a skill's folder into the sandbox, unless this run has it already as it is now. */
export function placeSkill(sandbox: Sandbox, k: Skill): Promise<void> {
  let done = placed.get(sandbox);
  if (!done) {
    done = new Map();
    placed.set(sandbox, done);
  }
  const key = `${k.name}@${k.updatedAt.getTime()}`;
  let write = done.get(key);
  if (!write) {
    const map = done;
    write = writeFolder(sandbox, k);
    map.set(key, write);
    write.catch(() => map.delete(key));
  }
  return write;
}

const filesLine = (k: Skill) =>
  k.files.length
    ? prompt("step", "skills.files", { files: k.files.map((f) => f.path).join(", ") })
    : "";

/**
 * What a step's instructions say of the space's skills: the ones always on whole, then the
 * ones on demand by name and description, then which of them bring scripts that run. `tools`:
 * the model can call tools; a client that cannot (an on-device model) gets the skills always on
 * alone. `sandbox`: the step has the sandbox, where scripts run.
 */
export function skillsBlock(
  skills: Skills,
  { tools, sandbox = false }: { tools: boolean; sandbox?: boolean },
): string {
  const parts: string[] = [];
  if (skills.always.length) {
    parts.push(
      [
        prompt("step", "skills.always"),
        ...skills.always.map((k) =>
          [`<skill name="${k.name}">`, k.body.trim(), tools ? filesLine(k) : "", "</skill>"]
            .filter(Boolean)
            .join("\n"),
        ),
      ].join("\n\n"),
    );
  }
  if (tools && skills.demand.length) {
    parts.push(
      [
        prompt("step", "skills.demand"),
        ...skills.demand.map((k) => `- ${k.name}: ${k.description}`),
      ].join("\n"),
    );
  }
  const scripts = tools && sandbox ? [...skills.always, ...skills.demand].filter(runnable) : [];
  if (scripts.length) {
    parts.push(prompt("step", "skills.scripts", { names: scripts.map((k) => k.name).join(", ") }));
  }
  return parts.join("\n\n");
}

const byName = (skills: Skills, name: string) =>
  [...skills.always, ...skills.demand].find((k) => k.name === name.trim().toLowerCase());

/**
 * `skill_load` and `skill_read` over the skills that count, for the caller of the tool catalogue
 * (elements/): reading a skill is `r` on it, its folder placed in the caller's sandbox for its
 * scripts to run is `x` (docs/plans/modular.md). Each call is a line of the broker's log. None
 * when the space has no skill a model could read.
 */
export function skillToolsOf(skills: Skills, caller: ElementCaller): Record<string, any> {
  const sandbox = caller.sandbox ?? null;
  const onRead = (name: string) => caller.note?.({ code: "readsSkill", params: { name } });
  const asSkill = (k: Skill) => ({ kind: "skill" as const, id: k.id });
  const readable = [...skills.always, ...skills.demand];
  if (
    !(skills.demand.length || skills.always.some((k) => k.files.length || (sandbox && runnable(k))))
  ) {
    return {};
  }
  const names = readable.map((k) => k.name).join(", ");
  const runs = Boolean(sandbox && readable.some(runnable));
  /** Where the skill's folder is in the sandbox, or why it isn't: only for a skill that runs. */
  const place = async (k: Skill): Promise<{ folder?: string; scripts: string } | null> => {
    if (!(sandbox && runnable(k))) {
      return null;
    }
    if (!(await mayDo(caller, asSkill(k), "x"))) {
      return { scripts: prompt("tools", "note.skill_scripts_refused") };
    }
    const folder = `${sandbox.workdir}/${skillFolder(k.name)}`;
    try {
      await placeSkill(sandbox.handle(), k);
    } catch (err) {
      const error = String((err as Error)?.message ?? err).slice(0, 300);
      return { scripts: prompt("tools", "note.skill_folder_failed", { error }) };
    }
    return {
      folder,
      scripts: prompt("tools", "note.skill_folder", { folder: skillFolder(k.name) }),
    };
  };
  return {
    skill_list: createTool({
      id: "skill_list",
      description: ELEMENT_SPECS.skill_list.description(),
      inputSchema: ELEMENT_SPECS.skill_list.input,
      execute: (input) =>
        attempt(() =>
          elementCall(
            caller,
            { action: "skill_list", about: "skills", perm: "r", input },
            async () => {
              const ok = new Set(
                await readableIds(
                  caller.space.id,
                  caller.subjects,
                  "skill",
                  readable.map((k) => k.id),
                ),
              );
              return {
                skills: readable
                  .filter((k) => ok.has(k.id))
                  .map((k) => ({ name: k.name, description: k.description })),
              };
            },
          ),
        ),
    }),
    skill_load: createTool({
      id: "skill_load",
      description: prompt("tools", "tool.skill_load", { names }),
      inputSchema: ELEMENT_SPECS.skill_load.input,
      execute: (input) =>
        attempt(async () => {
          const k = byName(skills, input.name);
          if (!k) {
            return { error: prompt("tools", "note.skill_unknown", { name: input.name, names }) };
          }
          return elementCall(
            caller,
            { action: "skill_load", resource: asSkill(k), perm: "r", input },
            async () => {
              await onRead(k.name);
              const placed = await place(k);
              // In the sandbox, the files for its scripts are there too.
              const files = placed?.folder ? [...k.files, ...k.blobFiles] : k.files;
              return {
                name: k.name,
                instructions: clip(k.body, 60_000),
                files: files.map((f) => f.path).sort(),
                ...placed,
              };
            },
          );
        }),
    }),
    skill_read: createTool({
      id: "skill_read",
      description: runs
        ? prompt("tools", "tool.skill_read")
        : `${prompt("tools", "tool.skill_read")} ${prompt("tools", "tool.skill_read.text_only")}`,
      inputSchema: ELEMENT_SPECS.skill_read.input,
      execute: (input) =>
        attempt(async () => {
          const { name, path, from } = input;
          const k = byName(skills, name);
          if (!k) {
            return { error: prompt("tools", "note.skill_unknown", { name, names }) };
          }
          return elementCall(
            caller,
            { action: "skill_read", resource: asSkill(k), perm: "r", input },
            () => readSkillFile(k, path, from, onRead),
          );
        }),
    }),
  };
}

/** A file of a skill, in parts: `SKILL.md` whole, a text file from `from`. */
async function readSkillFile(
  k: Skill,
  path: string,
  from: number | undefined,
  onRead: (name: string) => Promise<void> | void,
) {
  if (path === "SKILL.md") {
    return { path, text: clip(skillMd(k), 60_000) };
  }
  const wanted = path.replace(/^\.?\//, "");
  const file = k.files.find((f) => f.path === wanted);
  if (!file && k.blobFiles.some((f) => f.path === wanted)) {
    return { error: prompt("tools", "note.skill_blob", { path: wanted }) };
  }
  if (!file) {
    return {
      error: prompt("tools", "note.skill_no_file", {
        path,
        skill: k.name,
        files: k.files.map((f) => f.path).join(", ") || "none",
      }),
    };
  }
  await onRead(`${k.name}/${file.path}`);
  const start = from ?? 0;
  const part = file.text.slice(start, start + 30_000);
  const rest = file.text.length - start - part.length;
  return {
    path: file.path,
    text: part,
    ...(rest > 0
      ? { more: prompt("tools", "note.skill_more", { rest, from: start + part.length }) }
      : {}),
  };
}

/**
 * The skill tools of an AI step: what it reads goes into the run's events. `sandbox`: the
 * step's sandbox, where the folders of skills whose scripts may run go.
 */
export async function skillTools(
  ctx: StepContext,
  sandbox: SkillSandbox | null = null,
): Promise<Record<string, any>> {
  return skillToolsOf(await skillsOf(ctx), stepCaller(ctx, sandbox));
}
