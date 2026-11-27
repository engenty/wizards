import type { Field, WizardFile } from "./types.js";

/**
 * The types a wizard's steps are written against, made from its file: the input's fields, and
 * for each step the ways the map gives it. Written into the wizard's folder as `wizard.d.ts`, so
 * a step that reads a field the input does not have, or returns a way the map does not have, is
 * an error before anything runs.
 */
const KIND: Record<string, string> = {
  number: "number",
  toggle: "boolean",
  multiselect: "string[]",
  image: "string[]",
  file: "string[]",
};

const typeOf = (field: Field): string => {
  if (field.kind === "items") {
    const columns = (field.columns as { id: string; kind: string }[] | undefined) ?? [];
    const row = columns
      .map((c) => `${JSON.stringify(c.id)}: ${c.kind === "text" ? "string" : "number"}`)
      .join("; ");
    return `{ ${row} }[]`;
  }
  if (field.kind === "select" && Array.isArray(field.options) && field.options.length)
    return (field.options as string[]).map((o) => JSON.stringify(o)).join(" | ");
  return KIND[field.kind] ?? "string";
};

export function typesOf(file: WizardFile, from = "@engenty/wizards-kernel"): string {
  const fields = file.input?.fields ?? [];
  const input = fields
    .map((f) => `  ${JSON.stringify(f.id)}${f.required ? "" : "?"}: ${typeOf(f)};`)
    .join("\n");
  const ways = Object.entries(file.edges)
    .map(
      ([step, tos]) =>
        `  ${JSON.stringify(step)}: ${tos.map((to) => JSON.stringify(to)).join(" | ") || "never"};`,
    )
    .join("\n");
  return `// Written from wizard.json. Do not edit: change the file, and this follows.
import type { Eval, Step } from ${JSON.stringify(from)};

/** What a run is given, or asks for first. */
export type Input = {
${input}
};

/** The ways the map gives each step. */
export type Ways = {
${ways}
};

/** A step of this wizard: \`const legal: WizardStep<"legal"> = async (run, ask) => { … }\`. */
export type WizardStep<Id extends keyof Ways> = Step<Input, Ways[Id]>;

/** An eval of this wizard. */
export type WizardEval = Eval<Input>;
`;
}
