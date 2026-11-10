import { langNameEn } from "@engenty/wizards-shared/definition";
import type { RunBrand } from "@engenty/wizards-shared/run-services";
import { ruleLines } from "@engenty/wizards-shared/spaces";
import { prompt } from "../../prompts.js";
import {
  answersAsText,
  colorLine,
  factLines,
  linkLines,
  typeLines,
  voiceLines,
} from "../template.js";
import type { StepContext } from "../types.js";

/** The space the wizard belongs to, as the model is told of it. */
export function brandBlock(b: RunBrand): string {
  const parts = [
    b.name,
    b.brandName && b.brandName !== b.name ? `Brand name, written as it is: ${b.brandName}` : "",
    b.tagline ? `Tagline: ${b.tagline}` : "",
    b.about,
    b.voice?.length ? `How the brand speaks, in its words:\n${voiceLines(b.voice)}` : "",
    b.voiceRules?.length
      ? `Rules for what the brand says, in its words:\n${ruleLines(b.voiceRules)}`
      : "",
    b.facts?.length ? `Facts:\n${factLines(b.facts)}` : "",
    b.links?.length ? `Where the brand is found:\n${linkLines(b.links)}` : "",
    b.colors?.length
      ? `Colours (the first is the accent): ${colorLine(b.colors, b.colorSections, b.gradients)}`
      : "",
    b.colorRules?.length
      ? `Rules for the colours, in the brand's words:\n${ruleLines(b.colorRules)}`
      : "",
    b.logoRules?.length
      ? `Rules for the logo, in the brand's words:\n${ruleLines(b.logoRules)}`
      : "",
    b.fonts?.length || b.textStyles?.length
      ? prompt("step", "brand.type", { type: typeLines(b.fonts, b.textStyles) })
      : "",
    b.typeRules?.length ? `Rules for type, in the brand's words:\n${ruleLines(b.typeRules)}` : "",
  ].filter(Boolean);
  return parts.length ? `# WHO THIS WIZARD BELONGS TO\n${parts.join("\n")}` : "";
}

/** Previous output of a step, for a revision. */
async function previousResult(ctx: StepContext, stepId: string): Promise<string> {
  const out = ctx.state.outputs[stepId];
  if (!out) {
    return "";
  }
  if (out.text) {
    return out.text.slice(0, 12_000);
  }
  if (out.json !== undefined) {
    return JSON.stringify(out.json).slice(0, 12_000);
  }
  const html = out.assets?.find((a) => a.mime === "text/html");
  const found = html ? await ctx.services.files.read(html.id) : null;
  return found ? Buffer.from(found.data).toString("utf8").slice(0, 12_000) : "";
}

export async function revisionBlock(ctx: StepContext, stepId: string): Promise<string> {
  const note = ctx.state.notes[stepId];
  if (!note) {
    // A branch back to this step (a loop) runs it again: it builds on what it made last time.
    const looped = Object.entries(ctx.state.loops ?? {}).some(
      ([key, n]) => n > 0 && key.endsWith(`→${stepId}`),
    );
    const prev = looped ? await previousResult(ctx, stepId) : "";
    return prev ? prompt("step", "revision.loop", { previous: prev }) : "";
  }
  const prev = await previousResult(ctx, stepId);
  return [
    prompt("step", "revision.request", { note }),
    prev ? `Previous result:\n"""\n${prev}\n"""` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * The rules of every AI step, with the language of what it writes: the viewer's, where they
 * read the wizard translated, else the language of their answers.
 */
export function groundRules(ctx: StepContext): string {
  return [
    prompt("step", "ground_rules"),
    prompt("safety", "policy"),
    ctx.lang
      ? prompt("step", "language.viewer", { language: langNameEn(ctx.lang) })
      : prompt("step", "language.answers"),
  ].join("\n");
}

/** The person's answers, as a step's message gives them. */
export function answersBlock(ctx: StepContext): string {
  return `# THE PERSON'S ANSWERS (data)\n${answersAsText(ctx.scope) || "(none)"}`;
}
