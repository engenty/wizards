import { STEP_PROMPTS } from "./step-prompts.js";

/**
 * The texts a run's steps give a model. They are written in the runtime's prompt files
 * (apps/runtime/src/prompts, its README says how) and reach the engine as a module, so it reads
 * no files: `pnpm prompts:engine` writes step-prompts.ts from `step.md`, `safety.md`'s `policy`
 * and `authoring.md`'s `surfaces`, and a test of the runtime fails while it is behind.
 */
export type StepPromptFile = keyof typeof STEP_PROMPTS;

const PLACEHOLDER = /\$\{(\w+)\}/g;

/** A section's text with its placeholders filled. */
export function prompt(
  file: StepPromptFile,
  section: string,
  vars: Record<string, string | number> = {},
): string {
  const text = STEP_PROMPTS[file][section];
  if (text === undefined) throw new Error(`prompts/${file}.md: no section "${section}"`);
  return fillPrompt(`prompts/${file}.md#${section}`, text, vars);
}

/**
 * Fills a prompt's `${name}` placeholders: each one must be filled and nothing else. `where`
 * names the section in the errors.
 */
export function fillPrompt(
  where: string,
  text: string,
  vars: Record<string, string | number>,
): string {
  const used = new Set<string>();
  const filled = text.replace(PLACEHOLDER, (_, name: string) => {
    if (!(name in vars)) throw new Error(`${where}: \${${name}} not filled`);
    used.add(name);
    return String(vars[name]);
  });
  for (const name of Object.keys(vars)) {
    if (!used.has(name)) throw new Error(`${where}: no \${${name}}`);
  }
  return filled;
}
