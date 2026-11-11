import {
  parseWizard,
  type ValidationIssue,
  type WizardDefinition,
} from "@engenty/wizards-shared/definition";
import { requiresProblem } from "@engenty/wizards-shared/requires";
import { wizardAgentUseIssues } from "@engenty/wizards-shared/wizard-agents";
import { dataFiles, wizardDataIssues } from "@engenty/wizards-shared/wizard-data";
import { WIZARD_SKILLS_DIR, wizardSkillIssues } from "@engenty/wizards-shared/wizard-skills";
import { sandboxToolHostIssues, wizardAgentFiles, wizardToolFileIssues } from "./wizard-code.js";

/**
 * A wizard checked on its own, as the studio checks it on import: what `wizards validate` says,
 * and what a run started from a folder, a file or an address checks before it starts
 * (`@engenty/wizards-run/resolve`).
 *
 * The definition parses; its agents' files read and say what the steps use of them; `requires`
 * says what the steps and the agents need; the tools under `tools/` load as a run loads them (a
 * function tool's file in QuickJS, a sandbox tool's `TOOL.md` with its front matter) and a step
 * lists the hosts its sandbox tools reach; the skills' `SKILL.md` read; the SQL of the wizard's
 * own database splits into statements. What a space holds (its connectors, MCP servers and
 * plugins) is not here: that is checked where the wizard comes into a space.
 */

/** A wizard as it was read: its definition, its workspace's paths and a file's text by path. */
export interface WizardGiven {
  definition: unknown;
  files: readonly string[];
  /** A workspace file's text, or null where it isn't there. */
  read(path: string): Promise<string | null>;
}

export type WizardChecked =
  | { ok: true; wizard: WizardDefinition; issues: [] }
  | { ok: false; wizard: WizardDefinition | null; issues: ValidationIssue[] };

const isSkillMd = (path: string) =>
  path.startsWith(WIZARD_SKILLS_DIR) && path.endsWith("/SKILL.md");

/** The SQL files of the wizard's own database, read: each splits into statements the runtime runs. */
async function dataIssues(def: WizardDefinition, given: WizardGiven): Promise<ValidationIssue[]> {
  const files = dataFiles(def, [...given.files]);
  const texts = new Map<string, string | null>();
  for (const file of files ? [files.schema, ...files.migrations] : []) {
    texts.set(file, await given.read(file));
  }
  return wizardDataIssues(def, [...given.files], (p) => texts.get(p) ?? null).map((i) => ({
    message: i.message,
  }));
}

export async function checkWizard(given: WizardGiven): Promise<WizardChecked> {
  const files = [...given.files];
  const parsed = parseWizard(given.definition, files);
  const agents = await wizardAgentFiles(files, given.read);
  // `requires` says what the steps and the agents' files need: a file that says otherwise is out
  // of date. Where an agent's file is broken, that is said first.
  const requires =
    parsed.ok && !agents.issues.length
      ? requiresProblem(parsed.wizard, agents.agents, files)
      : null;
  const checked = [
    ...parsed.issues,
    ...(parsed.ok ? wizardAgentUseIssues(parsed.wizard, agents.agents) : []),
    ...(requires ? [{ message: requires }] : []),
  ];
  // A tool a step names is checked by the definition too: each message once.
  const said = new Set(checked.map((issue) => issue.message));
  const skillMds: Record<string, string> = {};
  for (const file of files.filter(isSkillMd)) {
    skillMds[file] = (await given.read(file)) ?? "";
  }
  const issues = [
    ...checked,
    ...[...(await wizardToolFileIssues(files, given.read)), ...agents.issues]
      .filter((message) => !said.has(message))
      .map((message) => ({ message })),
    ...wizardSkillIssues(files, skillMds),
    ...(parsed.ok ? await sandboxToolHostIssues(parsed.wizard.steps, files, given.read) : []),
    ...(parsed.ok ? await dataIssues(parsed.wizard, given) : []),
  ];
  if (parsed.ok && !issues.length) {
    return { ok: true, wizard: parsed.wizard, issues: [] };
  }
  return { ok: false, wizard: parsed.ok ? parsed.wizard : null, issues };
}
