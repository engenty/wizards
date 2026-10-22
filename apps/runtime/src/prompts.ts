import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Every text a model reads lives in `prompts/`, one Markdown file per agent or area; code only
 * fills in placeholders. The build copies the folder to dist/prompts.
 *
 * A file is split into sections by `<!-- section: name -->` lines. Other HTML comments are notes
 * for whoever edits the file and never reach a model. A section's text is trimmed of the blank
 * lines around it. `${name}` is a placeholder: the caller must fill each one and nothing else.
 *
 * Built, a file is read once. From source it is read again whenever it changed on disk, so an
 * edit shows on the next call without a restart.
 */
export type PromptFile =
  | "architect"
  | "authoring"
  | "goose"
  | "mcp"
  | "safety"
  | "services"
  | "step"
  | "tools"
  | "voice";

const here = dirname(fileURLToPath(import.meta.url));
const FROM_SOURCE = import.meta.url.endsWith(".ts");

const SECTION = /^<!-- section: ([\w.-]+) -->[ \t]*$/m;
const COMMENT = /<!--(?!\s*section:)[\s\S]*?-->\n?/g;
const PLACEHOLDER = /\$\{(\w+)\}/g;

const cache = new Map<string, { mtimeMs: number; sections: Map<string, string> }>();

/** The path of a prompt file; also used by the tests. */
export function promptPath(file: PromptFile): string {
  return join(here, "prompts", `${file}.md`);
}

/** All sections of a file, by name. */
export function promptSections(file: PromptFile): Map<string, string> {
  const path = promptPath(file);
  const mtimeMs = FROM_SOURCE ? statSync(path).mtimeMs : 0;
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.sections;
  const parts = readFileSync(path, "utf8").replace(COMMENT, "").split(SECTION);
  if (parts[0].trim()) throw new Error(`prompts/${file}.md: text before the first section`);
  const sections = new Map<string, string>();
  for (let i = 1; i < parts.length; i += 2) {
    if (sections.has(parts[i])) throw new Error(`prompts/${file}.md: section "${parts[i]}" twice`);
    sections.set(parts[i], parts[i + 1].replace(/^\n+|\n+$/g, ""));
  }
  cache.set(file, { mtimeMs, sections });
  return sections;
}

/** A section's text with its placeholders filled. */
export function prompt(
  file: PromptFile,
  section: string,
  vars: Record<string, string | number> = {},
): string {
  const text = promptSections(file).get(section);
  if (text === undefined) throw new Error(`prompts/${file}.md: no section "${section}"`);
  const used = new Set<string>();
  const filled = text.replace(PLACEHOLDER, (_, name: string) => {
    if (!(name in vars)) throw new Error(`prompts/${file}.md#${section}: \${${name}} not filled`);
    used.add(name);
    return String(vars[name]);
  });
  for (const name of Object.keys(vars)) {
    if (!used.has(name)) throw new Error(`prompts/${file}.md#${section}: no \${${name}}`);
  }
  return filled;
}
