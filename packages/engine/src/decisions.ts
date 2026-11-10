/**
 * What a run decides on its way, through the run's services: which of a step's `ask` rules holds,
 * and which decided fields a page asks. Also what a page knows besides the person's input.
 */
import type { ChoiceAnswer, DecisionQuestion } from "@engenty/wizards-shared/decision";
import { marginOf } from "@engenty/wizards-shared/decision";
import {
  branchValues,
  type CardOption,
  cardsFromData,
  conditionMatches,
  type FormStep,
  followRules,
  formNeeds,
  isDecidedField,
  MAX_SHOWN_FIELDS,
  optionsFromData,
  type Step,
  type WizardDefinition,
  whenCalc,
  whenValue,
} from "@engenty/wizards-shared/definition";
import type { RunState } from "@engenty/wizards-shared/run";
import type { RunServices } from "@engenty/wizards-shared/run-services";
import type { ListDef, ListRow } from "@engenty/wizards-shared/store";
import type { RunHost } from "./host.js";
import type { FormContext } from "./input.js";
import { prompt } from "./prompts.js";
import { answersAsText } from "./template.js";

/** A decided branch is taken only when its pick leads the runner-up by this much. */
const BRANCH_MARGIN = 0.1;

/** What a decision about the run reads: the person's answers and what the steps made so far. */
function runSummary(def: WizardDefinition, state: RunState): Record<string, unknown> {
  const results: Record<string, string> = {};
  for (const step of def.steps) {
    const out = state.outputs[step.id];
    const text = out?.text ?? (out?.json === undefined ? "" : JSON.stringify(out.json));
    if (text) {
      results[step.title] = text.slice(0, 6000);
    }
  }
  return { answers: answersAsText({ def, state, brand: {} }), results };
}

/** Rows per stored list, for rules that read `lists.<list>.count`. */
export async function listCounts(
  def: WizardDefinition,
  data: RunServices["data"],
): Promise<Record<string, number>> {
  return def.lists?.length ? data.counts() : {};
}

/** The wizard's lists with the rows the run's holder may read, by list id. */
async function storedLists(
  def: WizardDefinition,
  data: RunServices["data"],
): Promise<Record<string, { def: ListDef; rows: ListRow[] }>> {
  const out: Record<string, { def: ListDef; rows: ListRow[] }> = {};
  for (const list of def.lists ?? []) {
    out[list.id] = await data.rows(list.id);
  }
  return out;
}

/**
 * The decision over a step's open `ask` rules: one choice among their statements and "none", by
 * its index in `next`, null for none. Kept in `state`; a pick that does not lead clearly (where
 * there are probabilities) is none.
 */
export async function decideBranch(
  host: RunHost,
  step: Step,
  state: RunState,
  signal: AbortSignal,
): Promise<number | null> {
  const outcome = followRules(host.def, step.id, {}, state.loops);
  const rules = outcome.kind === "decide" ? outcome.rules : [];
  const criteria: Record<string, string> = {};
  for (const i of rules) {
    criteria[`r${i}`] = step.next?.[i]?.ask ?? "";
  }
  criteria.none = prompt("step", "decide.branch_none");
  await host.event(step.id, "info", { code: "deciding" });
  const decision = await host.services.models.decide(
    {
      stepId: step.id,
      state: runSummary(host.def, state),
      questions: {
        next: {
          type: "choice",
          instructions: prompt("step", "decide.branch"),
          criteria,
        } satisfies DecisionQuestion,
      },
    },
    signal,
  );
  const answer = decision.answers.next as ChoiceAnswer;
  const margin = marginOf(answer);
  const pick = margin !== null && margin < BRANCH_MARGIN ? "none" : answer.choice;
  const rule = pick === "none" ? null : Number(pick.slice(1));
  state.decisions = {
    ...state.decisions,
    [step.id]: {
      rule,
      source: decision.source,
      ...(answer.probabilities ? { probabilities: answer.probabilities } : {}),
      at: new Date(host.clock.now()).toISOString(),
    },
  };
  return rule;
}

/**
 * The decided fields (`ask`, `group`) of a page a decision keeps, in one call as the run reaches
 * the page. A field whose condition on earlier data already fails is not asked about. With the
 * fields always shown, at most MAX_SHOWN_FIELDS appear.
 */
export async function decideFields(
  host: RunHost,
  page: FormStep,
  state: RunState,
  signal: AbortSignal,
): Promise<string[]> {
  const values = branchValues(
    state.values,
    state.outputs,
    await listCounts(host.def, host.services.data),
  );
  const own = new Set(page.fields.map((f) => f.id));
  const possible = page.fields.filter(
    (f) =>
      isDecidedField(f) &&
      // What this page answers is not known yet: a condition on it may still hold.
      (whenCalc(f.when) !== null ||
        whenValue(f.when, (c) => (own.has(c.field) ? null : conditionMatches(c, values))) !==
          false),
  );
  const questions: Record<string, DecisionQuestion> = {};
  for (const f of possible.filter((f) => f.ask)) {
    questions[`f_${f.id}`] = {
      type: "noul",
      instructions: `Should the page ask "${f.label}"? It is asked when this holds: ${f.ask ?? ""}`,
    };
  }
  for (const g of page.groups ?? []) {
    const members = possible.filter((f) => f.group === g.id);
    if (members.length) {
      questions[`g_${g.id}`] = {
        type: "choice",
        instructions: g.instructions,
        criteria: {
          ...Object.fromEntries(
            members.map((f) => [f.id, f.help ? `${f.label} — ${f.help}` : f.label]),
          ),
          ...(g.optional ? { none: "None of these." } : {}),
        },
      };
    }
  }
  if (!Object.keys(questions).length) {
    return [];
  }
  await host.event(page.id, "info", { code: "choosingFields" });
  const decision = await host.services.models.decide(
    { stepId: page.id, state: runSummary(host.def, state), questions },
    signal,
  );
  const kept = new Set<string>();
  for (const [name, answer] of Object.entries(decision.answers)) {
    if (answer.type === "noul" && answer.noul >= 0.5) {
      kept.add(name.slice(2));
    } else if (answer.type === "choice" && answer.choice !== "none") {
      kept.add(answer.choice);
    }
  }
  const room = MAX_SHOWN_FIELDS - page.fields.filter((f) => !isDecidedField(f)).length;
  return page.fields
    .filter((f) => isDecidedField(f) && kept.has(f.id))
    .slice(0, Math.max(0, room))
    .map((f) => f.id);
}

/**
 * What a page knows besides the person's input: what its fields' `when` read from before the
 * page and the choices its `optionsFrom` fields find in the run.
 */
export async function formContextOf(
  def: WizardDefinition,
  data: RunServices["data"],
  step: FormStep,
  state: RunState,
): Promise<Required<FormContext>> {
  const needs = formNeeds(step.fields);
  const sourced = step.fields.filter((f) => f.optionsFrom);
  const decided = step.fields.some(isDecidedField) ? (state.pages?.[step.id]?.shown ?? []) : [];
  if (!needs.length && !sourced.length) {
    return { known: {}, options: {}, cards: {}, decided };
  }
  const all = branchValues(state.values, state.outputs, await listCounts(def, data));
  const known = Object.fromEntries(needs.map((ref) => [ref, all[ref]]));
  const lists = sourced.some((f) => f.optionsFrom?.startsWith("lists."))
    ? await storedLists(def, data)
    : {};
  const options: Record<string, string[]> = {};
  const cards: Record<string, CardOption[]> = {};
  for (const field of sourced) {
    const found = optionsFromData(field.optionsFrom ?? "", state.outputs, lists, field.cards);
    if (found.length) {
      options[field.id] = found;
    }
    if (field.cards) {
      const drawn = cardsFromData(field.optionsFrom ?? "", state.outputs, field.cards);
      if (drawn.length) {
        cards[field.id] = drawn;
      }
    }
  }
  return { known, options, cards, decided };
}
