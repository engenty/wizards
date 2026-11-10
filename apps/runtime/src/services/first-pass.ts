import { WIZARD_TEXT_EXAMPLES, wizardTextTags } from "@engenty/wizards-shared/catalog-prompt";
import {
  type Lang,
  stepSchema,
  type ValidationIssue,
  wizardSchema,
} from "@engenty/wizards-shared/definition";
import { parseWizardText, type TextCut } from "@engenty/wizards-shared/wizard-text";
import { streamText } from "ai";
import { subscriptionText } from "../agents/subscription.js";
import { currentFeatures } from "../features.js";
import { type ChatTurnWay, chatModel } from "../models.js";
import { prompt } from "../prompts.js";
import { contentPolicy } from "../safety.js";
import { serverText } from "../texts.js";
import { ServiceError } from "./errors.js";
import { ownedWizard, writeDraft } from "./wizards.js";

/**
 * The fast first pass of a new wizard (docs/plans/fast-creation.md, Part 3): one call without
 * tools writes the wizard in the text form (wizard-text.ts), each step is saved to the draft as
 * its tag closes, so the editor shows it at once, and at the end the code fixes what needs no
 * model. The architect finishes the rest afterwards.
 */

type Json = Record<string, any>;

const ID = /^[a-zA-Z][a-zA-Z0-9_]{0,40}$/;

/** An id made from words: "Wie hoch ist dein Budget?" → "wie_hoch_ist_dein_budget". */
export function idFrom(words: unknown, fallback: string): string {
  const slug = String(words ?? "")
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^[^a-z]+|_+$/g, "")
    .slice(0, 32)
    .replace(/_+$/, "");
  return slug || fallback;
}

/** `id`, or `id_2`, `id_3` … where `id` is taken. */
function unique(id: string, taken: Set<string>): string {
  let out = id;
  for (let n = 2; taken.has(out); n++) {
    out = `${id}_${n}`;
  }
  taken.add(out);
  return out;
}

const LOOKS: Record<string, (field: Json) => boolean> = {
  slider: (f) => f.kind === "number" && f.min !== undefined && f.max !== undefined,
  stepper: (f) => f.kind === "number",
  list: (f) => f.kind === "select",
};

/**
 * What the code fixes in a draft without a model: a missing or unusable id (made from the title
 * or label), ids used twice, a missing result step (`final` only), a rule to a step that does not
 * exist (dropped), a look that does not fit its field (dropped). Each fix is said in `fixes`.
 */
export function fixDraft(
  raw: Json,
  lang: Lang,
  final: boolean,
): { definition: Json; fixes: string[] } {
  const def: Json = structuredClone(raw);
  const fixes: string[] = [];
  const steps: Json[] = Array.isArray(def.steps) ? def.steps : [];
  def.steps = steps;
  const stepIds = new Set<string>();
  steps.forEach((step, i) => {
    const given = typeof step.id === "string" ? step.id : "";
    const base = ID.test(given) ? given : idFrom(step.title ?? given, `step${i + 1}`);
    const id = unique(base, stepIds);
    if (id !== given) {
      fixes.push(
        given
          ? `Step "${given}" is now "${id}" (${ID.test(given) ? "used twice" : "not an id"}).`
          : `Step ${i + 1} had no id; now "${id}".`,
      );
      step.id = id;
    }
  });
  const fieldIds = new Set<string>();
  for (const step of steps) {
    if (step.type !== "form" || !Array.isArray(step.fields)) {
      continue;
    }
    // With components, the n-th field is placed by the n-th Field component (wizard-text.ts).
    const placed = Array.isArray(step.components)
      ? (step.components as Json[]).filter((c) => c.component === "Field")
      : [];
    step.fields.forEach((field: Json, n: number) => {
      const given = typeof field.id === "string" ? field.id : "";
      const base = ID.test(given)
        ? given
        : idFrom(field.label ?? given, `field${fieldIds.size + 1}`);
      const id = unique(base, fieldIds);
      if (id !== given) {
        fixes.push(
          given
            ? `Field "${given}" in step "${step.id}" is now "${id}" (${ID.test(given) ? "used twice" : "not an id"}).`
            : `A field in step "${step.id}" had no id; now "${id}".`,
        );
        field.id = id;
        if (placed[n] && placed[n].name === (given || undefined)) {
          placed[n].name = id;
        }
      }
      const look = field.look;
      if (look !== undefined && !LOOKS[look]?.(field)) {
        fixes.push(`look "${String(look)}" did not fit field "${id}"; left out.`);
        delete field.look;
      }
    });
  }
  if (final && !steps.some((s) => s.type === "result")) {
    const id = unique("done", stepIds);
    steps.push({ id, type: "result", title: serverText(lang, "newWizardDone"), deliverables: [] });
    fixes.push(`The wizard had no result step; added "${id}".`);
  }
  for (const step of steps) {
    if (!Array.isArray(step.next)) {
      continue;
    }
    const kept = step.next.filter((rule: Json) => {
      const ok = rule?.goto === "end" || stepIds.has(rule?.goto);
      if (!ok) {
        fixes.push(
          `A rule of step "${step.id}" went to "${String(rule?.goto)}", which is no step; left out.`,
        );
      }
      return ok;
    });
    if (kept.length) {
      step.next = kept;
    } else {
      delete step.next;
    }
  }
  return { definition: def, fixes };
}

/** The steps the schema takes; the others are said as issues, for the architect. */
function schemaSteps(def: Json): { definition: Json; dropped: ValidationIssue[] } {
  const dropped: ValidationIssue[] = [];
  const steps = (def.steps as Json[]).filter((step) => {
    const ok = stepSchema.safeParse(step);
    if (!ok.success) {
      dropped.push({
        stepId: typeof step.id === "string" ? step.id : undefined,
        message: `Step "${String(step.id)}" (${String(step.type)}) did not fit the schema and was left out: ${ok.error.issues[0]?.message ?? ""}`,
      });
    }
    return ok.success;
  });
  return { definition: { ...def, steps }, dropped };
}

export interface FirstPassResult {
  /** The model wrote no step: the architect builds the wizard from the wish, as without the switch. */
  empty: boolean;
  steps: number;
  fixes: string[];
  /** The validator's issues after the fixes, with the steps the schema did not take. */
  issues: ValidationIssue[];
  /** What the parser repaired or dropped in the final text. */
  cuts: TextCut[];
  /** Milliseconds from `started` to the first piece of text, the first step saved, the last. */
  firstText: number | null;
  firstStep: number | null;
  lastStep: number | null;
  saves: number;
  chars: number;
  model: string | null;
}

export function firstPassSystem(durableRuns: boolean): string {
  return `${prompt("architect", "firstpass.system", {
    tags: wizardTextTags({ durableRuns }),
    examples: WIZARD_TEXT_EXAMPLES.join("\n\n"),
  })}\n\n${contentPolicy()}`;
}

/** The model's text, piece by piece: an AI client per call, else one `streamText`. */
async function writeText(
  way: ChatTurnWay,
  system: string,
  message: string,
  signal: AbortSignal,
  onText: (delta: string) => void,
  onModel: (ref: string) => void,
): Promise<void> {
  if (way === "claude" || way === "codex" || way === "cursor") {
    await subscriptionText({
      client: way,
      system,
      message,
      signal,
      onText,
      onModel: (m) => onModel(`${way}/${m ?? "default"}`),
    });
    return;
  }
  const resolved = await chatModel(way, "standard");
  onModel(resolved.ref);
  const result = streamText({
    model: resolved.model,
    system,
    prompt: message,
    abortSignal: signal,
    maxOutputTokens: 16_000,
    // Low effort where a provider takes it: a first draft, not a considered one.
    providerOptions: { openai: { reasoningEffort: "low" } },
  });
  for await (const delta of result.textStream) {
    onText(delta);
  }
}

/** Steps whose tag closed: the last one is left out while the text still writes it. */
function closedSteps(text: string): { definition: Json; closed: number } {
  const { definition, cuts } = parseWizardText(text, { partial: true });
  const steps = (definition.steps ?? []) as Json[];
  const writing = cuts.some((c) => c.open && c.step !== undefined);
  return { definition, closed: Math.max(0, steps.length - (writing ? 1 : 0)) };
}

export async function firstPass(input: {
  userId: string;
  wizardId: string;
  wish: string;
  way: ChatTurnWay;
  signal: AbortSignal;
  /** When the wish arrived: the times are counted from it. */
  started: number;
  /** A step was saved; the draft has these step ids now. */
  onSaved?: (stepIds: string[]) => void;
}): Promise<FirstPassResult> {
  const w = await ownedWizard(input.userId, input.wizardId);
  const lang = (w.draft.lang ?? "en") as Lang;
  const { durableRuns } = await currentFeatures();
  const system = firstPassSystem(durableRuns);
  const message = `${input.wish}\n\n(${prompt("architect", "firstpass.lang", { lang })})`;
  let revision = w.revision;
  let text = "";
  let saved = 0;
  let saves = 0;
  let model: string | null = null;
  const times = {
    firstText: null as number | null,
    firstStep: null as number | null,
    lastStep: null as number | null,
  };
  const since = () => Date.now() - input.started;

  /** Writes the draft; the person's edit in the meantime wins, and the next save goes on from it. */
  const save = async (definition: Json) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const out = await writeDraft(input.userId, input.wizardId, {
          definition,
          baseRevision: revision,
        });
        revision = out.revision;
        saves++;
        return out;
      } catch (err) {
        if (err instanceof ServiceError && err.code === "revision_conflict" && attempt === 0) {
          revision = (await ownedWizard(input.userId, input.wizardId)).revision;
          continue;
        }
        throw err;
      }
    }
    return null;
  };

  // Saves one at a time, always of the latest text: a step that closes during a save waits for it.
  let pending: Promise<void> | null = null;
  let again = false;
  const saveClosed = async () => {
    const { definition, closed } = closedSteps(text);
    if (closed <= saved) {
      return;
    }
    const draft = {
      ...definition,
      title: definition.title ?? w.draft.title,
      lang: definition.lang ?? lang,
      steps: (definition.steps as Json[]).slice(0, closed),
    };
    const fixed = schemaSteps(fixDraft(draft, lang, false).definition).definition;
    if (!fixed.steps.length || !wizardSchema.safeParse(fixed).success) {
      return;
    }
    await save(fixed);
    saved = closed;
    times.firstStep ??= since();
    times.lastStep = since();
    input.onSaved?.(fixed.steps.map((s: Json) => s.id));
  };
  const pump = async () => {
    while (again) {
      again = false;
      try {
        await saveClosed();
      } catch (err) {
        console.error("[first-pass] save", (err as Error).message);
      }
    }
    pending = null;
  };
  const kick = () => {
    again = true;
    pending ??= pump();
  };

  await writeText(
    input.way,
    system,
    message,
    input.signal,
    (delta) => {
      times.firstText ??= since();
      text += delta;
      if (delta.includes(">") && closedSteps(text).closed > saved) {
        kick();
      }
    },
    (ref) => {
      model = ref;
    },
  );
  await pending;

  const parsed = parseWizardText(text);
  const steps = (parsed.definition.steps ?? []) as Json[];
  if (!steps.length) {
    return {
      empty: true,
      steps: 0,
      fixes: [],
      issues: [],
      cuts: parsed.cuts,
      ...times,
      saves,
      chars: text.length,
      model,
    };
  }
  const draft = {
    ...parsed.definition,
    title: parsed.definition.title ?? w.draft.title,
    lang: parsed.definition.lang ?? lang,
  };
  const { definition: fixed, fixes } = fixDraft(draft, lang, true);
  const { definition, dropped } = schemaSteps(fixed);
  // A wizard whose top-level keys the schema refuses keeps the blank draft's.
  const final = wizardSchema.safeParse(definition).success
    ? definition
    : { ...w.draft, steps: definition.steps };
  const out = await save(final);
  times.lastStep = since();
  times.firstStep ??= times.lastStep;
  input.onSaved?.(final.steps.map((s: Json) => s.id));
  return {
    empty: false,
    steps: final.steps.length,
    fixes,
    issues: [...dropped, ...(out?.issues ?? [])],
    cuts: parsed.cuts,
    ...times,
    saves,
    chars: text.length,
    model,
  };
}

/** The line the log keeps of a first pass: times and counts only. */
export function firstPassLine(
  facts: { way: string; wizardId: string; outcome: string; ms: number },
  r: FirstPassResult | null,
): string {
  const ms = (v: number | null | undefined) => (v === null || v === undefined ? "none" : String(v));
  return [
    "[timing] firstPass",
    `way=${facts.way}`,
    `model=${r?.model ?? "none"}`,
    `wizard=${facts.wizardId}`,
    `outcome=${facts.outcome}`,
    `ms=${facts.ms}`,
    `first=${ms(r?.firstText)}`,
    `firstStep=${ms(r?.firstStep)}`,
    `lastStep=${ms(r?.lastStep)}`,
    `steps=${r?.steps ?? 0}`,
    `saves=${r?.saves ?? 0}`,
    `fixes=${r?.fixes.length ?? 0}`,
    `issues=${r?.issues.length ?? 0}`,
    `cuts=${r?.cuts.length ?? 0}`,
    `chars=${r?.chars ?? 0}`,
  ].join(" ");
}
