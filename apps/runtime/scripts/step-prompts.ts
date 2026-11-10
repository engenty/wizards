import { type PromptFile, promptSections } from "../src/prompts.js";

/**
 * The prompt sections a run's steps read (packages/engine/src/prompts.ts): all of `step.md`, and
 * from the other files the sections named here.
 */
export const STEP_PROMPT_SECTIONS: Partial<Record<PromptFile, "all" | string[]>> = {
  step: "all",
  safety: ["policy"],
  authoring: ["surfaces"],
};

/** The sections, by file and name, as the files give them now. */
export function stepPrompts(): Record<string, Record<string, string>> {
  return Object.fromEntries(
    Object.entries(STEP_PROMPT_SECTIONS).map(([file, names]) => {
      const sections = promptSections(file as PromptFile);
      const picked = names === "all" ? [...sections.keys()] : names;
      return [
        file,
        Object.fromEntries(
          picked.map((name) => {
            const text = sections.get(name);
            if (text === undefined) throw new Error(`prompts/${file}.md: no section "${name}"`);
            return [name, text];
          }),
        ),
      ];
    }),
  );
}

/** The engine's module of them: packages/engine/src/step-prompts.ts (write-step-prompts.ts). */
export function stepPromptsModule(): string {
  const files = Object.entries(stepPrompts()).map(([file, sections]) => {
    const lines = Object.entries(sections).map(
      ([name, text]) => `    ${JSON.stringify(name)}:\n      ${JSON.stringify(text)},`,
    );
    return `  ${file}: {\n${lines.join("\n")}\n  },`;
  });
  const keys = Object.keys(STEP_PROMPT_SECTIONS)
    .map((f) => JSON.stringify(f))
    .join(" | ");
  return [
    "// Written by `pnpm prompts:engine` (apps/runtime/scripts/write-step-prompts.ts) from the",
    "// runtime's prompt files, apps/runtime/src/prompts. Edit those, not this.",
    "",
    "/** The prompt sections a run's steps read, by file and section. */",
    `export const STEP_PROMPTS: Record<${keys}, Record<string, string>> = {`,
    ...files,
    "};",
    "",
  ].join("\n");
}
