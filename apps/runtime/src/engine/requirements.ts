import {
  type Condition,
  classIdOf,
  conditionMatches,
  conditionsOf,
  isDecidedField,
  isDecisionStep,
  isOtherwise,
  type Lang,
  MODEL_CLASSES,
  type ModelClass,
  type NextRule,
  type PageStep,
  type Step,
  type TextClass,
  textClassOf,
  type WizardDefinition,
} from "@engenty/wizards-shared/definition";
import {
  type Capability,
  closedChoicesFor,
  openValue,
  otherwiseIndex,
  unavoidableFrom,
  unavoidableSteps,
} from "@engenty/wizards-shared/fit";

import { CLASS_NAMES } from "@engenty/wizards-shared/providers";
import type {
  ClosedChoice,
  MissingModel,
  NoteGap,
  RunNote,
  Said,
} from "@engenty/wizards-shared/run";
import { note, saidText } from "@engenty/wizards-shared/run";
import {
  MAKER_COMPANIES,
  MAKER_FAMILIES,
  type ModelTier,
  splitClassId,
} from "@engenty/wizards-shared/tiers";
import { classProblem, currentTier, motionClient, tierRefusal } from "../models.js";

// The steps every run passes through, and the choices that lead around a missing model, are
// pure and shared (packages/shared/src/fit.ts): the standalone check uses the same.
export { openValue, unavoidableFrom, unavoidableSteps };

/**
 * What a wizard needs of the models before a run starts: each class its steps call, and whether
 * this runtime can serve it. A step every run passes through blocks the start when its class is
 * missing; a step behind a branch only warns, since the person may choose around it.
 */

/**
 * The classes a step calls, as ../engine/steps.ts and ../media/generate.ts call them — and the
 * classifier where a decision picks its next step or a page's fields.
 */
export function stepClasses(step: Step): ModelClass[] {
  const own = ownClasses(step);
  const decides =
    step.next?.some((r) => r.ask) || (step.type === "page" && step.fields.some(isDecidedField));
  return decides && !own.includes("classifier") ? [...own, "classifier"] : own;
}

function ownClasses(step: Step): ModelClass[] {
  switch (step.type) {
    case "agent": {
      // A call runs one tool and no model.
      if (step.call) {
        return [];
      }
      if (isDecisionStep(step)) {
        return ["classifier"];
      }
      const classes: ModelClass[] = [textClassOf(step.model ?? "standard")];
      if (step.tools.includes("image")) {
        classes.push("image");
      }
      if (step.output.format === "json") {
        classes.push("classifier");
      }
      if (step.output.surface === true && !classes.includes("low")) {
        classes.push("low");
      }
      return classes;
    }
    case "generate":
      switch (step.asset) {
        case "image":
          return ["low", "image"];
        case "video":
          return ["low", "video"];
        case "voice":
          return ["speech"];
        default:
          return [textClassOf(step.model ?? "standard")];
      }
    case "motion-graphics":
      return [textClassOf(step.model ?? "low")];
    case "page":
      // A voice note the page asks for is listened to before the next step reads it.
      return step.fields.some((f) => f.kind === "audio" && f.required) ? ["audio"] : [];
    default:
      // Reviews (they redo a generate step counted already), widgets, results.
      return [];
  }
}

/** The classes a step can do without: a voice note the person may leave out. */
export function optionalStepClasses(step: Step): ModelClass[] {
  return step.type === "page" &&
    step.fields.some((f) => f.kind === "audio" && !f.required) &&
    !stepClasses(step).includes("audio")
    ? ["audio"]
    : [];
}

/** What the branches taken so far say about an answer. */
interface Known {
  is?: string;
  not: string[];
  filled?: boolean;
}
type Facts = Record<string, Known>;

/** Whether a rule matches given what is known: true, false, or null = it may go either way. */
function ruleHolds(rule: NextRule, facts: Facts): boolean | null {
  // A decision may go either way.
  if (rule.ask) {
    return null;
  }
  let all: boolean | null = true;
  for (const c of conditionsOf(rule.when)) {
    const holds = conditionHolds(c, facts);
    if (holds === false) {
      return false;
    }
    if (holds === null) {
      all = null;
    }
  }
  return all;
}

function conditionHolds(c: Condition, facts: Facts): boolean | null {
  const k = facts[c.field];
  const value = c.value;
  switch (c.op) {
    case "empty":
      return k?.filled === undefined ? (k?.is !== undefined ? false : null) : !k.filled;
    case "notEmpty":
      return k?.filled === undefined ? (k?.is !== undefined ? true : null) : k.filled;
    case "equals":
      return k?.is !== undefined
        ? k.is === String(value)
        : k?.not.includes(String(value))
          ? false
          : null;
    case "notEquals":
      return k?.is !== undefined
        ? k.is !== String(value)
        : k?.not.includes(String(value))
          ? true
          : null;
    case "in": {
      const list = Array.isArray(value) ? value.map(String) : [];
      if (k?.is !== undefined) {
        return list.includes(k.is);
      }
      return list.every((v) => k?.not.includes(v)) ? false : null;
    }
    case "gt":
    case "lt":
    case "contains":
      if (k?.is !== undefined) {
        return conditionMatches(c, { [c.field]: k.is });
      }
      return k?.filled === false ? false : null;
  }
}

/**
 * What is known once a rule did (`held`) or did not match. A rule of several conditions that
 * did not match says nothing about any one of them.
 */
function learn(rule: NextRule, held: boolean, facts: Facts): Facts {
  if (rule.ask) {
    return facts;
  }
  const conditions = conditionsOf(rule.when);
  if (held) {
    return conditions.reduce((known, c) => learnCondition(c, true, known), facts);
  }
  return conditions.length === 1 ? learnCondition(conditions[0], false, facts) : facts;
}

function learnCondition(c: Condition, held: boolean, facts: Facts): Facts {
  const field = c.field;
  const k: Known = { ...(facts[field] ?? { not: [] }) };
  k.not = [...k.not];
  const value = String(c.value);
  const op = c.op;
  if ((op === "equals" && held) || (op === "notEquals" && !held)) {
    k.is = value;
    k.filled = true;
  } else if ((op === "equals" && !held) || (op === "notEquals" && held)) {
    k.not.push(value);
  } else if (op === "in" && !held && Array.isArray(c.value)) {
    k.not.push(...c.value.map(String));
  } else if (op === "empty" || op === "notEmpty") {
    k.filled = (op === "notEmpty") === held;
  } else if ((op === "gt" || op === "lt" || op === "contains") && held) {
    k.filled = true;
  }
  return { ...facts, [field]: k };
}

/**
 * The most a run can add up to along one way through the wizard. A branch remembers what it
 * implies of the answers, so ways that contradict themselves (the 720p clips and the 480p
 * ones) are not added up. Steps in `closed` are not passed (no model for them here); where that
 * leaves no way to the end, they count again. A branch back to an earlier step is not followed
 * twice.
 */
export function mostAlongOnePath(
  def: WizardDefinition,
  cost: (step: Step) => number,
  closed: Set<string> = new Set(),
): number {
  const index = new Map(def.steps.map((s, i) => [s.id, i]));
  const end = def.steps.length;
  const walk = (avoid: Set<string>): number | null => {
    const best = (i: number, facts: Facts, seen: Set<number>): number | null => {
      if (i >= end) {
        return 0;
      }
      const step = def.steps[i];
      if (i < 0 || avoid.has(step.id) || seen.has(i)) {
        return null;
      }
      const passed = new Set(seen).add(i);
      let most: number | null = null;
      const consider = (j: number, known: Facts) => {
        const rest = best(j, known, passed);
        if (rest !== null && (most === null || rest > most)) {
          most = rest;
        }
      };
      // The rules are tried in order; the first that matches decides.
      let known = facts;
      let decided = false;
      for (const rule of step.next ?? []) {
        if (isOtherwise(rule)) {
          continue;
        }
        const holds = ruleHolds(rule, known);
        if (holds === false) {
          continue;
        }
        consider(
          rule.goto === "end" ? end : (index.get(rule.goto) ?? -1),
          learn(rule, true, known),
        );
        if (holds === true) {
          decided = true;
          break;
        }
        known = learn(rule, false, known);
      }
      if (!decided) {
        consider(otherwiseIndex(def, i, index), known);
      }
      return most === null ? null : most + cost(step);
    };
    return best(0, {}, new Set());
  };
  return walk(closed) ?? walk(new Set()) ?? def.steps.reduce((sum, s) => sum + cost(s), 0);
}

/** The steps that call a class this runtime cannot serve, or the organization's tier doesn't offer. */
export async function stepsWithoutModel(def: WizardDefinition): Promise<Set<string>> {
  const missing = await missingClasses();
  const tier = await currentTier();
  return new Set(
    def.steps
      .filter((s) =>
        stepClasses(s).some(
          (cls) => missing.has(cls) || (tier && tierProblem(tier, tierClassOf(s, cls))),
        ),
      )
      .map((s) => s.id),
  );
}

/**
 * The class a step asks the gateway for, as the tier names it: `anthropic/highest` where the
 * step names a maker for its own text class, else the class.
 */
export function tierClassOf(step: Step, cls: ModelClass): string {
  if (!("maker" in step) || !step.maker || cls === "classifier") {
    return cls;
  }
  const own = step.model ?? (cls as TextClass);
  return textClassOf(own) === cls ? classIdOf({ model: own, maker: step.maker }, "standard") : cls;
}

/** What a tier's class id makes, as a note's gap: "videos", "Claude · High". */
export function tierClassWhat(id: string): NoteGap {
  const { maker, cls } = splitClassId(id);
  const name = cls === "highest" ? "Highest" : (CLASS_NAMES as Record<string, string>)[cls];
  if (maker) {
    return `${MAKER_FAMILIES[maker]} · ${name ?? cls}`;
  }
  switch (cls) {
    case "image":
      return note("makesImages");
    case "video":
      return note("makesVideos");
    case "speech":
      return note("makesSpeech");
    case "audio":
      return note("makesVoiceNotes");
    case "classifier":
      return note("makesDecisions");
    case "embedding":
      return note("makesSearch");
    default:
      return name ?? cls;
  }
}

/**
 * What a step the gateway refused for the organization's tier or policy says: the class and the
 * tier, or that the admins haven't approved it. Null for any other failure.
 */
export async function tierRefusalSaid(err: unknown): Promise<RunNote | null> {
  const refused = tierRefusal(err);
  if (!refused) {
    return null;
  }
  const what = refused.cls ? tierClassWhat(refused.cls) : note("thisModel");
  if (refused.type === "not_in_policy") {
    return note("notInPolicy", { what });
  }
  const tier = await currentTier();
  const problem =
    (tier && refused.cls ? tierProblem(tier, refused.cls) : null) ??
    note("tierOffersNo", { tier: refused.tier ?? tier?.name ?? "", what });
  return note("tierRefused", { problem });
}

const MASKED_KINDS = {
  person: "maskedPerson",
  email: "maskedEmail",
  phone: "maskedPhone",
  iban: "maskedIban",
  id: "maskedId",
  address: "maskedAddress",
  contract: "maskedContract",
  term: "maskedTerm",
} as const;

/** The Log line of what the gateway masked in a step's calls, from its counts per kind. */
export function maskedNote(counts: Record<string, number>): RunNote {
  const kinds: RunNote[] = [];
  let other = 0;
  for (const [kind, count] of Object.entries(counts)) {
    const code = MASKED_KINDS[kind as keyof typeof MASKED_KINDS];
    if (code) {
      kinds.push(note(code, { count }));
    } else {
      other += count;
    }
  }
  if (other) {
    kinds.push(note("maskedOther", { count: other }));
  }
  const count = Object.values(counts).reduce((sum, n) => sum + n, 0);
  return note("masked", { count, kinds });
}

/** Why the organization's tier doesn't serve a class; null where it does. */
export function tierProblem(tier: ModelTier, id: string): RunNote | null {
  const entry = tier.classes[id];
  const what = tierClassWhat(id);
  if (!entry) {
    return note("tierOffersNo", { tier: tier.name, what });
  }
  if (entry.model !== null) {
    return null;
  }
  const { maker } = splitClassId(id);
  if (entry.reason === "maker" && maker) {
    return note("tierLeavesOutMaker", { tier: tier.name, maker: MAKER_COMPANIES[maker] });
  }
  const model = entry.name ?? note("thisModel");
  const why =
    entry.reason === "region"
      ? note("tierWhyRegion")
      : entry.reason === "retention"
        ? note("tierWhyRetention", { model })
        : entry.reason === "training"
          ? note("tierWhyTraining", { model })
          : note("tierWhyUnbound");
  return note("tierOffersNoWhy", { tier: tier.name, what, why });
}

/** A missing class whose problem is said in both languages, until it is read in one. */
export type MissingModelSaid = Omit<MissingModel, "problem"> & { problem: Said };

/** The classes this wizard needs that this runtime cannot serve, in a language; empty = every step can run. */
export async function missingModels(
  def: WizardDefinition,
  lang: Lang = "en",
): Promise<MissingModel[]> {
  return (await missingModelsSaid(def)).map((m) => ({ ...m, problem: saidText(m.problem, lang) }));
}

/** The classes this wizard needs that this runtime cannot serve; empty = every step can run. */
export async function missingModelsSaid(def: WizardDefinition): Promise<MissingModelSaid[]> {
  const unavoidable = unavoidableSteps(def);
  const tier = await currentTier();
  const needs = new Map<ModelClass, { step: Step; required: boolean }[]>();
  // What the organization's tier doesn't offer is missing whatever this runtime could serve.
  const outside = new Map<string, MissingModelSaid>();
  const use = (step: Step, cls: ModelClass, required: boolean) => {
    const id = tier ? tierClassOf(step, cls) : cls;
    const problem = tier ? tierProblem(tier, id) : null;
    if (!problem) {
      needs.set(cls, [...(needs.get(cls) ?? []), { step, required }]);
      return;
    }
    const entry = outside.get(id) ?? { cls, tierClass: id, problem, steps: [], blocking: false };
    if (!entry.steps.some((s) => s.id === step.id)) {
      entry.steps.push({ id: step.id, title: step.title });
    }
    entry.blocking ||= required && unavoidable.has(step.id);
    outside.set(id, entry);
  };
  for (const step of def.steps) {
    for (const cls of new Set(stepClasses(step))) {
      use(step, cls, true);
    }
    for (const cls of optionalStepClasses(step)) {
      use(step, cls, false);
    }
  }
  const missing: MissingModelSaid[] = [...outside.values()];
  // A video runs on an installed client only, whatever serves its class otherwise.
  for (const step of def.steps) {
    if (step.type !== "motion-graphics") {
      continue;
    }
    const cls = textClassOf(step.model ?? "low");
    const found = await motionClient(cls);
    if ("problem" in found) {
      missing.push({
        cls,
        problem: found.problem,
        steps: [{ id: step.id, title: step.title }],
        blocking: unavoidable.has(step.id),
      });
    }
  }
  for (const [cls, uses] of needs) {
    const problem = await classProblem(cls);
    if (problem) {
      missing.push({
        cls,
        problem,
        steps: uses.map(({ step }) => ({ id: step.id, title: step.title })),
        blocking: uses.some(({ step, required }) => required && unavoidable.has(step.id)),
      });
    }
  }
  return missing;
}

/**
 * The message a run that cannot start gives, naming the steps and why. Classes with the same
 * problem (a step that thinks and writes on one client that is not installed) say it once, and
 * name each of their steps once.
 */
export function blockingMessage(missing: MissingModelSaid[]): RunNote | null {
  const byProblem = new Map<string, { problem: Said; steps: Map<string, string> }>();
  for (const m of missing) {
    if (!m.blocking) {
      continue;
    }
    const key = JSON.stringify(m.problem);
    const entry = byProblem.get(key) ?? { problem: m.problem, steps: new Map() };
    for (const s of m.steps) {
      entry.steps.set(s.id, s.title);
    }
    byProblem.set(key, entry);
  }
  if (!byProblem.size) {
    return null;
  }
  return [...byProblem.values()]
    .map(({ problem, steps }) =>
      note("blockedSteps", {
        steps: [...steps.values()].map((text) => note("quoted", { text })),
        problem,
      }),
    )
    .reduce((first, second) => note("joined", { first, second }));
}

/** The class a marketplace capability stands for; the rest need no model of their own. */
const CAPABILITY_CLASS: Partial<Record<Capability, ModelClass>> = {
  text: "low",
  documents: "low",
  image: "image",
  video: "video",
  speech: "speech",
  listening: "audio",
};

/** The capabilities this runtime has no model for. */
export async function missingCapabilities(): Promise<Set<Capability>> {
  const missing = new Set<Capability>();
  for (const [capability, cls] of Object.entries(CAPABILITY_CLASS)) {
    if (await classProblem(cls)) {
      missing.add(capability as Capability);
    }
  }
  if ("problem" in (await motionClient("low"))) {
    missing.add("motion-graphics");
  }
  return missing;
}

/** The classes this runtime cannot serve. */
export async function missingClasses(): Promise<Set<ModelClass>> {
  const missing = new Set<ModelClass>();
  for (const cls of MODEL_CLASSES) {
    if (await classProblem(cls)) {
      missing.add(cls);
    }
  }
  return missing;
}

/**
 * The capabilities of a wizard that only some of its paths need: without them it still starts,
 * on the other paths (animated stills instead of video clips, no voice-over).
 */
export function optionalCapabilities(def: WizardDefinition): Set<Capability> {
  const unavoidable = unavoidableSteps(def);
  const required = new Set<ModelClass>();
  const any = new Set<ModelClass>();
  for (const step of def.steps) {
    for (const cls of stepClasses(step)) {
      any.add(cls);
      if (unavoidable.has(step.id)) {
        required.add(cls);
      }
    }
    for (const cls of optionalStepClasses(step)) {
      any.add(cls);
    }
  }
  const optional = new Set<Capability>();
  for (const [capability, cls] of Object.entries(CAPABILITY_CLASS)) {
    if (any.has(cls) && !required.has(cls)) {
      optional.add(capability as Capability);
    }
  }
  return optional;
}

/**
 * The answers on a page that lead to a step this runtime has no model for: with them the run
 * would stop there, after what came before was paid for. The answers given already count; the
 * page's other fields may still go either way. A choice whose every value leads there is left
 * open: the run cannot go around it, and the start already warned. A voice note nothing here
 * can listen to is closed as a whole (no values).
 */
export async function closedChoices(
  def: WizardDefinition,
  step: PageStep,
  values: Record<string, unknown>,
): Promise<Record<string, ClosedChoice>> {
  const missing = await missingClasses();
  if (!missing.size) {
    return {};
  }
  return closedChoicesFor(
    def,
    step,
    values,
    (s) => stepClasses(s).filter((cls) => missing.has(cls)),
    (field) => (missing.has("audio") && field.kind === "audio" ? ["audio"] : null),
  );
}
