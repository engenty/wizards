import type { ValidationIssue } from "./definition.js";
import { parseSkillMd, SKILL_LIMITS, SKILL_NAME, SkillMdError, skillScript } from "./skills.js";

/**
 * Skills a wizard brings in its workspace (docs/plans/wizard-code.md): `skills/<name>/SKILL.md`
 * and the files beside it, in the format of the space's skills (skills.ts). They count only in
 * the wizard's own steps, where they come before a space skill of the same name. Front matter
 * `mode: always` puts one whole into every AI step; without it, a step loads it on demand.
 */

/** Where the wizard's skills are in its workspace. */
export const WIZARD_SKILLS_DIR = "skills/";

/** The modes a wizard skill takes in its front matter; `demand` when left out. */
export const WIZARD_SKILL_MODES = ["always", "demand"] as const;

/** A wizard skill as the broker and its log name it: `wizard.<name>`. */
export const wizardSkillId = (name: string) => `wizard.${name}`;

/** The wizard's skill folders by name, each with its files' paths inside the folder. */
export function wizardSkillFolders(paths: string[]): Map<string, string[]> {
  const folders = new Map<string, string[]>();
  for (const path of paths) {
    if (!path.startsWith(WIZARD_SKILLS_DIR)) {
      continue;
    }
    const [name, ...rest] = path.slice(WIZARD_SKILLS_DIR.length).split("/");
    if (!(name && rest.length)) {
      continue;
    }
    const files = folders.get(name) ?? [];
    files.push(rest.join("/"));
    folders.set(name, files);
  }
  return folders;
}

/** The wizard's skills that bring scripts, by name: they need a sandbox that runs a shell. */
export function wizardSkillsWithScripts(paths: string[]): string[] {
  return [...wizardSkillFolders(paths)]
    .filter(([, files]) => files.includes("SKILL.md") && files.some(skillScript))
    .map(([name]) => name);
}

/**
 * Whether the wizard's skills need a sandbox that runs a shell: one of them brings scripts, and
 * an AI step that sees it has `sandbox` among its tools. Every AI step sees every wizard skill.
 */
export function wizardSkillsNeedShell(
  steps: readonly { type: string; tools?: readonly string[] }[],
  paths: string[],
): boolean {
  return (
    wizardSkillsWithScripts(paths).length > 0 &&
    steps.some((s) => s.type === "agent" && s.tools?.includes("sandbox"))
  );
}

/** The relative files a `SKILL.md` links to: `[…](scripts/fill.py)`, without anchors or URLs. */
function linkedFiles(body: string): string[] {
  const links = new Set<string>();
  for (const m of body.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
    const target = m[1].split("#")[0].split("?")[0];
    if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("/")) {
      continue;
    }
    links.add(target.replace(/^\.\//, ""));
  }
  return [...links];
}

const MD_PROBLEMS: Record<SkillMdError["problem"], string> = {
  frontmatter: "has no front matter between --- lines",
  name: 'has no "name" in its front matter',
  description: 'has no "description" in its front matter',
};

/**
 * What is wrong with the wizard's skills: a folder without a `SKILL.md`, one that does not
 * parse, a name that is not its folder's, a mode the format doesn't know, a linked file that
 * is missing, more skills always on than a step carries. `skillMds`: each `SKILL.md`'s text by
 * its workspace path; a path missing there is not checked for its content.
 */
export function wizardSkillIssues(
  paths: string[],
  skillMds: Record<string, string>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const say = (message: string) => issues.push({ message });
  let always = 0;
  let alwaysChars = 0;
  for (const [folder, files] of wizardSkillFolders(paths)) {
    const where = `${WIZARD_SKILLS_DIR}${folder}`;
    if (!files.includes("SKILL.md")) {
      say(`Skill folder "${where}" has no SKILL.md.`);
      continue;
    }
    const text = skillMds[`${where}/SKILL.md`];
    if (text === undefined) {
      continue;
    }
    let parsed: ReturnType<typeof parseSkillMd>;
    try {
      parsed = parseSkillMd(text);
    } catch (err) {
      if (err instanceof SkillMdError) {
        say(`Skill "${where}/SKILL.md" ${MD_PROBLEMS[err.problem]}.`);
        continue;
      }
      throw err;
    }
    if (!(SKILL_NAME.test(folder) && folder.length <= SKILL_LIMITS.name)) {
      say(
        `Skill folder "${where}" is named in lower-case letters, digits and hyphens, at most ${SKILL_LIMITS.name} characters.`,
      );
    } else if (parsed.name !== folder) {
      say(`Skill "${where}" is named "${parsed.name}" in its SKILL.md: name it "${folder}".`);
    }
    if (parsed.description.length > SKILL_LIMITS.description) {
      say(`Skill "${where}" has a description of at most ${SKILL_LIMITS.description} characters.`);
    }
    const mode = parsed.meta.mode ?? "demand";
    if (!(WIZARD_SKILL_MODES as readonly unknown[]).includes(mode)) {
      say(`Skill "${where}" has mode "always" or "demand", not "${String(mode)}".`);
    } else if (mode === "always") {
      always++;
      alwaysChars += parsed.body.length;
    }
    for (const linked of linkedFiles(parsed.body)) {
      if (!files.includes(linked)) {
        say(`Skill "${where}" links to "${linked}", which is not in its folder.`);
      }
    }
  }
  if (always > SKILL_LIMITS.always) {
    say(`A wizard has at most ${SKILL_LIMITS.always} skills with mode "always", not ${always}.`);
  } else if (alwaysChars > SKILL_LIMITS.alwaysChars) {
    say(
      `The skills with mode "always" have at most ${SKILL_LIMITS.alwaysChars} characters of instructions together, not ${alwaysChars}.`,
    );
  }
  return issues;
}
