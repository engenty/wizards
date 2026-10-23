import { skillMd } from "@engenty/wizards-shared/skills";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { StepContext } from "../engine/types.js";
import { prompt } from "../prompts.js";
import { activeSkills } from "../services/skills.js";
import { attempt, clip } from "./shared.js";

/**
 * Skills in an AI step (docs/plans/skills.md). A skill always on stands whole in the step's
 * instructions; one on demand is named there with its description, and the step reads it with
 * `skill_load` when it fits the task, and a file it points to with `skill_read`. Goose gets the
 * same tools for the space it works in.
 */

type Skills = Awaited<ReturnType<typeof activeSkills>>;
type Skill = Skills["always"][number];

const found = new WeakMap<StepContext, Promise<Skills>>();

/** The space's skills that count, asked once per step. */
export function skillsOf(ctx: StepContext): Promise<Skills> {
  let skills = found.get(ctx);
  if (!skills) {
    skills = activeSkills(ctx.project.id);
    found.set(ctx, skills);
  }
  return skills;
}

const filesLine = (k: Skill) =>
  k.files.length
    ? prompt("step", "skills.files", { files: k.files.map((f) => f.path).join(", ") })
    : "";

/**
 * What a step's instructions say of the space's skills: the ones always on whole, then the
 * ones on demand by name and description. `tools`: the model can call tools; a client that
 * cannot (an on-device model) gets the skills always on alone.
 */
export function skillsBlock(skills: Skills, { tools }: { tools: boolean }): string {
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
  return parts.join("\n\n");
}

const byName = (skills: Skills, name: string) =>
  [...skills.always, ...skills.demand].find((k) => k.name === name.trim().toLowerCase());

/**
 * `skill_load` and `skill_read` over the skills that count. `onRead` says what is read, for the
 * run's events or Goose's line; none when the space has no skill a model could read.
 */
export function skillToolsOf(
  skills: Skills,
  onRead: (name: string) => Promise<void> | void,
): Record<string, any> {
  const readable = [...skills.always, ...skills.demand];
  if (!(skills.demand.length || skills.always.some((k) => k.files.length))) {
    return {};
  }
  const names = readable.map((k) => k.name).join(", ");
  return {
    skill_load: createTool({
      id: "skill_load",
      description: prompt("tools", "tool.skill_load", { names }),
      inputSchema: z.object({ name: z.string().describe("The skill's name, as listed") }),
      execute: ({ name }) =>
        attempt(async () => {
          const k = byName(skills, name);
          if (!k) {
            return { error: prompt("tools", "note.skill_unknown", { name, names }) };
          }
          await onRead(k.name);
          return {
            name: k.name,
            instructions: clip(k.body, 60_000),
            files: k.files.map((f) => f.path),
          };
        }),
    }),
    skill_read: createTool({
      id: "skill_read",
      description: prompt("tools", "tool.skill_read"),
      inputSchema: z.object({
        name: z.string().describe("The skill's name"),
        path: z.string().describe("The file's path in the skill, e.g. references/forms.md"),
        from: z.number().int().min(0).optional().describe("Character to continue a long file at"),
      }),
      execute: ({ name, path, from }) =>
        attempt(async () => {
          const k = byName(skills, name);
          if (!k) {
            return { error: prompt("tools", "note.skill_unknown", { name, names }) };
          }
          if (path === "SKILL.md") {
            return { path, text: clip(skillMd(k), 60_000) };
          }
          const file = k.files.find((f) => f.path === path.replace(/^\.?\//, ""));
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
        }),
    }),
  };
}

/** The skill tools of an AI step: what it reads goes into the run's events. */
export async function skillTools(ctx: StepContext): Promise<Record<string, any>> {
  return skillToolsOf(await skillsOf(ctx), (name) =>
    ctx.emit("tool", { code: "readsSkill", params: { name } }),
  );
}
