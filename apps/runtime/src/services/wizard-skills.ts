import { parseSkillMd, SKILL_LIMITS, skillTextPath } from "@engenty/wizards-shared/skills";
import {
  WIZARD_SKILLS_DIR,
  wizardSkillFolders,
  wizardSkillId,
  wizardSkillIssues,
} from "@engenty/wizards-shared/wizard-skills";
import type { WorkspaceFile } from "@engenty/wizards-shared/workspace";
import { getBlob } from "../files/blobs.js";
import type { activeSkills } from "./skills.js";
import { skillsOn } from "./skills.js";

/**
 * Skills a wizard brings in its workspace (docs/plans/wizard-code.md, wizard-skills.ts in
 * shared): read from the files a run started with, shaped like a space's skill so the same
 * prompt block and tools take them. They count in the wizard's own steps only and come before a
 * space skill of the same name. Their scripts may run: a wizard that brings them says so in
 * `requires`, and they reach a run's sandbox only when a step that has it loads the skill.
 */

type Skills = Awaited<ReturnType<typeof activeSkills>>;
export type Skill = Skills["always"][number];

/** A wizard's skills never change within a run: their folder is written once per sandbox. */
const SNAPSHOT = new Date(0);

/** The wizard's skills from its workspace; one that doesn't parse is left out (validate says so). */
export async function wizardSkills(
  files: WorkspaceFile[],
  where: { spaceId: string; tenantId: string },
): Promise<Skill[]> {
  const folders = wizardSkillFolders(files.map((f) => f.path));
  const byPath = new Map(files.map((f) => [f.path, f]));
  const skills: Skill[] = [];
  for (const [name, paths] of folders) {
    const md = byPath.get(`${WIZARD_SKILLS_DIR}${name}/SKILL.md`);
    if (!md) {
      continue;
    }
    let parsed: ReturnType<typeof parseSkillMd>;
    try {
      parsed = parseSkillMd((await getBlob(md.hash)).toString("utf8"));
    } catch {
      continue;
    }
    if (parsed.name !== name) {
      continue;
    }
    const others = paths
      .filter((p) => p !== "SKILL.md")
      .map((p) => ({ path: p, file: byPath.get(`${WIZARD_SKILLS_DIR}${name}/${p}`) }))
      .filter((f): f is { path: string; file: WorkspaceFile } => Boolean(f.file));
    const text = others.filter((f) => skillTextPath(f.path));
    skills.push({
      id: wizardSkillId(name),
      tenantId: where.tenantId,
      spaceId: where.spaceId,
      name,
      description: parsed.description.slice(0, SKILL_LIMITS.description),
      body: parsed.body,
      meta: parsed.meta,
      files: await Promise.all(
        text.map(async (f) => ({
          path: f.path,
          text: (await getBlob(f.file.hash)).toString("utf8"),
        })),
      ),
      blobFiles: others
        .filter((f) => !skillTextPath(f.path))
        .map((f) => ({ path: f.path, hash: f.file.hash, bytes: f.file.size })),
      mode: parsed.meta.mode === "always" ? "always" : "demand",
      runScripts: true,
      source: "own",
      origin: null,
      originHash: null,
      bundleId: null,
      createdAt: SNAPSHOT,
      updatedAt: SNAPSHOT,
    });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The skills of a wizard's step: the wizard's own first, then the space's, a space skill hidden
 * by a wizard skill of the same name. Behind the `skills` switch, as the space's are.
 */
export async function withWizardSkills(
  space: Skills,
  files: WorkspaceFile[],
  where: { spaceId: string; tenantId: string },
): Promise<Skills> {
  if (!files.some((f) => f.path.startsWith(WIZARD_SKILLS_DIR)) || !(await skillsOn())) {
    return space;
  }
  const own = await wizardSkills(files, where);
  const names = new Set(own.map((k) => k.name));
  const fromSpace = (list: Skill[]) => list.filter((k) => !names.has(k.name));
  return {
    always: [...own.filter((k) => k.mode === "always"), ...fromSpace(space.always)],
    demand: [...own.filter((k) => k.mode === "demand"), ...fromSpace(space.demand)].slice(
      0,
      SKILL_LIMITS.listed,
    ),
  };
}

/** What is wrong with a workspace's skills, each `SKILL.md` read from the blob store. */
export async function workspaceSkillIssues(files: WorkspaceFile[]) {
  const mds = files.filter(
    (f) => f.path.startsWith(WIZARD_SKILLS_DIR) && f.path.endsWith("/SKILL.md"),
  );
  const texts: Record<string, string> = {};
  for (const f of mds) {
    texts[f.path] = (await getBlob(f.hash)).toString("utf8");
  }
  return wizardSkillIssues(
    files.map((f) => f.path),
    texts,
  );
}
