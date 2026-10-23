import {
  type ChoiceAnswer,
  type DecisionQuestion,
  marginOf,
} from "@engenty/wizards-shared/decision";
import {
  branchValues,
  type CardOption,
  cardsFromData,
  conditionsOf,
  dataRef,
  type Format,
  followRules,
  formatsFor,
  isDecidedField,
  LIST_FORMATS,
  listRef,
  loopKey,
  MAX_SHOWN_FIELDS,
  optionsFromData,
  otherwiseOf,
  type PageStep,
  pageNeeds,
  type Step,
  textLang,
  type WizardDefinition,
  whenHolds,
  wizardLang,
} from "@engenty/wizards-shared/definition";
import type { Said, StepOutput } from "@engenty/wizards-shared/run";
import {
  type ClosedChoice,
  note,
  type RunState,
  type RunView,
  type ShownList,
  saidText,
} from "@engenty/wizards-shared/run";
import { CONVERSATION_RUNNERS, DEFAULT_RUNNER_SETTINGS } from "@engenty/wizards-shared/runners";
import { fitData } from "@engenty/wizards-shared/shape";
import type { ListDef, ListRow } from "@engenty/wizards-shared/store";
import { machineTranslated, translateDefinition } from "@engenty/wizards-shared/translation";
import type { WorkspaceFile } from "@engenty/wizards-shared/workspace";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { connectionViews } from "../connectors/index.js";
import {
  addLocalCost,
  canSpend,
  releaseRun,
  reserveForRun,
  syncRunCost,
} from "../credits/credits.js";
import { estimateRun } from "../credits/estimate.js";
import { db, schema, withTenant } from "../db/client.js";
import { env } from "../env.js";
import { saveAsset } from "../files/storage.js";
import { managed, tenantInfo } from "../manage.js";
import { hasFfmpeg } from "../media/ffmpeg.js";
import { NotedError, noteOf, saidOf } from "../model-errors.js";
import {
  conversationAvailable,
  freeTierRefusal,
  freeTierText,
  ModelUnavailableError,
  noteFreeTierRefusal,
} from "../models.js";
import { runEnded } from "../plugins/events.js";
import { prompt } from "../prompts.js";
import { reportRun } from "../services/manage-reports.js";
import { projectFiles } from "../services/project-files.js";
import { projectProfile } from "../services/projects.js";
import { switchedOffRunners } from "../services/runners.js";
import { storedTranslation } from "../services/translations.js";
import { latestShareJob } from "../sharing/state.js";
import { listRows, listSecrets, scopeOf } from "../store/index.js";
import {
  claimRun,
  disownRuns,
  heartbeatRuns,
  indexRun,
  restRun,
  waitingRuns,
  wakeRun,
} from "../tenants/control.js";
import { currentTenant } from "../tenants/tenant.js";
import { askPerson, clearStaleAsk } from "./asks.js";
import { decide } from "./decide.js";
import { clearDeviceCalls } from "./device.js";
import { emitEvent, recentEvents, signalChanged } from "./events.js";
import { type InputError, type PageContext, readPageInput } from "./input.js";
import { pushRun } from "./push.js";
import {
  blockingMessage,
  closedChoices,
  missingModelsSaid,
  openValue,
  stepsWithoutModel,
} from "./requirements.js";
import { releaseResources, resourcesFor } from "./resources.js";
import { outputSchema, runAutomaticStep } from "./steps.js";
import { answersAsText, resolveRef } from "./template.js";
import type { ProjectRow, RunRow, StepContext } from "./types.js";
import { StepError } from "./types.js";

/** A command the run cannot take in its current state; a note where the person may read it. */
export class RunConflict extends NotedError {}
export class RunInputError extends NotedError {
  constructor(readonly errors: InputError[]) {
    super({ code: "checkFields" });
  }
}

export class NoCreditsError extends NotedError {
  constructor() {
    super(note("wizardRunOutCredits"));
  }
}

/** A visitor's run past the day's or the month's budget for visitors (the Manage-App's guest budget). */
export class GuestBudgetError extends NotedError {
  constructor() {
    super(note("guestBudget"));
  }
}

/** The runs this process drives right now, with the handle that stops each. */
const active = new Map<string, AbortController>();

// --- the line ------------------------------------------------------------------
// A run that wants work is marked in the control database (`wakeRun`); a runner claims it there,
// so several processes share one line. A tenant's runs beyond its limit stay in line; nothing is
// refused. See docs/plans/runner-process.md.

/** How often a runner looks at the line, and how often it reports on the runs it holds. */
const POLL_MS = 2000;
const HEARTBEAT_MS = 10_000;

async function concurrencyLimit(tenant: string): Promise<number> {
  if (!managed) {
    return env.limits.concurrentRuns;
  }
  // Out of reach, the Manage-App doesn't hold the line up: the runtime's own limit counts.
  const info = await tenantInfo(tenant).catch((err) => {
    console.warn(`[line] limit of tenant ${tenant}:`, err);
    return null;
  });
  return info?.limits.concurrentRuns || env.limits.concurrentRuns;
}

async function loadRun(runId: string): Promise<RunRow | undefined> {
  return db.query.run.findFirst({ where: eq(schema.run.id, runId) });
}

/** The project a run's wizard belongs to — where its imported connectors live. */
export async function projectIdOf(run: RunRow): Promise<string> {
  const w = await db.query.wizard.findFirst({ where: eq(schema.wizard.id, run.wizardId) });
  return w?.projectId ?? "";
}

export async function loadProject(run: RunRow): Promise<ProjectRow> {
  const w = await db.query.wizard.findFirst({ where: eq(schema.wizard.id, run.wizardId) });
  const p = w && (await db.query.project.findFirst({ where: eq(schema.project.id, w.projectId) }));
  if (!p) {
    throw new Error("project missing");
  }
  return p;
}

async function updateRun(runId: string, patch: Partial<typeof schema.run.$inferInsert>) {
  await db
    .update(schema.run)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(schema.run.id, runId));
  // A run that ended needs no credits held for it any more.
  if (patch.status === "done" || patch.status === "failed" || patch.status === "cancelled") {
    await releaseRun(runId);
    // Plugins hear of it; the run does not wait for them.
    void runEnded(runId, patch.status);
    if (patch.status !== "cancelled") {
      void pushRun(runId, patch.status);
    }
  }
  if (patch.status) {
    reportRun(runId, patch.status);
  }
  signalChanged(runId);
}

function stepOf(def: WizardDefinition, id: string | null): Step | undefined {
  return id ? def.steps.find((s) => s.id === id) : undefined;
}

function friendly(err: unknown): Said {
  if (err instanceof StepError || err instanceof ModelUnavailableError) {
    return saidOf(err);
  }
  // An own AI Gateway key on Vercel's free tier: the person can top it up or pick another way.
  const refused = freeTierRefusal(err);
  if (refused !== null) {
    return freeTierText(refused);
  }
  const msg = (err as Error)?.message ?? String(err);
  // The model-gateway answers 402 once the tenant's credits are used up.
  if (/insufficient_credits|\b402\b/i.test(msg)) {
    return saidOf(new NoCreditsError());
  }
  // A runtime that runs alone pays its provider itself: its admin can top the account up.
  if (!managed && /minimum balance|insufficient_funds|top up your credits/i.test(msg)) {
    return note("providerCreditLow");
  }
  if (/rate.?limit|429/i.test(msg)) {
    return note("aiServiceBusyRight");
  }
  if (/timeout|timed out/i.test(msg)) {
    return note("stepTookTooLong");
  }
  // The platform's own provider account (budget, quota, key): nothing the person can fix.
  if (
    /budget|quota|insufficient|billing|credit balance|api key|unauthori[sz]ed|401|403/i.test(msg)
  ) {
    return note("aiServiceNotReached");
  }
  return note("stepFailed", { detail: msg.slice(0, 300) });
}

/**
 * A step that failed ends the run. A failure with a note (Apple Intelligence's) goes into the log
 * as that note, so a runner shows it in its language; the run's error is in the wizard's.
 */
async function failRun(run: RunRow, stepId: string, err: unknown) {
  const said = noteOf(err) ?? friendly(err);
  const message = saidText(said, textLang(wizardLang(run.definition)));
  await emitEvent(run.id, stepId, "error", said);
  await updateRun(run.id, { status: "failed", error: message });
}

// --- creating & driving ------------------------------------------------------

export async function createRun(input: {
  wizardId: string;
  definition: WizardDefinition;
  files: WorkspaceFile[];
  version: number | null;
  mode: "test" | "live";
  visitorId?: string | null;
  userId?: string | null;
  ipHash?: string | null;
  /** The door the run comes through; null: the page. */
  runner?: string | null;
  /** The website page a visitor started the run on; null: the wizard's link. */
  origin?: string | null;
  /** An autopilot fills the pages (an MCP client's test run): the run asks nobody. */
  unattended?: boolean;
  /** The language the viewer reads the wizard in, translated on request; null: its own. */
  lang?: string | null;
  /** The client that starts it over the public API; null for the studio and the AI apps. */
  client?: string | null;
}): Promise<string> {
  const id = nanoid(18);
  const first = input.definition.steps[0];
  const state: RunState = { values: {}, outputs: {}, history: [], notes: {} };
  // A step every run passes through needs a model this runtime cannot serve: refuse before anything is held.
  const blocked = blockingMessage(await missingModelsSaid(input.definition));
  if (blocked) {
    throw new ModelUnavailableError(blocked);
  }
  // The run's expected cost is held before it starts; what it really costs is booked per call.
  const estimate = await estimateRun(
    input.wizardId,
    input.version,
    input.definition,
    await stepsWithoutModel(input.definition),
  );
  const held = await reserveForRun(
    id,
    estimate.reserve,
    input.mode === "live" && !!input.visitorId,
  );
  if (held === "guest_budget") {
    throw new GuestBudgetError();
  }
  if (!held) {
    throw new NoCreditsError();
  }
  await db.insert(schema.run).values({
    id,
    wizardId: input.wizardId,
    tenantId: currentTenant(),
    definition: input.definition,
    files: input.files,
    version: input.version,
    mode: input.mode,
    runner: input.runner ?? null,
    visitorId: input.visitorId ?? null,
    userId: input.userId ?? null,
    ipHash: input.ipHash ?? null,
    origin: input.origin ?? null,
    lang: input.lang ?? null,
    unattended: input.unattended ?? false,
    client: input.client ?? null,
    status: first.type === "page" ? "waiting_input" : "running",
    cursor: first.id,
    state,
    // Without an account nobody can come back for a result later: it is kept a week.
    expiresAt:
      input.mode === "live"
        ? new Date(Date.now() + env.limits.resultTtlDays * 24 * 60 * 60 * 1000)
        : null,
  });
  await indexRun({ runId: id, visitorId: input.visitorId, ipHash: input.ipHash });
  reportRun(id, first.type === "page" ? "waiting_input" : "running");
  if (first.type !== "page") {
    kick(id);
  }
  return id;
}

/**
 * Puts the run to work: in line in the control database, and — when this process is a runner —
 * taken at once if the tenant has a slot. The web alone leaves it for a runner's next look.
 */
export function kick(runId: string) {
  const tenant = currentTenant();
  void wakeRun(runId)
    .then(() => {
      if (env.role !== "web") {
        return take(runId, tenant);
      }
    })
    .catch((err) => console.error(`[run ${runId}]`, err));
}

/** Claims the run for this process and drives it; nothing when another holds it or the tenant is full. */
async function take(runId: string, tenant: string): Promise<void> {
  if (active.has(runId)) {
    return;
  }
  if (!(await claimRun(runId, tenant, await concurrencyLimit(tenant)))) {
    return;
  }
  const abort = new AbortController();
  active.set(runId, abort);
  // The heartbeat keeps the claim and hears of a cancel the web wrote while a step works.
  const beat = setInterval(() => {
    void heartbeatRuns([runId]).catch((err) => console.warn(`[run ${runId}] heartbeat:`, err));
    // At work all along: the admin app hears it now and then, so a long step is not stuck.
    void withTenant(tenant, () => reportRun(runId, "running")).catch(() => undefined);
    void withTenant(tenant, () => loadRun(runId))
      .then((run) => {
        if (run && run.status !== "running") {
          abort.abort();
        }
      })
      .catch((err) => console.warn(`[run ${runId}] cancel check:`, err));
  }, HEARTBEAT_MS);
  beat.unref();
  await withTenant(tenant, () => drive(runId, abort.signal))
    .catch(async (err) => {
      console.error(`[run ${runId}]`, err);
      await withTenant(tenant, async () => {
        const run = await loadRun(runId);
        const lang = run ? textLang(wizardLang(run.definition)) : "en";
        await updateRun(runId, { status: "failed", error: saidText(friendly(err), lang) });
      }).catch((e) => console.error(`[run ${runId}] marking it failed:`, e));
    })
    .finally(async () => {
      clearInterval(beat);
      active.delete(runId);
      // What fails here leaves the rest of the cleanup to run.
      await withTenant(tenant, () => releaseResources(runId)).catch((err) =>
        console.error(`[run ${runId}] releasing its resources:`, err),
      );
      // A run the shutdown stopped goes back in line for the next runner; the rest is done for now.
      if (!stopping) {
        await restRun(runId).catch((err) => console.error(`[run ${runId}] rest:`, err));
      }
      void withTenant(tenant, () => signalChanged(runId)).catch((err) =>
        console.error(`[run ${runId}] signal:`, err),
      );
      // A slot came free: the next run of the line need not wait for the poll.
      void lookAtLine();
    });
}

let stopping = false;
let looking = false;

/** Takes what waits in line, run by run; each claim counts the tenant's limit by itself. */
async function lookAtLine() {
  if (looking || stopping) {
    return;
  }
  looking = true;
  try {
    for (const r of await waitingRuns()) {
      if (stopping) {
        return;
      }
      await take(r.runId, r.tenantId).catch((err) => console.error(`[line ${r.runId}]`, err));
    }
  } catch (err) {
    console.error("[line]", err);
  } finally {
    looking = false;
  }
}

/** A runner: looks at the line every POLL_MS, from now on. Runs a stopped process left behind are in it. */
export function startRunner() {
  const timer = setInterval(() => void lookAtLine(), POLL_MS);
  timer.unref();
  void lookAtLine();
}

/** Stops the runs this process holds and hands them back to the line. */
export async function stopRunner() {
  stopping = true;
  for (const abort of active.values()) {
    abort.abort();
  }
  await disownRuns().catch(() => undefined);
}

/** What conditions read in this run: answers, outputs, and how many rows each stored list has. */
async function flowValues(run: RunRow, state: RunState): Promise<Record<string, unknown>> {
  const counts: Record<string, number> = {};
  if (run.definition.lists?.length) {
    for (const [id, list] of Object.entries(await storedLists(run))) {
      counts[id] = list.rows.length;
    }
  }
  return branchValues(state.values, state.outputs, counts);
}

/**
 * What a page knows besides the person's input: what its fields' `when` read from before the
 * page (its own earlier answers left out, so a revisit decides on what is typed now) and the
 * choices its `optionsFrom` fields find in the run.
 */
export async function pageContext(run: RunRow, step: PageStep): Promise<Required<PageContext>> {
  const needs = pageNeeds(step.fields);
  const sourced = step.fields.filter((f) => f.optionsFrom);
  const decided = step.fields.some(isDecidedField) ? (run.state.pages?.[step.id]?.shown ?? []) : [];
  if (!needs.length && !sourced.length) {
    return { known: {}, options: {}, cards: {}, decided };
  }
  const all = await flowValues(run, run.state);
  const known = Object.fromEntries(needs.map((ref) => [ref, all[ref]]));
  const lists = sourced.some((f) => f.optionsFrom?.startsWith("lists."))
    ? await storedLists(run)
    : {};
  const options: Record<string, string[]> = {};
  const cards: Record<string, CardOption[]> = {};
  for (const field of sourced) {
    const found = optionsFromData(field.optionsFrom ?? "", run.state.outputs, lists, field.cards);
    if (found.length) {
      options[field.id] = found;
    }
    if (field.cards) {
      const drawn = cardsFromData(field.optionsFrom ?? "", run.state.outputs, field.cards);
      if (drawn.length) {
        cards[field.id] = drawn;
      }
    }
  }
  return { known, options, cards, decided };
}

function viewContext(
  ctx: Required<PageContext>,
): Pick<RunView, "known" | "options" | "cards" | "decidedFields"> {
  return { known: ctx.known, options: ctx.options, cards: ctx.cards, decidedFields: ctx.decided };
}

/** The wizard's lists with the person's rows, by list id. */
async function storedLists(
  run: RunRow,
): Promise<Record<string, { def: ListDef; rows: ListRow[] }>> {
  const scope = scopeOf(run);
  const out: Record<string, { def: ListDef; rows: ListRow[] }> = {};
  for (const def of run.definition.lists ?? []) {
    out[def.id] = { def, rows: await listRows(scope, def) };
  }
  return out;
}

/**
 * What a step works with. A share job works with the same — the run's browser, store and
 * answers — under a step id, progress lines and questions of its own.
 */
export async function makeContext(
  run: RunRow,
  project: ProjectRow,
  state: RunState,
  signal: AbortSignal,
  own: Partial<Pick<StepContext, "stepId" | "emit" | "ask">> = {},
): Promise<StepContext> {
  const store = scopeOf(run);
  const resources = resourcesFor(run.id);
  resources.bind(store);
  const stepId = own.stepId ?? run.cursor ?? "";
  return {
    runId: run.id,
    tenantId: run.tenantId,
    test: run.mode === "test",
    stepId,
    store,
    def: run.definition,
    lang: run.lang,
    files: run.files,
    state,
    scope: {
      def: run.definition,
      state,
      brand: projectProfile(project),
      lists: await storedLists(run),
    },
    project,
    projectFiles: (await projectFiles(project.id)).filter((f) => f.status === "ready"),
    signal,
    resources,
    ask:
      own.ask ??
      ((ask) =>
        run.unattended ? Promise.resolve(null) : askPerson(run.id, { ...ask, stepId }, signal)),
    emit:
      own.emit ?? ((type, message, asset) => emitEvent(run.id, run.cursor, type, message, asset)),
    call: { runId: run.id, stepId },
    chargeUsd: (usd) => addLocalCost(run.id, stepId, usd),
    saveAsset: (input) =>
      saveAsset({
        ...input,
        runId: run.id,
        stepId: input.stepId ?? own.stepId ?? run.cursor,
      }),
  };
}

/** A decided branch is taken only when its pick leads the runner-up by this much. */
const BRANCH_MARGIN = 0.1;

/**
 * Where the run goes after `stepId`: a `when` rule or the next step at once — counted, so a loop
 * stops at its rule's max — or, for `ask` rules, a decision the drive loop makes (`deciding`).
 */
async function advance(run: RunRow, stepId: string, state: RunState): Promise<string | null> {
  const outcome = followRules(run.definition, stepId, await flowValues(run, state), state.loops);
  if (outcome.kind === "decide") {
    state.deciding = stepId;
    return stepId;
  }
  return taken(run.definition, stepId, outcome.rule, outcome.cursor, state);
}

function taken(
  def: WizardDefinition,
  stepId: string,
  rule: number | null,
  cursor: string | null,
  state: RunState,
): string | null {
  const goto = rule === null ? null : stepOf(def, stepId)?.next?.[rule]?.goto;
  if (goto) {
    const key = loopKey(stepId, goto);
    state.loops = { ...state.loops, [key]: (state.loops?.[key] ?? 0) + 1 };
  }
  return cursor;
}

/** What a decision about the run reads: the person's answers and what the steps made so far. */
function runSummary(run: RunRow, state: RunState): Record<string, unknown> {
  const results: Record<string, string> = {};
  for (const step of run.definition.steps) {
    const out = state.outputs[step.id];
    const text = out?.text ?? (out?.json === undefined ? "" : JSON.stringify(out.json));
    if (text) {
      results[step.title] = text.slice(0, 6000);
    }
  }
  return {
    answers: answersAsText({ def: run.definition, state, brand: {} }),
    results,
  };
}

/**
 * The decision over a step's open `ask` rules: one choice among their statements and "none".
 * Kept in the run; a pick that does not lead clearly (where there are probabilities) is none.
 */
async function decideBranch(
  run: RunRow,
  step: Step,
  state: RunState,
  signal: AbortSignal,
): Promise<string | null> {
  const outcome = followRules(run.definition, step.id, {}, state.loops);
  const rules = outcome.kind === "decide" ? outcome.rules : [];
  const criteria: Record<string, string> = {};
  for (const i of rules) {
    criteria[`r${i}`] = step.next?.[i]?.ask ?? "";
  }
  criteria.none = prompt("step", "decide.branch_none");
  await emitEvent(run.id, step.id, "info", { code: "deciding" });
  const decision = await decide({
    state: runSummary(run, state),
    questions: {
      next: {
        type: "choice",
        instructions: prompt("step", "decide.branch"),
        criteria,
      } satisfies DecisionQuestion,
    },
    call: { runId: run.id, stepId: step.id },
    signal,
    charge: (usd) => addLocalCost(run.id, step.id, usd),
  });
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
      at: new Date().toISOString(),
    },
  };
  delete state.deciding;
  if (rule === null) {
    const otherwise = otherwiseOf(run.definition, step.id, state.loops);
    return taken(run.definition, step.id, otherwise.rule, otherwise.cursor, state);
  }
  const goto = step.next?.[rule]?.goto ?? "end";
  return taken(run.definition, step.id, rule, goto === "end" ? null : goto, state);
}

/**
 * The decided fields (`ask`, `group`) of a page a decision keeps, in one call as the run reaches
 * the page. A field whose condition on earlier data already fails is not asked about. With the
 * fields always shown, at most MAX_SHOWN_FIELDS appear.
 */
async function decidePageFields(
  run: RunRow,
  page: PageStep,
  state: RunState,
  signal: AbortSignal,
): Promise<string[]> {
  const values = await flowValues(run, state);
  const own = new Set(page.fields.map((f) => f.id));
  const possible = page.fields.filter(
    (f) =>
      isDecidedField(f) &&
      whenHolds(
        conditionsOf(f.when).filter((c) => !own.has(c.field)),
        values,
      ),
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
  await emitEvent(run.id, page.id, "info", { code: "choosingFields" });
  const decision = await decide({
    state: runSummary(run, state),
    questions,
    call: { runId: run.id, stepId: page.id },
    signal,
    charge: (usd) => addLocalCost(run.id, page.id, usd),
  });
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

async function drive(runId: string, signal: AbortSignal) {
  // The step starts afresh here: a question or a device call another process left has no one
  // waiting.
  await clearStaleAsk(runId);
  await clearDeviceCalls(runId);
  while (!signal.aborted) {
    const run = await loadRun(runId);
    if (run?.status !== "running") {
      return;
    }
    const def = run.definition;
    // A step's `ask` branches wait on a decision before the run goes on.
    const deciding = run.state.deciding ? stepOf(def, run.state.deciding) : undefined;
    if (deciding) {
      const state = structuredClone(run.state);
      try {
        const cursor = await decideBranch(run, deciding, state, signal);
        if (signal.aborted) {
          return;
        }
        await syncRunCost(runId);
        await updateRun(runId, { state, cursor, status: cursor ? "running" : "done", error: null });
      } catch (err) {
        if (signal.aborted) {
          return;
        }
        console.error(`[run ${runId} deciding ${deciding.id}]`, err);
        await failRun(run, deciding.id, err);
        return;
      }
      continue;
    }
    const step = stepOf(def, run.cursor);
    if (!step) {
      await updateRun(runId, { status: "done" });
      return;
    }
    // A page whose fields a decision picks: picked once, as the run reaches it.
    if (step.type === "page" && step.fields.some(isDecidedField) && !run.state.pages?.[step.id]) {
      const state = structuredClone(run.state);
      try {
        const shown = await decidePageFields(run, step, state, signal);
        if (signal.aborted) {
          return;
        }
        state.pages = { ...state.pages, [step.id]: { shown } };
        await syncRunCost(runId);
        await updateRun(runId, { state, error: null });
      } catch (err) {
        if (signal.aborted) {
          return;
        }
        console.error(`[run ${runId} fields of ${step.id}]`, err);
        await failRun(run, step.id, err);
        return;
      }
      continue;
    }
    if (step.type === "result") {
      await updateRun(runId, { status: "done" });
      return;
    }
    if (step.type === "page" || step.type === "review") {
      await updateRun(runId, { status: "waiting_input" });
      // A step that ran is over and the next one is the person's: a phone in a pocket hears it.
      void pushRun(runId, "waiting");
      return;
    }
    if (!(await canSpend())) {
      const message = new NoCreditsError().message;
      await emitEvent(runId, step.id, "error", message);
      await updateRun(runId, { status: "failed", error: message });
      return;
    }
    await emitEvent(runId, step.id, "step_started", step.working ?? step.title);
    const project = await loadProject(run);
    const state = structuredClone(run.state);
    try {
      const output = await runAutomaticStep(step, await makeContext(run, project, state, signal));
      if (signal.aborted) {
        return;
      }
      await syncRunCost(runId);
      state.outputs[step.id] = output;
      delete state.notes[step.id];
      delete state.redo?.[step.id];
      const cursor = await advance(run, step.id, state);
      await updateRun(runId, { state, cursor, status: cursor ? "running" : "done", error: null });
      await emitEvent(runId, step.id, "step_done", step.title);
    } catch (err) {
      if (signal.aborted) {
        return;
      }
      console.error(`[run ${runId} step ${step.id}]`, err);
      await noteFreeTierRefusal(err);
      await failRun(run, step.id, err);
      return;
    }
  }
}

// --- commands ----------------------------------------------------------------

async function requireWaiting(runId: string, stepId: string) {
  const run = await loadRun(runId);
  if (!run) {
    throw new RunConflict("Run not found");
  }
  if (run.status !== "waiting_input" && run.status !== "done") {
    throw new RunConflict({ code: "runBusy" });
  }
  if (run.cursor !== stepId) {
    throw new RunConflict({ code: "pageOutdated" });
  }
  return run;
}

export async function submitPage(runId: string, stepId: string, input: Record<string, unknown>) {
  const run = await requireWaiting(runId, stepId);
  const step = stepOf(run.definition, stepId);
  if (step?.type !== "page") {
    throw new RunConflict("Not a page");
  }
  const { values, errors } = readPageInput(step, input, await pageContext(run, step));
  // An answer that leads to a step without a model here would stop the run there, later.
  const closed = await closedChoices(run.definition, step, run.state.values);
  for (const [id, choice] of Object.entries(closed)) {
    const answer = values[id];
    if (
      answer !== undefined &&
      (choice.values.length === 0 || choice.values.some((v) => String(v) === String(answer)))
    ) {
      errors.push({
        field: id,
        message: note("notAvailableNow"),
      });
    }
  }
  if (errors.length) {
    throw new RunInputError(errors);
  }
  const connections = step.fields.some((f) => f.kind === "connection")
    ? await connectionViews(
        run.definition.connections ?? [],
        scopeOf(run),
        await projectIdOf(run),
        textLang(wizardLang(run.definition)),
      )
    : [];
  for (const field of step.fields) {
    if (field.kind === "image" || field.kind === "file") {
      const value = values[field.id];
      for (const id of Array.isArray(value) ? value : value ? [value] : []) {
        const asset = await db.query.asset.findFirst({ where: eq(schema.asset.id, String(id)) });
        if (asset?.runId !== runId) {
          throw new RunInputError([{ field: field.id, message: note("fileNotFound") }]);
        }
      }
    }
    if (field.kind === "connection") {
      // What the step later reads as {{field}} is the connected account, as the server knows it.
      const account = connections.find((c) => c.id === field.connection)?.account;
      if (account) {
        values[field.id] = account.label;
      } else if (field.required) {
        throw new RunInputError([{ field: field.id, message: note("connectFirst") }]);
      }
    }
  }
  const state = structuredClone(run.state);
  state.values = { ...state.values, ...values };
  // Fields left empty on a revisited page are cleared, not kept from before.
  for (const field of step.fields) {
    if (!(field.id in values)) {
      delete state.values[field.id];
    }
  }
  // Later pages decide their fields again on what is answered now.
  const at = run.definition.steps.indexOf(step);
  for (const later of run.definition.steps.slice(at + 1)) {
    delete state.pages?.[later.id];
  }
  state.history.push(stepId);
  const cursor = await advance(run, stepId, state);
  await updateRun(runId, { state, cursor, status: "running", error: null });
  kick(runId);
}

/** Edited data of a json step is kept up to this size. */
const MAX_EDITED_JSON = 500_000;

/**
 * A json step's output with data someone edited: checked against the step's schema, and what
 * its view shows too. Refused when it does not fit.
 */
export function editedJson(
  def: WizardDefinition,
  stepId: string,
  output: StepOutput,
  data: Record<string, unknown>,
): StepOutput {
  const step = stepOf(def, stepId);
  if (step?.type !== "agent" || step.output.format !== "json" || step.each || step.call) {
    throw new RunConflict("Not a json step");
  }
  if (JSON.stringify(data).length > MAX_EDITED_JSON) {
    throw new RunConflict("Too large");
  }
  const { schema, shape } = outputSchema(step);
  const parsed = schema.safeParse(fitData(shape, data));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new RunConflict(`Does not fit the schema: ${issue?.path.join(".")} ${issue?.message}`);
  }
  const json = parsed.data;
  return {
    ...output,
    json,
    ...(output.surface ? { surface: { ...output.surface, data: json } } : {}),
  };
}

/** Data of a finished or waiting run's json step, edited in the studio. */
export async function editOutput(runId: string, stepId: string, data: Record<string, unknown>) {
  const run = await loadRun(runId);
  const output = run?.state.outputs[stepId];
  if (!run || !output) {
    throw new RunConflict("Unknown step");
  }
  if (run.status !== "waiting_input" && run.status !== "done") {
    throw new RunConflict({ code: "runBusy" });
  }
  const state = structuredClone(run.state);
  state.outputs[stepId] = editedJson(run.definition, stepId, output, data);
  await updateRun(runId, { state });
}

export type ReviewAction =
  | { type: "accept"; edits?: Record<string, string | Record<string, unknown>> }
  | { type: "regenerate"; target: string; note: string; items?: number[] };

export async function reviewStep(runId: string, stepId: string, action: ReviewAction) {
  const run = await requireWaiting(runId, stepId);
  const step = stepOf(run.definition, stepId);
  if (step?.type !== "review") {
    throw new RunConflict("Not a review");
  }
  const state = structuredClone(run.state);
  if (action.type === "accept") {
    for (const [target, edit] of Object.entries(action.edits ?? {})) {
      const output = state.outputs[target];
      if (!step.edit || !step.show.includes(target) || !output) {
        continue;
      }
      if (typeof edit === "string") {
        state.outputs[target] = { ...output, text: edit.slice(0, 50_000) };
      } else {
        state.outputs[target] = editedJson(run.definition, target, output, edit);
      }
    }
    state.history.push(stepId);
    const cursor = await advance(run, stepId, state);
    await updateRun(runId, { state, cursor, status: "running", error: null });
    kick(runId);
    return;
  }
  if (!step.show.includes(action.target)) {
    throw new RunConflict("Unknown target");
  }
  state.notes[action.target] = action.note.slice(0, 2000) || "Please make a new variant.";
  // A step with several results makes only the named ones again.
  if (action.items?.length) {
    state.redo = { ...state.redo, [action.target]: action.items };
  } else {
    delete state.redo?.[action.target];
  }
  await updateRun(runId, { state, cursor: action.target, status: "running", error: null });
  await emitEvent(runId, action.target, "info", "Wird neu erstellt …");
  kick(runId);
}

export async function goBack(runId: string) {
  const run = await loadRun(runId);
  if (
    !run ||
    (run.status !== "waiting_input" && run.status !== "done" && run.status !== "failed")
  ) {
    throw new RunConflict({ code: "runBusy" });
  }
  const state = structuredClone(run.state);
  const previous = state.history.pop();
  if (!previous) {
    throw new RunConflict({ code: "noStepBefore" });
  }
  // A decision that failed belongs to the step left behind.
  delete state.deciding;
  await updateRun(runId, { state, cursor: previous, status: "waiting_input", error: null });
}

export async function retry(runId: string) {
  const run = await loadRun(runId);
  if (run?.status !== "failed") {
    throw new RunConflict("Nothing to retry");
  }
  await updateRun(runId, { status: "running", error: null });
  kick(runId);
}

export async function cancel(runId: string) {
  active.get(runId)?.abort();
  await updateRun(runId, { status: "cancelled" });
}

// --- view --------------------------------------------------------------------

/** The formats a deliverable can really be downloaded in: a still widget has no video. */
export async function availableFormats(step: Step, run: RunRow, wanted?: Format[]) {
  const possible = formatsFor(step);
  let formats = wanted ? wanted.filter((f) => possible.includes(f)) : possible;
  const output = run.state.outputs[step.id];
  if (step.type === "widget" && formats.includes("mp4")) {
    // A film is rendered when its step runs; any other widget on demand.
    const has = step.video
      ? output?.assets?.some((a) => a.kind === "video")
      : output?.widget?.duration && (await hasFfmpeg());
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

/**
 * What the page's fields start with: an earlier step's result where they name one, and for a
 * choice whose default leads to a step without a model here, the first value that does not.
 */
function prefillOf(
  step: PageStep,
  run: RunRow,
  closed: Record<string, ClosedChoice>,
): Record<string, unknown> {
  const scope = { def: run.definition, state: run.state, brand: {} };
  const out: Record<string, unknown> = {};
  for (const field of step.fields) {
    if (!field.prefill) {
      continue;
    }
    const value = resolveRef(dataRef(field.prefill), scope);
    if (value !== undefined && value !== null && value !== "") {
      out[field.id] = value;
    }
  }
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
 * Whether a run may hold a live conversation: live voice or video call is switched on for the
 * tenant, a speech model is set up, and the wizard has one of them on. Its owner's test run
 * always may, where one of them is switched on.
 */
export async function talkAllowed(run: RunRow): Promise<boolean> {
  const off = await switchedOffRunners();
  if (CONVERSATION_RUNNERS.every((id) => off.has(id)) || !(await conversationAvailable())) {
    return false;
  }
  if (run.mode === "test") {
    return true;
  }
  const w = await db.query.wizard.findFirst({ where: eq(schema.wizard.id, run.wizardId) });
  const { enabled } = w?.runners ?? DEFAULT_RUNNER_SETTINGS;
  return enabled.some((id) => CONVERSATION_RUNNERS.includes(id) && !off.has(id));
}

export async function runView(run: RunRow, brand: RunView["brand"]): Promise<RunView> {
  // In the viewer's language every text of the view is the translation; ids and values stay.
  const memory = run.lang ? await storedTranslation(run.wizardId, run.lang) : null;
  const translated = memory ? translateDefinition(run.definition, memory) : null;
  const def = translated?.def ?? run.definition;
  const step = stepOf(def, run.cursor) ?? null;
  const closed =
    step?.type === "page" && run.status === "waiting_input"
      ? await closedChoices(def, step, run.state.values)
      : {};
  const index = step ? def.steps.indexOf(step) : def.steps.length;
  const refs =
    step?.type === "review"
      ? step.show
      : step?.type === "result"
        ? [...new Set(step.deliverables.map((d) => d.from))]
        : [];
  const shownIds = refs.filter((ref) => !listRef(ref));
  const listIds = [
    ...refs.map(listRef),
    ...(step?.type === "page" ? step.fields.map((f) => (f.kind === "list" ? f.list : null)) : []),
  ].filter((id): id is string => Boolean(id));
  const stored = listIds.length ? await storedLists(run) : {};
  const lists: ShownList[] = [...new Set(listIds)]
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
  const shown = await Promise.all(
    shownIds
      .map((id) => stepOf(def, id))
      .filter((s): s is Step => Boolean(s))
      .map(async (s) => {
        const deliverable =
          step?.type === "result" ? step.deliverables.find((d) => d.from === s.id) : undefined;
        return {
          step: s,
          output: run.state.outputs[s.id] ?? null,
          formats: await availableFormats(s, run, deliverable?.formats),
          label: deliverable?.label ?? null,
        };
      }),
  );
  return {
    id: run.id,
    status: run.status,
    mode: run.mode,
    wizard: {
      title: def.title,
      description: def.description,
      avatar: def.avatar,
      costume: def.costume,
      intro: def.intro,
    },
    lang: wizardLang(run.definition),
    translation:
      run.lang && memory && translated
        ? {
            lang: run.lang,
            labels: translated.labels,
            machine: machineTranslated(memory, run.definition),
            results: run.state.translated?.[run.lang] ?? {},
          }
        : null,
    talk: await talkAllowed(run),
    step,
    answered: run.state.history.map((id) => stepOf(def, id)).filter((s): s is Step => Boolean(s)),
    values: run.state.values,
    prefill: step?.type === "page" ? prefillOf(step, run, closed) : {},
    ...(step?.type === "page" ? viewContext(await pageContext(run, step)) : {}),
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
      shownIds.map((id) => [id, run.state.outputs[id]]).filter(([, o]) => o),
    ),
    shown,
    progress: { done: run.status === "done" ? def.steps.length : index, total: def.steps.length },
    canBack: run.state.history.length > 0 && run.status !== "running",
    error: run.error,
    // A step's own words as it starts ("working") are the wizard's: in its translation too.
    events: (await recentEvents(run.id, 0, 30)).map((ev) =>
      memory?.[ev.message] && !ev.note ? { ...ev, message: memory[ev.message].text } : ev,
    ),
    brand,
    ask: run.status === "running" ? run.ask : null,
    lists,
    connections:
      step?.type === "page" && step.fields.some((f) => f.kind === "connection")
        ? await connectionViews(
            def.connections ?? [],
            scopeOf(run),
            await projectIdOf(run),
            textLang(wizardLang(def)),
          )
        : [],
    keeps:
      Boolean(def.lists?.length || def.connections?.length) ||
      // An account connected for sharing is kept too, and can be deleted the same way.
      (run.status === "done" && (await listSecrets(scopeOf(run))).length > 0),
    shareUrl: run.shareToken ? `${env.publicUrl}/s/${run.shareToken}` : null,
    expiresAt: run.expiresAt?.toISOString() ?? null,
    shareJob: run.status === "done" ? await latestShareJob(run.id) : null,
  };
}
