import {
  allFields,
  type Condition,
  listRef,
  type NextRule,
  type WizardDefinition,
  whenCalc,
  whenText,
} from "./definition.js";
import { type ItemFormat, type MarketplaceLang, marketLabel } from "./marketplace.js";

// What a marketplace entry shows of its wizard: the flow in steps, and what a person takes along
// at the end. The app's dialog and the marketplace's pages read the same.

/** A step as the flow shows it: what happens there, not how — and where the flow branches. */
export interface OutlineStep {
  id: string;
  type: string;
  title: string;
  /** What a generate step makes. */
  asset?: string;
  /** A widget step that renders a video. */
  video?: boolean;
  /** Where the flow goes on instead of the next step, and when. `to` is a step's id or `end`. */
  branches?: { to: string; when: string }[];
}

/** What a person takes along at the end: each thing by its name, with the files it comes as. */
export interface EntryResult {
  title: string;
  kind: ItemFormat;
  formats: string[];
}

/** What an entry's wizard is made of, as a reader sees it. */
export interface WizardOutline {
  description: string;
  outline: OutlineStep[];
  results: EntryResult[];
  /** The workspace files it starts with. */
  files: string[];
}

/** When a branch is taken, in words: the field's label stands for its id. */
function condition(definition: WizardDefinition, rule: NextRule, lang: MarketplaceLang): string {
  if (rule.ask) {
    return rule.ask;
  }
  if (rule.when === undefined) {
    return marketLabel("outline", "otherwise", lang);
  }
  const calc = whenCalc(rule.when);
  if (calc !== null) {
    return calc;
  }
  return whenText(rule.when, (c) => conditionText(definition, c, lang), {
    and: (first, second) => marketLabel("outline", "and", lang, { first, second }),
    or: (first, second) => marketLabel("outline", "or", lang, { first, second }),
    not: (condition) => marketLabel("outline", "not", lang, { condition }),
  });
}

function conditionText(definition: WizardDefinition, c: Condition, lang: MarketplaceLang): string {
  const { field, op, value } = c;
  const name =
    allFields(definition).find((f) => f.id === field)?.label ?? field.split(".").pop() ?? field;
  // A toggle is often labelled "Mit …" already.
  const bare = name.replace(/^(mit|with)\s+/i, "");
  const without = marketLabel("outline", "without", lang, { name: bare });
  const withIt = marketLabel("outline", "with", lang, { name: bare });
  // A toggle reads better as with / without than as "= true".
  if (typeof value === "boolean" && (op === "eq" || op === "ne")) {
    return (op === "eq") === value ? withIt : without;
  }
  const shown = Array.isArray(value) ? value.join(" / ") : String(value ?? "");
  switch (op) {
    case "eq":
    case "in":
      return `${name}: ${shown}`;
    case "ne":
    case "notIn":
      return `${name} ≠ ${shown}`;
    case "exists":
      return withIt;
    case "notExists":
    case "falsy":
      return without;
    case "truthy":
      return withIt;
    case "gt":
      return `${name} > ${shown}`;
    case "gte":
      return `${name} ≥ ${shown}`;
    case "lt":
      return `${name} < ${shown}`;
    case "lte":
      return `${name} ≤ ${shown}`;
    case "contains":
      return marketLabel("outline", "contains", lang, { name, value: shown });
  }
}

export const outlineOf = (definition: WizardDefinition, lang: MarketplaceLang): OutlineStep[] =>
  definition.steps.map((s) => ({
    id: s.id,
    type: s.type,
    title: s.title,
    ...(s.type === "generate" ? { asset: s.asset } : {}),
    ...(s.type === "widget" && s.video ? { video: true } : {}),
    ...(s.next?.length
      ? {
          branches: s.next.map((rule) => ({
            to: rule.goto,
            when: condition(definition, rule, lang),
          })),
        }
      : {}),
  }));

/** What a step hands over, as the marketplace sorts results. */
function resultKind(definition: WizardDefinition, from: string): ItemFormat {
  if (listRef(from)) {
    return "table";
  }
  const step = definition.steps.find((s) => s.id === from);
  if (step?.type === "generate") {
    return step.asset === "voice" ? "audio" : step.asset;
  }
  if (step?.type === "widget") {
    return step.video ? "video" : "dashboard";
  }
  if (step?.type === "motion-graphics") {
    return "video";
  }
  return step?.type === "decision" || (step?.type === "agent" && step.output.format === "json")
    ? "table"
    : "text";
}

export function resultsOf(definition: WizardDefinition): EntryResult[] {
  const out: EntryResult[] = [];
  for (const step of definition.steps) {
    if (step.type !== "result") {
      continue;
    }
    for (const d of step.deliverables) {
      const list = listRef(d.from);
      const title =
        d.label ??
        (list
          ? definition.lists?.find((l) => l.id === list)?.title
          : definition.steps.find((s) => s.id === d.from)?.title) ??
        d.from;
      if (!out.some((r) => r.title === title)) {
        out.push({ title, kind: resultKind(definition, d.from), formats: d.formats });
      }
    }
  }
  return out;
}

/** An entry's wizard as a reader sees it, in a language. */
export function wizardOutline(
  definition: WizardDefinition,
  files: string[],
  lang: MarketplaceLang,
): WizardOutline {
  return {
    description: definition.description,
    outline: outlineOf(definition, lang),
    results: resultsOf(definition),
    files,
  };
}
