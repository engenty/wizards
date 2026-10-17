import {
  isDecidedField,
  isDecisionStep,
  type Step,
  type TextClass,
  type WizardDefinition,
} from "@engenty-wizards/shared/definition";
import type { RunEstimate, StepEstimate } from "@engenty-wizards/shared/run";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { mostAlongOnePath } from "../engine/requirements.js";
import { type ClassPrice, classCatalog, type GatewayCatalog } from "../models.js";
import { MICROS_PER_CREDIT } from "./credits.js";

/**
 * What a run will cost, in credits, before it starts. A step that has run five times on this
 * version is estimated from its measurements (median, and the 90th percentile as the amount to
 * hold); until then a formula per step type and model class stands in.
 */
const MIN_SAMPLES = 5;
const SAMPLE_RUNS = 40;

/** Tokens a text call of each shape takes, as [input, output]. */
const TOKENS = {
  plain: [8_000, 1_500],
  tools: [60_000, 4_000],
  browser: [250_000, 8_000],
  document: [6_000, 8_000],
  prompt: [2_000, 300],
  structure: [4_000, 1_000],
  decision: [1_500, 100],
} as const;

function textCredits(price: ClassPrice | null | undefined, [input, output]: readonly number[]) {
  if (!price) {
    return 0;
  }
  return (
    (input / 1e6) * (price.inputCreditsPerMTok ?? 0) +
    (output / 1e6) * (price.outputCreditsPerMTok ?? 0)
  );
}

/** A step's own work, and one decision where `ask` branches or a page's fields are decided. */
function formula(step: Step, catalog: GatewayCatalog): number {
  const decides =
    step.next?.some((r) => r.ask) || (step.type === "page" && step.fields.some(isDecidedField));
  const decision = decides ? textCredits(catalog.classes.classifier, TOKENS.decision) : 0;
  return decision + stepFormula(step, catalog);
}

function stepFormula(step: Step, catalog: GatewayCatalog): number {
  const cls = (c: TextClass) => catalog.classes[c];
  if (step.type === "agent") {
    // A call runs one tool and no model: nothing to pay for.
    if (step.call) {
      return 0;
    }
    // A decision is one small call to the classifier class.
    if (isDecisionStep(step)) {
      return textCredits(cls("classifier"), TOKENS.decision);
    }
    const shape = step.tools.includes("browser")
      ? TOKENS.browser
      : step.tools.length || step.mcp?.length || step.connections?.length
        ? TOKENS.tools
        : TOKENS.plain;
    // A step with `each` runs once per entry; until it has run, three stand in.
    let credits = textCredits(cls(step.model ?? "high"), shape) * (step.each ? 3 : 1);
    if (step.tools.includes("web_search")) {
      credits += 4 * catalog.webSearchCredits;
    }
    if (step.tools.includes("image")) {
      credits += catalog.classes.image?.creditsPerImage ?? 0;
    }
    if (step.output.format === "json") {
      credits += textCredits(cls("classifier"), TOKENS.structure);
    }
    if (step.output.surface === true) {
      credits += textCredits(cls("standard"), TOKENS.structure);
    }
    return credits;
  }
  if (step.type === "generate") {
    if (step.asset === "image") {
      return (
        (catalog.classes.image?.creditsPerImage ?? 0) + textCredits(cls("standard"), TOKENS.prompt)
      );
    }
    if (step.asset === "video") {
      const seconds = Math.min(Math.max(Math.round(step.options?.duration ?? 8), 4), 10);
      return (
        seconds * (catalog.classes.video?.creditsPerSecond ?? 0) +
        textCredits(cls("standard"), TOKENS.prompt)
      );
    }
    return textCredits(cls(step.model ?? "high"), TOKENS.document);
  }
  return 0;
}

/**
 * What a run of a definition costs by the formula alone — before anyone has run it — along its
 * most expensive way that avoids the steps in `closed`.
 */
export function formulaEstimate(
  definition: WizardDefinition,
  catalog: GatewayCatalog,
  closed?: Set<string>,
): { credits: number; high: number } {
  const credits = mostAlongOnePath(definition, (step) => formula(step, catalog), closed);
  return { credits: round(credits), high: Math.ceil(credits * 2) };
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

/** Credits each step cost in the latest finished runs of this wizard version. */
async function measurements(
  wizardId: string,
  version: number | null,
): Promise<Map<string, number[]>> {
  const runs = await db
    .select({ id: schema.run.id })
    .from(schema.run)
    .where(
      and(
        eq(schema.run.wizardId, wizardId),
        eq(schema.run.status, "done"),
        version === null ? isNull(schema.run.version) : eq(schema.run.version, version),
      ),
    )
    .orderBy(desc(schema.run.createdAt))
    .limit(SAMPLE_RUNS);
  const out = new Map<string, number[]>();
  if (!runs.length) {
    return out;
  }
  const costs = await db
    .select()
    .from(schema.runCost)
    .where(
      inArray(
        schema.runCost.runId,
        runs.map((r) => r.id),
      ),
    );
  for (const c of costs) {
    const list = out.get(c.stepId) ?? [];
    list.push(c.micros / MICROS_PER_CREDIT);
    out.set(c.stepId, list);
  }
  return out;
}

const round = (credits: number) => Math.round(credits * 10) / 10;

/**
 * What a run will cost and how much to hold, along its most expensive way: steps on branches
 * that exclude each other are not added up. `closed`: steps the run cannot take here.
 */
export async function estimateRun(
  wizardId: string,
  version: number | null,
  definition: WizardDefinition,
  closed?: Set<string>,
): Promise<RunEstimate> {
  const catalog = await classCatalog();
  if (!catalog) {
    // A runtime that resolves models itself has no credits to estimate in.
    return { available: false, credits: 0, reserve: 0, steps: {} };
  }
  const measured = await measurements(wizardId, version);
  const steps: Record<string, StepEstimate> = {};
  for (const step of definition.steps) {
    const samples = (measured.get(step.id) ?? []).sort((a, b) => a - b);
    let estimate: StepEstimate;
    if (samples.length >= MIN_SAMPLES) {
      estimate = {
        credits: round(percentile(samples, 0.5)),
        high: round(percentile(samples, 0.9)),
        measured: true,
      };
    } else {
      const value = formula(step, catalog);
      if (value <= 0) {
        continue;
      }
      // A formula knows little: hold twice as much as it says.
      estimate = { credits: round(value), high: round(value * 2), measured: false };
    }
    steps[step.id] = estimate;
  }
  const credits = mostAlongOnePath(definition, (s) => steps[s.id]?.credits ?? 0, closed);
  const reserve = mostAlongOnePath(definition, (s) => steps[s.id]?.high ?? 0, closed);
  return { available: true, credits: round(credits), reserve: Math.ceil(reserve), steps };
}
