// SPDX-License-Identifier: FSL-1.1-MIT OR MIT
import type { z } from "zod";
import {
  fieldSchema,
  nextRuleSchema,
  outputFieldSchema,
  stepSchema,
  wizardSchema,
} from "./definition.js";
import { SURFACE_COMPONENTS, SURFACE_REQUIRED } from "./surface.js";
import { OUTPUT_TAGS, STEP_TAGS, STEP_TEXT } from "./wizard-text.js";

/**
 * The tags of the text form (wizard-text.ts) as a model reads them: each tag with its attributes,
 * read from the schemas so the list cannot fall behind them, and one line on what it is for. The
 * fast first pass (docs/plans/fast-creation.md, Part 3) writes from it.
 */

/** What durable runs add; left out while `durableRuns` is off, with the `<Wait>` step. */
const DURABLE_KEYS: ReadonlySet<string> = new Set([
  "signal",
  "onFail",
  "durable",
  "who",
  "timeout",
  "remind",
  "approve",
]);

/** What each step is for, in one line. */
const STEP_PURPOSE: Record<string, string> = {
  page: "a page the person answers",
  agent: "an AI step that writes, researches or calls tools",
  decision: "answers yes/no, choice or score questions about the run in one cheap call; branch on them",
  generate: "makes an image, a video, a document or a dashboard",
  widget: "an interactive HTML view; leave its HTML to the architect",
  surface: "a view of data from the component catalog",
  "motion-graphics": "a video an AI client makes on this computer",
  review: "the person checks earlier outputs",
  wait: "waits for a time, a date or a signal",
  result: "the end: what the person gets",
};

/**
 * Components a page has: views of a wizard only (`Choice`, `Toggle`, `Slider`) and a chat's
 * (`Form`, `Ref`) are not; `Field` is the `<Field>` tag itself.
 */
const NOT_ON_PAGES: ReadonlySet<string> = new Set([
  "Form",
  "Ref",
  "Choice",
  "Toggle",
  "Slider",
  "Field",
]);

type Def = { type: string; [key: string]: any };
const defOf = (s: z.ZodType): Def => (s as unknown as { _zod: { def: Def } })._zod.def;

function unwrap(s: z.ZodType): { schema: z.ZodType; optional: boolean } {
  let schema = s;
  let optional = false;
  for (;;) {
    const def = defOf(schema);
    if (def.type === "optional" || def.type === "default" || def.type === "nullable") {
      optional = true;
      schema = def.innerType;
    } else if (def.type === "pipe") {
      schema = def.out.type === "transform" ? def.in : def.out;
    } else {
      return { schema, optional };
    }
  }
}

/** How a value of this schema is written as an attribute. */
function hint(s: z.ZodType): string {
  const def = defOf(s);
  switch (def.type) {
    case "string":
    case "template_literal":
      return '"…"';
    case "number":
      return "{n}";
    case "boolean":
      return "";
    case "enum": {
      const values = Object.values(def.entries as Record<string, string>);
      return values.length <= 20 ? values.map((v) => `"${v}"`).join("|") : '"…"';
    }
    case "literal":
      return JSON.stringify(def.values?.[0] ?? def.value);
    case "array":
      return "{[…]}";
    default:
      return "{…}";
  }
}

function attrs(
  shape: Record<string, z.ZodType>,
  leaveOut: ReadonlySet<string>,
  durable: boolean,
): string {
  return Object.entries(shape)
    .filter(([key]) => !leaveOut.has(key) && (durable || !DURABLE_KEYS.has(key)))
    .map(([key, value]) => {
      const { schema, optional } = unwrap(value);
      const h = key === "when" ? "{expression}" : hint(schema);
      return `${key}${optional ? "?" : ""}${h ? `=${h}` : ""}`;
    })
    .join(" ");
}

const shapeOf = (s: z.ZodType) => (s as unknown as { shape: Record<string, z.ZodType> }).shape;

/** Each tag with its attributes and what it is for: the signatures the first pass writes from. */
export function wizardTextTags(opts: { durableRuns: boolean }): string {
  const durable = opts.durableRuns;
  const lines: string[] = [];
  lines.push(
    `<Wizard ${attrs(shapeOf(wizardSchema), new Set(["steps", "version"]), durable)}> — the wizard; its children are the steps, in order.`,
    "",
    "Steps (each takes <Next> children; Text: the key the text inside the tag fills):",
  );
  for (const option of (stepSchema as unknown as { options: z.ZodType[] }).options) {
    const shape = shapeOf(option);
    const type = unwrap(shape.type).schema;
    const name = String(defOf(type).values?.[0]);
    if (name === "wait" && !durable) {
      continue;
    }
    const leaveOut = new Set(["type", "next", STEP_TEXT[name] ?? ""]);
    let children = "";
    if (name === "page") {
      leaveOut.add("fields");
      leaveOut.add("components");
      children = " Children: <Field>, components, Markdown.";
    } else if (name === "agent" || name === "decision") {
      leaveOut.add("output");
      children = " Child: <Output>.";
    }
    const text = STEP_TEXT[name] ? ` Text: ${STEP_TEXT[name]}.` : "";
    lines.push(
      `<${STEP_TAGS[name]} ${attrs(shape, leaveOut, durable)}> — ${STEP_PURPOSE[name] ?? name}.${text}${children}`,
    );
  }
  lines.push(
    "",
    `<Field ${attrs(shapeOf(fieldSchema), new Set(), durable)} /> — a question on a page.`,
    `<Next ${attrs(shapeOf(nextRuleSchema), new Set(), durable)} /> — where the run goes after the step; goto is a step id or "end". Without when or ask: otherwise.`,
    `<Output format="text"|"markdown"|"json"> — an agent step's output; with json, its fields as children:`,
    `  <${Object.keys(OUTPUT_TAGS).join("|")} ${attrs(shapeOf(outputFieldSchema), new Set(["kind"]), durable)} /> — the tag is the field's kind; choice and score need options.`,
    "",
    "Components in a page (attributes are props; a prop may be {name} for an answer, {expression} for a calculation):",
    `  ${SURFACE_COMPONENTS.filter((c) => !NOT_ON_PAGES.has(c))
      .map((c) => {
        const props = (SURFACE_REQUIRED[c] ?? []).filter((p) => p !== "children");
        return `<${c}${props.length ? ` ${props.join(" ")}` : ""}>`;
      })
      .join(" ")}`,
  );
  return lines.join("\n");
}

/** Worked examples in the text form; each parses without cuts and passes the validator. */
export const WIZARD_TEXT_EXAMPLES: readonly string[] = [
  `<Wizard title="Project configurator" lang="en">
<Page id="type" section="Project" title="What do you want to build?">
  <Field id="type" kind="select" label="Project type" required options={["Website", "Shop", "App"]} />
</Page>
<Page id="needs" section="Needs" title="How big is it?">
  <Field id="size" kind="select" label="Size" required look="list" when={type == "Shop"}
    options={["Small – up to 50 products", "Medium – up to 1,000 products", "Large – more than 1,000"]} />
  <Field id="pages" kind="number" label="How many pages?" min={1} max={200} look="stepper" when={type == "Website"} />
</Page>
<Page id="budget" section="Budget" title="What is your budget?">
  <Field id="budget" kind="number" label="Budget" unit="€" required min={2000} max={30000} increment={500} default={8000} look="slider" />
  <Metric label="Per month over a year" value={{"calc": "budget / 12", "as": "number"}} caption={if(budget > 20000, "a large project", "a compact project")} />
  <Field id="name" kind="text" label="Project name (optional)" placeholder="My new project" />
</Page>
<Agent id="concept" section="Result" title="Write the concept">
Write a project concept for a {{type}} with a budget of {{budget}} €: scope, phases, what comes first.
</Agent>
<Result id="done" title="Your concept" deliverables={[{"from": "concept", "label": "Concept", "formats": ["pdf"]}]} />
</Wizard>`,
  `<Wizard title="Report a pothole" description="A photo and the place in, a filed report out." lang="en">
<Page id="what" title="What and where">
  <Field id="photo" kind="image" label="A photo of the problem" required />
  <Field id="where" kind="location" label="Where is it?" required />
  <Field id="kind" kind="select" label="What is it?" required options={["Pothole", "Broken street light", "Something else"]} />
  <Field id="other" kind="text" label="What else?" when={kind == "Something else"} />
</Page>
<Decision id="triage" title="Sort the report">
How urgent is the {{kind}} at {{where}}, judged from the photo?
  <Output>
    <Choice id="urgency" description="How urgent it is" options={["today", "this week", "later"]} />
  </Output>
  <Next when={steps.triage.urgency == "today"} goto="call" />
  <Next goto="letter" />
</Decision>
<Page id="call" title="We call you">
## It looks urgent
We call you back within the hour.
  <Field id="phone" kind="text" label="Your phone number" required />
</Page>
<Generate id="letter" title="Write the confirmation" asset="document" options={{"template": "letter"}}>
The confirmation for the resident: what was reported ({{kind}} at {{where}}), how urgent it is ({{steps.triage}}), and what happens next.
</Generate>
<Review id="check" title="Check the letter" show={["letter"]} edit />
<Result id="done" title="Your confirmation" deliverables={[{"from": "letter", "label": "Confirmation", "formats": ["pdf"]}]}>
Thank you. We have your report.
</Result>
</Wizard>`,
];
