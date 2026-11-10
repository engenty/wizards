import {
  type AheadForm,
  type AheadRule,
  allFields,
  type CardOption,
  dataRef,
  FIELD_WAYS,
  type Field,
  type Format,
  type FormStep,
  formatsFor,
  isDecidedField,
  LIST_FORMATS,
  listRef,
  type ModelClass,
  type ReviewStep,
  type Step,
  sectionOf,
  sectionsOf,
  shownFields,
  slotText,
  type Who,
  type WizardDefinition,
  whenNames,
  wizardLang,
} from "./definition.js";
import { closedChoicesFor, openValue } from "./fit.js";
import { stepClasses } from "./requires.js";
import {
  CAN_GO_BACK,
  type ClosedChoice,
  type RunAsk,
  type RunEvent,
  type RunState,
  type RunStatus,
  type RunView,
  type ShownList,
  type ShownStep,
  type StepOutput,
  waitsOnJob,
} from "./run.js";
import type { ShareJobView } from "./sharing.js";
import type { StartedBy } from "./starts.js";
import type { ConnectionView, ListDef, ListRow } from "./store.js";
import { machineTranslated, type TranslationMemory, translateDefinition } from "./translation.js";

/**
 * The run view and the run report, from the run's definition and state and what the host adds
 * (`ViewExtras`, `ReportExtras`). Pure: whatever a host keeps in a database, it loads first.
 */

/** The run as the view and the report read it: its state, where it stands, its own facts. */
export interface ViewedRun {
  id: string;
  wizardId: string;
  status: RunStatus;
  cursor: string | null;
  state: RunState;
  mode: "test" | "live";
  /** The language the viewer reads the wizard in; null: its own. */
  lang: string | null;
  rev: number;
  error: string | null;
  ask: RunAsk | null;
  /** Answers typed on a page and not sent yet, by page. */
  unsent: Record<string, Record<string, unknown>> | null;
  startedBy: StartedBy | null;
  shareToken: string | null;
  /** ISO times. */
  wakeAt: string | null;
  expiresAt: string | null;
}

/**
 * The run as people see it: one that sleeps while a service works on its step (a film, a video)
 * is at work there, as when the step ran in the process itself, with no time to wait for.
 */
function asShown(run: ViewedRun): ViewedRun {
  return waitsOnJob(run) ? { ...run, status: "running", wakeAt: null } : run;
}

/** What a page knows besides the person's input (the runtime's `formContext`). */
export interface PageContext {
  known: Record<string, unknown>;
  options: Record<string, string[]>;
  cards: Record<string, CardOption[]>;
  decided: string[];
}

/** A wizard's stored lists with the person's rows, by list id. */
export type StoredLists = Record<string, { def: ListDef; rows: ListRow[] }>;

/** What the host adds to the view: what only it knows, or what it reads from elsewhere. */
export interface ViewExtras {
  brand: RunView["brand"];
  /** Steps whose output stays in the space: shown with no output and `kept`. */
  hide?: ReadonlySet<string>;
  /** The run's translation into `run.lang`; null: none stored, or the wizard's own words. */
  translation: TranslationMemory | null;
  /** The model classes the host has no model for (`viewNeeds().missing`). */
  missing: readonly ModelClass[];
  /** The wizard's stored lists (`viewNeeds().lists`). */
  lists: StoredLists;
  /** A widget's video can be rendered on demand (`viewNeeds().ffmpeg`). */
  ffmpeg: boolean;
  /** The current page's context, for a page. */
  page: PageContext | null;
  /** What the current page's `prefill` refs read, by field id, empty values left out. */
  prefill: Record<string, unknown>;
  /** What the current page's `data` reads, for a page that has `data`. */
  pageData?: Record<string, unknown>;
  /** The key the current `wait` listens on, as the run's answers fill it. */
  waitKey: string;
  /** A live conversation may be held on the run (`viewNeeds().talk`). */
  talk: boolean;
  /** The run's newest log lines. */
  events: RunEvent[];
  /** The wizard's connections with what the person has connected (`viewNeeds().connections`). */
  connections: ConnectionView[];
  /** The person keeps accounts connected for sharing (`viewNeeds().secrets`). */
  secrets: boolean;
  /** Where shared links point. */
  publicUrl: string;
  /** The result's latest share job (`viewNeeds().shareJob`). */
  shareJob: ShareJobView | null;
}

/** The role a step asks for. */
export const whoOf = (step: Step | null | undefined): Who =>
  step?.type === "form" || step?.type === "review" ? (step.who ?? "person") : "person";

function stepOf(def: WizardDefinition, id: string | null): Step | undefined {
  return id === null ? undefined : def.steps.find((s) => s.id === id);
}

/** The definition in the viewer's words: null without a translation. */
export function viewDefinition(
  def: WizardDefinition,
  translation: TranslationMemory | null,
): { def: WizardDefinition; labels: Record<string, string> } | null {
  return translation ? translateDefinition(def, translation) : null;
}

/**
 * The answers on a page that lead to a step with a model class from `missing`: with them the run
 * would stop there. A voice note nothing can listen to is closed as a whole.
 */
export function closedChoicesOf(
  def: WizardDefinition,
  step: FormStep,
  values: Record<string, unknown>,
  missing: ReadonlySet<ModelClass>,
): Record<string, ClosedChoice> {
  if (!missing.size) {
    return {};
  }
  return closedChoicesFor(
    def,
    step,
    values,
    (s) => stepClasses(s, def.requires?.agents).filter((cls) => missing.has(cls)),
    (field) => (missing.has("audio") && field.kind === "audio" ? ["audio"] : null),
  );
}

/**
 * A step a run reaches with no runner: a page or review nothing has to decide or fill first. The
 * step's keys only, so with `durableRuns` off it says the same. `state` is the state after
 * `advance`: an `ask` rule set `deciding` there and left the cursor on the answered step.
 */
export function needsNoRunner(
  step: Step | undefined,
  startedBy: StartedBy | null,
  state: RunState,
): step is FormStep | ReviewStep {
  return (
    (step?.type === "form" || step?.type === "review") &&
    // A start's run is filled by `passStep`, with nobody there.
    !startedBy &&
    !state.deciding &&
    // A deadline's `wait` would land in the timeline before the answered step's `step_done`.
    !step.timeout &&
    !step.remind &&
    // Whoever answered is not the one asked next.
    whoOf(step) === "person" &&
    !(step.type === "form" && step.fields.some(isDecidedField))
  );
}

/** A widget whose video is rendered when it is asked for: its formats depend on ffmpeg. */
export function rendersOnDemand(step: Step, output: StepOutput | undefined): boolean {
  return step.type === "widget" && !step.video && Boolean(output?.widget?.duration);
}

/**
 * The formats a deliverable can really be downloaded in: a still widget has no video. `ffmpeg`:
 * a video can be rendered here (read only where `rendersOnDemand`).
 */
export function formatsOf(
  step: Step,
  output: StepOutput | undefined,
  wanted: Format[] | undefined,
  ffmpeg: boolean,
): Format[] {
  const possible = formatsFor(step);
  let formats = wanted ? wanted.filter((f) => possible.includes(f)) : possible;
  if (step.type === "widget" && formats.includes("mp4")) {
    // A video is rendered when its step runs; any other widget on demand.
    const has = step.video
      ? output?.assets?.some((a) => a.kind === "video")
      : rendersOnDemand(step, output) && ffmpeg;
    if (!has) {
      formats = formats.filter((f) => f !== "mp4");
    }
  }
  // A zip holds the files a step collected, or its several results; with one there is nothing to zip.
  if (formats.includes("zip")) {
    const has =
      step.type === "generate"
        ? (output?.assets?.length ?? 0) > 1
        : output?.assets?.some((a) => a.kind === "file");
    if (!has) {
      formats = formats.filter((f) => f !== "zip");
    }
  }
  return formats;
}

/** How many pages `ahead` holds at most. */
const AHEAD_MAX = 20;

/**
 * The plain pages a run can reach from the page it waits on, with no server: the current page and
 * every page its rules lead to that the shortcut covers (`needsNoRunner`) and that needs nothing
 * only the server has. A page's `next` is null where the server decides: an `ask`, a `max`, a rule
 * back (its loops are counted), a name the browser has no value for. In the definition `def` it
 * is shown in (a translation's words).
 */
export function aheadOf(
  run: Pick<ViewedRun, "startedBy" | "state">,
  def: WizardDefinition,
  from: FormStep,
  missing: ReadonlySet<ModelClass>,
): Record<string, AheadForm & { progress: RunView["progress"] }> {
  const answers = new Set(allFields(def).map((f) => f.id));
  const readsAnswers = (when: Parameters<typeof whenNames>[0]) =>
    whenNames(when).every((name) => answers.has(name));
  const sections = sectionsOf(def);
  const progressOf = (step: FormStep): RunView["progress"] => ({
    done: def.steps.indexOf(step),
    total: def.steps.length,
    ...(sections.length
      ? { sections: { names: sections, current: sections.indexOf(sectionOf(def, step.id) ?? "") } }
      : {}),
  });
  const rulesOf = (step: FormStep): AheadRule[] | null => {
    const at = def.steps.indexOf(step);
    const rules = step.next ?? [];
    const out: AheadRule[] = [];
    for (const rule of rules) {
      const to =
        rule.goto === "end" ? def.steps.length : def.steps.findIndex((s) => s.id === rule.goto);
      if (rule.ask !== undefined || rule.max !== undefined || (to >= 0 && to <= at)) {
        return null;
      }
      if (rule.when !== undefined) {
        if (!readsAnswers(rule.when)) {
          return null;
        }
        out.push({ when: rule.when, goto: rule.goto });
      }
    }
    const otherwise = rules.find((r) => r.when === undefined && r.ask === undefined);
    out.push({ goto: otherwise?.goto ?? def.steps[at + 1]?.id ?? "end" });
    return out;
  };
  const plain = (step: Step | undefined): boolean =>
    step?.type === "form" &&
    needsNoRunner(step, run.startedBy, run.state) &&
    !step.data &&
    step.fields.every(
      (f) =>
        !f.optionsFrom &&
        !f.cards &&
        !f.prefill &&
        f.kind !== "connection" &&
        f.kind !== "list" &&
        f.kind !== "slot" &&
        (f.when === undefined || readsAnswers(f.when)),
    ) &&
    Object.keys(closedChoicesOf(def, step, run.state.values, missing)).length === 0;
  const out: Record<string, AheadForm & { progress: RunView["progress"] }> = {};
  const queue: FormStep[] = [from];
  while (queue.length && Object.keys(out).length < AHEAD_MAX) {
    const step = queue.shift() as FormStep;
    if (out[step.id]) {
      continue;
    }
    const next = rulesOf(step);
    out[step.id] = { step, next, progress: progressOf(step) };
    for (const rule of next ?? []) {
      const target = stepOf(def, rule.goto);
      if (target?.type === "form" && !out[target.id] && plain(target)) {
        queue.push(target);
      }
    }
  }
  return out;
}

/** The steps the current step shows (`show` of a review, the result's deliverables). */
function shownRefs(step: Step | undefined): string[] {
  return step?.type === "review"
    ? step.show
    : step?.type === "result"
      ? [...new Set(step.deliverables.map((d) => d.from))]
      : [];
}

/** The stored lists the current step shows: a page's list fields, a review's, the result's. */
function shownListIds(step: Step | undefined): string[] {
  return [
    ...shownRefs(step).map(listRef),
    ...(step?.type === "form" ? step.fields.map((f) => (f.kind === "list" ? f.list : null)) : []),
  ].filter((id): id is string => Boolean(id));
}

/** Which of the extras the view reads for this run; the host loads only those. */
export function viewNeeds(def: WizardDefinition, run: ViewedRun) {
  const step = stepOf(def, run.cursor);
  const page = step?.type === "form" ? step : null;
  return {
    missing: Boolean(page) && run.status === "waiting_input",
    lists: shownListIds(step).length > 0,
    ffmpeg: shownRefs(step).some((id) => {
      const s = stepOf(def, id);
      return s !== undefined && rendersOnDemand(s, run.state.outputs[s.id]);
    }),
    // Nobody to talk to while it waits, and nothing to say.
    talk: run.status !== "sleeping" && run.status !== "waiting_signal",
    connections: Boolean(page?.fields.some((f) => f.kind === "connection")),
    secrets: !(def.lists?.length || def.connections?.length) && run.status === "done",
    shareJob: run.status === "done",
  };
}

/** What a page's fields start with: what their `prefill` read, and a closed choice opened. */
function prefillOf(
  step: FormStep,
  prefill: Record<string, unknown>,
  closed: Record<string, ClosedChoice>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...prefill };
  for (const [id, choice] of Object.entries(closed)) {
    const field = step.fields.find((f) => f.id === id);
    const start = out[id] ?? field?.default ?? (field?.kind === "toggle" ? false : undefined);
    if (field && start !== undefined && choice.values.some((v) => String(v) === String(start))) {
      out[id] = openValue(step, id, choice);
    }
  }
  return out;
}

/**
 * The run as the viewer sees it, from the definition it started on (`own`). `extras.hide`: steps whose output stays in the space: shown with
 * no output and `kept`, left out of `outputs`; empty for a member, or a member's run.
 */
export function viewOf(own: WizardDefinition, row: ViewedRun, extras: ViewExtras): RunView {
  const run = asShown(row);
  const hide = extras.hide ?? new Set<string>();
  const missing = new Set(extras.missing);
  // In the viewer's language every text of the view is the translation; ids and values stay.
  const memory = run.lang ? extras.translation : null;
  const translated = viewDefinition(own, memory);
  const def = translated?.def ?? own;
  const step = stepOf(def, run.cursor) ?? null;
  const closed =
    step?.type === "form" && run.status === "waiting_input"
      ? closedChoicesOf(def, step, run.state.values, missing)
      : {};
  const index = step ? def.steps.indexOf(step) : def.steps.length;
  const sections = sectionsOf(def);
  const refs = shownRefs(step ?? undefined);
  const shownIds = refs.filter((ref) => !listRef(ref));
  const stored = extras.lists;
  const lists: ShownList[] = [...new Set(shownListIds(step ?? undefined))]
    .filter((id) => stored[id])
    .map((id) => {
      const deliverable =
        step?.type === "result" ? step.deliverables.find((d) => listRef(d.from) === id) : undefined;
      return {
        ...stored[id],
        formats: deliverable
          ? deliverable.formats.filter(
              (f) => LIST_FORMATS.includes(f) && (f !== "zip" || stored[id].def.check?.file),
            )
          : [],
        label: deliverable?.label ?? null,
      };
    });
  const shown: ShownStep[] = shownIds
    .map((id) => stepOf(def, id))
    .filter((s): s is Step => Boolean(s))
    .map((s) => {
      const deliverable =
        step?.type === "result" ? step.deliverables.find((d) => d.from === s.id) : undefined;
      if (hide.has(s.id) && run.state.outputs[s.id]) {
        return {
          step: s,
          output: null,
          formats: [],
          label: deliverable?.label ?? null,
          kept: true,
        };
      }
      return {
        step: s,
        output: run.state.outputs[s.id] ?? null,
        formats: formatsOf(s, run.state.outputs[s.id], deliverable?.formats, extras.ffmpeg),
        label: deliverable?.label ?? null,
      };
    });
  const page = step?.type === "form" ? extras.page : null;
  return {
    id: run.id,
    status: run.status,
    wakeAt:
      run.status === "sleeping" || run.status === "waiting_signal" || run.status === "waiting_input"
        ? run.wakeAt
        : null,
    pause: run.status === "sleeping" ? (run.state.pause ?? null) : null,
    waitsFor:
      run.status === "waiting_signal" && step?.type === "wait" ? extras.waitKey || null : null,
    // Who the viewer is: the door says (`viewFor`, engine/answerers.ts).
    answeredBy: null,
    mode: run.mode,
    wizard: {
      title: def.title,
      description: def.description,
      avatar: def.avatar,
      costume: def.costume,
      intro: def.intro,
    },
    lang: wizardLang(own),
    translation:
      run.lang && memory && translated
        ? {
            lang: run.lang,
            labels: translated.labels,
            machine: machineTranslated(memory, own),
            results: run.state.translated?.[run.lang] ?? {},
          }
        : null,
    talk: run.status !== "sleeping" && run.status !== "waiting_signal" && extras.talk,
    step,
    answered: run.state.history.map((id) => stepOf(def, id)).filter((s): s is Step => Boolean(s)),
    values: run.state.values,
    rev: run.rev,
    // What the browser may do alone, and what was typed and not sent: `viewFor` keeps both from a
    // viewer who may not answer.
    ...(run.status === "waiting_input" && step?.type === "form" && !run.startedBy
      ? {
          ahead: aheadOf(run, def, step, missing),
          pagesSent: run.state.pagesSent?.n ?? 0,
        }
      : {}),
    ...(run.status === "waiting_input" && step?.type === "form" && run.unsent?.[step.id]
      ? { unsent: run.unsent[step.id] }
      : {}),
    prefill: step?.type === "form" ? prefillOf(step, extras.prefill, closed) : {},
    ...(step?.type === "form" && step.data ? { pageData: extras.pageData ?? {} } : {}),
    ...(page
      ? {
          known: page.known,
          options: page.options,
          cards: page.cards,
          decidedFields: page.decided,
        }
      : {}),
    ...(run.mode === "test" && run.state.decisions
      ? {
          decisions: Object.fromEntries(
            Object.entries(run.state.decisions).map(([id, d]) => [
              id,
              { ...d, over: def.steps.find((s) => s.id === id)?.next ?? [] },
            ]),
          ),
        }
      : {}),
    closed,
    outputs: Object.fromEntries(
      shownIds
        .filter((id) => !hide.has(id))
        .map((id) => [id, run.state.outputs[id]])
        .filter(([, o]) => o),
    ),
    shown,
    progress: {
      done: run.status === "done" ? def.steps.length : index,
      total: def.steps.length,
      ...(sections.length
        ? {
            sections: {
              names: sections,
              current:
                run.status === "done"
                  ? sections.length
                  : sections.indexOf(sectionOf(def, run.cursor ?? "") ?? ""),
            },
          }
        : {}),
    },
    canBack: run.state.history.length > 0 && CAN_GO_BACK.has(run.status),
    error: run.error,
    // A step's own words as it starts ("working") are the wizard's: in its translation too.
    events: extras.events.map((ev) =>
      memory?.[ev.message] && !ev.note ? { ...ev, message: memory[ev.message].text } : ev,
    ),
    brand: extras.brand,
    ask: run.status === "running" ? run.ask : null,
    question: run.status === "waiting_input" ? (run.state.turn?.question ?? null) : null,
    lists,
    connections: extras.connections,
    keeps:
      Boolean(def.lists?.length || def.connections?.length) ||
      // An account connected for sharing is kept too, and can be deleted the same way.
      (run.status === "done" && extras.secrets),
    shareUrl: run.shareToken ? `${extras.publicUrl}/s/${run.shareToken}` : null,
    expiresAt: run.expiresAt,
    shareJob: run.status === "done" ? extras.shareJob : null,
  };
}

// --- report ------------------------------------------------------------------

/** What the host adds to the report. */
export interface ReportExtras {
  /** Steps kept from the viewer: their outputs and the data that reads them stay out. */
  hidden: string[];
  /** The viewer may answer what the run waits for; true without a viewer. */
  mayAct: boolean;
  /** What a door that asks one field at a time has so far: a field's `shown` follows it. */
  draft?: Record<string, unknown>;
  /** The current page's context, where the report lists its fields (`reportNeeds().page`). */
  page: PageContext | null;
  /** An autopilot fills the run's pages: a page it waits on counts as running. */
  autopilot: boolean;
  credits: number;
  /** The run's newest log lines. */
  events: RunEvent[];
  /** The live run's page; null for a test run. */
  browserUrl: string | null;
  /** The test run's studio; null for a live run. */
  studioUrl: string | null;
  /** A text of the host's for a door (the runtime's `prompts/mcp.md`). */
  text: (key: string, vars?: Record<string, string | number>) => string;
  /** A link to a path of the run's API that works without a sign-in. */
  link: (path: string) => string;
}

/** Which of the extras the report reads for this run; the host loads only those. */
export function reportNeeds(def: WizardDefinition, run: ViewedRun, mayAct: boolean) {
  const current = stepOf(def, run.cursor);
  return {
    page:
      mayAct &&
      run.status === "waiting_input" &&
      current?.type === "form" &&
      !(run.state.turn?.question && run.state.turn.stepId === current.id),
  };
}

function clip(text: string, max: number): string {
  return text.length > max
    ? `${text.slice(0, max)} … [${text.length - max} more characters]`
    : text;
}

function deliverableFormats(def: WizardDefinition, step: Step) {
  const possible = formatsFor(step);
  const listed = def.steps
    .flatMap((s) => (s.type === "result" ? s.deliverables : []))
    .find((d) => d.from === step.id);
  return listed ? listed.formats.filter((f) => possible.includes(f)) : [];
}

/**
 * What a client needs besides the plain field: a slot's times as the person reads them, and the
 * one value of them to send back.
 */
function slotHints(
  def: WizardDefinition,
  run: ViewedRun,
  field: Field,
  options: string[] | undefined,
  text: ReportExtras["text"],
) {
  if (field.kind !== "slot") {
    return {};
  }
  const lang = wizardLang(def);
  const value = run.state.values[field.id];
  return {
    times: (options ?? []).map((o) => ({ value: o, label: slotText(o, lang) })),
    ...(typeof value === "string" ? { valueText: slotText(value, lang) } : {}),
    hint: options?.length ? text("hint.slot") : text("hint.slot_none"),
  };
}

/** What a run waits for. */
function waitingFor(
  def: WizardDefinition,
  run: ViewedRun,
  current: Step | null,
  extras: ReportExtras,
) {
  const { text } = extras;
  // What someone else is asked is theirs: the door hears that, and nothing of what it asks.
  if (!extras.mayAct) {
    return run.status === "waiting_input" && current
      ? {
          answeredBy: whoOf(current),
          title: current.title,
          hint: text("hint.answered_by"),
        }
      : undefined;
  }
  if (run.status === "running" && run.ask) {
    const ask = run.ask;
    return ask.kind === "confirm"
      ? {
          ask: ask.id,
          kind: ask.kind,
          reason: ask.again ? text("reason.confirm_again", { service: ask.service }) : ask.reason,
          service: ask.service,
          action: ask.action.summary,
          input: clip(ask.input, 1500),
          hint: ask.again ? text("hint.confirm_again") : text("hint.confirm"),
        }
      : {
          ask: ask.id,
          kind: ask.kind,
          reason: ask.reason,
          site: ask.site.host,
          hint: text("hint.sign_in"),
        };
  }
  if (run.status === "sleeping" && current) {
    const pause = run.state.pause;
    // Waiting for a person has no time: the next look says nothing about when they act.
    return {
      wait: current.id,
      title: current.title,
      until: pause && pause.kind !== "retry" ? null : run.wakeAt,
      ...(pause ? { pause } : {}),
      hint:
        pause?.kind === "retry"
          ? text("hint.pause_retry")
          : pause?.kind === "credits"
            ? text("hint.pause_credits")
            : pause?.kind === "sign_in"
              ? text("hint.pause_sign_in")
              : text("hint.sleeping"),
    };
  }
  if (run.status === "waiting_signal" && current?.type === "wait") {
    return {
      wait: current.id,
      title: current.title,
      until: run.wakeAt,
      signal: current.signal?.name ?? null,
      hint: text("hint.waiting_signal"),
    };
  }
  if (run.status !== "waiting_input" || !current) {
    return undefined;
  }
  if (run.state.turn?.question && run.state.turn.stepId === current.id) {
    return {
      question: run.state.turn.question,
      title: current.title,
      hint: text("hint.question"),
    };
  }
  if (current.type === "form") {
    // What the page knows from before it, the choices its fields take from data, the fields a
    // decision kept: a field left out here is not asked, as the run page leaves it out.
    const ctx = extras.page ?? { known: {}, options: {}, cards: {}, decided: [] };
    const fields = current.fields
      .filter((f) => !isDecidedField(f) || ctx.decided.includes(f.id))
      .map((f) => (ctx.options[f.id]?.length ? { ...f, options: ctx.options[f.id] } : f));
    const page = {
      ...Object.fromEntries(
        fields.filter((f) => f.id in run.state.values).map((f) => [f.id, run.state.values[f.id]]),
      ),
      ...extras.draft,
    };
    const shown = new Set(shownFields(fields, ctx.known, page).map((f) => f.id));
    return {
      form: current.id,
      title: current.title,
      ...(run.wakeAt ? { until: run.wakeAt } : {}),
      /** What the fields' conditions read from before the page, by reference. */
      known: ctx.known,
      fields: fields.map((f) => ({
        id: f.id,
        label: f.label,
        kind: f.kind,
        required: Boolean(f.required),
        options: f.options,
        placeholder: f.placeholder,
        help: f.help,
        default: f.default,
        value: run.state.values[f.id],
        columns: f.columns,
        ...slotHints(def, run, f, f.options, text),
        ...(f.multiple ? { multiple: true } : {}),
        // A file, a recording or a signature comes from the person's device: the run page.
        inChat: FIELD_WAYS[f.kind] !== "device",
        // A field with a condition is asked only while it holds; one on another field of this
        // page holds or not as the person answers. `shown` says so for what is known now.
        ...(f.when ? { when: f.when, shown: shown.has(f.id) } : {}),
      })),
      hint: text("hint.page"),
    };
  }
  if (current.type === "review") {
    return {
      review: current.id,
      title: current.title,
      show: current.show,
      editable: Boolean(current.edit),
      ...(run.wakeAt ? { until: run.wakeAt } : {}),
      ...(current.approve ? { approve: true } : {}),
      hint: current.approve ? text("hint.review_approve") : text("hint.review"),
    };
  }
  return undefined;
}

/** The run's data without the keys that read a step kept from the viewer. */
function shownData(
  def: WizardDefinition,
  run: ViewedRun,
  data: Record<string, unknown>,
  hidden: string[],
) {
  const result = def.steps.find((s) => s.id === run.cursor);
  const refs = result?.type === "result" ? (result.data ?? {}) : {};
  return Object.fromEntries(
    Object.entries(data).filter(([key]) => {
      const [head, id] = dataRef(refs[key] ?? "").split(".");
      return !(head === "steps" && hidden.includes(id));
    }),
  );
}

/** What a run did so far, for a client without the run page: outputs, links, cost, errors. */
export function reportOf(def: WizardDefinition, row: ViewedRun, extras: ReportExtras) {
  const run = asShown(row);
  const current = def.steps.find((s) => s.id === run.cursor) ?? null;
  const base = `/api/runs/${run.id}`;
  const { hidden, link } = extras;
  const outputs = def.steps.flatMap((step) => {
    const output = run.state.outputs[step.id];
    if (!output || hidden.includes(step.id)) {
      return [];
    }
    // A document, a dashboard or a widget drawn as one picture: for a door that shows pictures
    // with a link. A generated image is a picture already.
    const picture =
      formatsFor(step).includes("png") && !(step.type === "generate" && step.asset === "image")
        ? link(`${base}/steps/${step.id}/download?format=png`)
        : null;
    return [
      {
        stepId: step.id,
        title: step.title,
        text: output.text ? clip(output.text, 1500) : undefined,
        json: output.json === undefined ? undefined : clip(JSON.stringify(output.json), 1500),
        assets: (output.assets ?? []).map((a) => ({
          name: a.name,
          mime: a.mime,
          url: link(`${base}/assets/${a.id}`),
        })),
        downloads: Object.fromEntries(
          deliverableFormats(def, step).map((f) => [
            f,
            link(`${base}/steps/${step.id}/download?format=${f}`),
          ]),
        ),
        picture,
      },
    ];
  });
  const moving = run.status === "running" || (run.status === "waiting_input" && extras.autopilot);
  return {
    runId: run.id,
    wizardId: run.wizardId,
    mode: run.mode,
    lang: wizardLang(def),
    status: moving ? "running" : run.status,
    step: current ? { id: current.id, type: current.type, title: current.title } : null,
    /** Steps behind the run: answered pages and reviews, every step with a result, the end. */
    passed: def.steps
      .filter(
        (s) =>
          run.state.history.includes(s.id) ||
          run.state.outputs[s.id] ||
          (run.status === "done" && s.id === run.cursor),
      )
      .map((s) => s.id),
    waitingFor: waitingFor(def, run, current, extras),
    error: run.error,
    credits: extras.credits,
    events: extras.events.map((e) => ({
      step: e.stepId,
      type: e.type,
      message: e.message,
    })),
    outputs,
    /** What the result names as the run's data, once it is done; a step kept from the viewer stays out. */
    ...(run.status === "done" && run.state.data
      ? { data: shownData(def, run, run.state.data, hidden) }
      : {}),
    browserUrl: extras.browserUrl,
    ...(run.mode === "test" ? { studioUrl: extras.studioUrl } : {}),
  };
}

export type RunReport = ReturnType<typeof reportOf>;
