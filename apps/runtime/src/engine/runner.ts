import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import {
  type ChoiceAnswer,
  type DecisionQuestion,
  marginOf,
} from "@engenty/wizards-shared/decision";
import {
  type AheadForm,
  type AheadRule,
  allFields,
  branchValues,
  type CardOption,
  cardsFromData,
  conditionMatches,
  dataRef,
  type Format,
  type FormStep,
  followRules,
  formatsFor,
  formNeeds,
  isDataStep,
  isDecidedField,
  LIST_FORMATS,
  listRef,
  MAX_SHOWN_FIELDS,
  optionsFromData,
  outputOf,
  type ReviewStep,
  RUN_DONE_SIGNAL,
  type Step,
  sectionOf,
  sectionsOf,
  signalMissing,
  textLang,
  type WaitStep,
  type WizardDefinition,
  waitDurationMs,
  whenCalc,
  whenNames,
  whenValue,
  wizardLang,
} from "@engenty/wizards-shared/definition";
import { agentsMismatch, requiresOf, withRequires } from "@engenty/wizards-shared/requires";
import type {
  AskInput,
  RunNote,
  RunPause,
  RunSignIn,
  RunStatus,
  Said,
  StepOutput,
} from "@engenty/wizards-shared/run";
import {
  CAN_GO_BACK,
  type ClosedChoice,
  isNoteTime,
  note,
  RUN_ENDED,
  type RunState,
  type RunView,
  type ShownList,
  saidText,
} from "@engenty/wizards-shared/run";
import { CONVERSATION_RUNNERS, DEFAULT_RUNNER_SETTINGS } from "@engenty/wizards-shared/runners";
import { fitData } from "@engenty/wizards-shared/shape";
import type { StartEvent, StartedBy } from "@engenty/wizards-shared/starts";
import type { ListDef, ListRow } from "@engenty/wizards-shared/store";
import {
  type FlowEvent,
  type FlowFailure,
  type FlowHost,
  FlowRefused,
  type FlowResult,
  type FlowRun,
  transition,
} from "@engenty/wizards-shared/transition";
import { machineTranslated, translateDefinition } from "@engenty/wizards-shared/translation";
import { wizardAgentsUsed } from "@engenty/wizards-shared/wizard-code";
import type { WorkspaceFile } from "@engenty/wizards-shared/workspace";
import { and, eq, lt, notInArray, type SQL, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { currentImpersonator } from "../auth/impersonation.js";
import { effectsOn, enterVisit } from "../broker/effect.js";
import { grantNote, grantOf, inAudience, type KnownConnector, kindOf } from "../broker/index.js";
import { runHolder, subjectsOf } from "../broker/rwx.js";
import { resolveConnector } from "../connectors/external.js";
import { connectionViews, connectorOptions } from "../connectors/index.js";
import { spaceConnectionOf } from "../connectors/space-connections.js";
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
import { feature, remoteFeatures } from "../features.js";
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
  takeMasked,
} from "../models.js";
import { runEnded } from "../plugins/events.js";
import { pluginsOf as loadedPlugins } from "../plugins/registry.js";
import { prompt } from "../prompts.js";
import {
  ContentBlockedError,
  checkGuestInput,
  checkGuestText,
  guestChecksOn,
  guestRun,
} from "../safety.js";
import { sandboxDataHost } from "../sandbox/data.js";
import { peerTicket } from "../secrets/signing.js";
import { isAdminRole, nameOf } from "../services/access.js";
import { snapshotFile } from "../services/files.js";
import { reportRun } from "../services/manage-reports.js";
import { switchedOffRunners } from "../services/runners.js";
import { spaceFiles } from "../services/space-files.js";
import { brandSpaceId } from "../services/space-parent.js";
import { spaceProfile } from "../services/spaces.js";
import { storedTranslation } from "../services/translations.js";
import { decidedHeld, holdReview } from "../services/work-approvals.js";
import { latestShareJob } from "../sharing/state.js";
import { dataRequirement } from "../store/data.js";
import { listRows, listSecrets, scopeOf } from "../store/index.js";
import {
  claimRun,
  disownRuns,
  heartbeatRuns,
  indexRun,
  markLine,
  otherRunners,
  restRun,
  setWake,
  waitingRuns,
  wakeDue,
  wakeRun,
} from "../tenants/control.js";
import { currentTenant, currentTenantOrNull } from "../tenants/tenant.js";
import { hasOwnAccount } from "../upstreams.js";
import { type Caller, whoOf } from "./answerers.js";
import { type AskResult, askPerson, clearStaleAsk } from "./asks.js";
import { decide } from "./decide.js";
import { clearDeviceCalls } from "./device.js";
import { newTurn, TurnAsks, turnOf } from "./durable-turn.js";
import { emitEvent, recentEvents, saidInVisit, signalChanged, visitLeftOpen } from "./events.js";
import { classifyFailure, type Failure } from "./failures.js";
import { type FormContext, type InputError, readFormInput } from "./input.js";
import { withMailText } from "./mail-watch.js";
import {
  type Actor,
  type NoticeKind,
  type NoticeValues,
  noticeFor,
  noticesFor,
  noticeWrites,
} from "./notices.js";
import { pushRun } from "./push.js";
import {
  blockingMessage,
  closedChoices,
  maskedNote,
  missingConnectionsSaid,
  missingModelsSaid,
  openValue,
  stepsWithoutModel,
  tierRefusalSaid,
} from "./requirements.js";
import { liveResources, releaseResources, resourcesFor } from "./resources.js";
import {
  dropWait,
  findSignal,
  registerWait,
  runScope,
  SPACE_SCOPE,
  sendSignal,
} from "./signals.js";
import { startedRunEnded, startOf } from "./starts.js";
import { outputSchema, runAutomaticStep } from "./steps.js";
import { surfaceData } from "./surface.js";
import { answersAsText, fillLabel, renderTemplate, resolveRef } from "./template.js";
import type { RunHolder, RunRow, SpaceRow, StepContext } from "./types.js";
import { SignInNeeded, StepError } from "./types.js";
import { wizardAgentFiles } from "./wizard-code.js";

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

/** A step past its deadline (`env.runner.stepDeadlines`): it fails, and its slot comes free. */
class StepDeadline extends NotedError {
  constructor() {
    super(note("stepTookTooLong"));
  }
}

/** This time of a start began a run already: the database refused a second one. */
export class OccurrenceTaken extends Error {}

/** Another runner claimed the run while this one drove it: this drive ends, without a word on the run. */
class LostClaim extends Error {}

/** The run this drive works on and its claim; empty outside `drive`. */
const driving = new AsyncLocalStorage<{ runId: string; generation: number }>();

/** The runs this process drives right now, with the handle that stops each. */
const active = new Map<string, AbortController>();

// --- the line ------------------------------------------------------------------
// A run that wants work is marked in the control database (`wakeRun`); a runner claims it there,
// so several processes share one line. A tenant's runs beyond its limit stay in line; nothing is
// refused. See docs/plans/runner-process.md.

/** How often a runner looks at the line, and how often it reports on the runs it holds. */
const POLL_MS = 2000;
const HEARTBEAT_MS = 10_000;
/** A run holding a slot this long goes into the log, once: what real steps take. It stops nothing. */
const LONG_HOLD_MS = 60 * 60_000;

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

/** Puts a claim on the run's own row; an older claim that arrives late changes nothing. */
async function holdRun(runId: string, generation: number) {
  await db
    .update(schema.run)
    .set({ claim: generation })
    .where(and(eq(schema.run.id, runId), lt(schema.run.claim, generation)));
}

async function loadRun(runId: string): Promise<RunRow | undefined> {
  return db.query.run.findFirst({ where: eq(schema.run.id, runId) });
}

/** The space a run's wizard belongs to — where its imported connectors live. */
export async function spaceIdOf(run: Pick<RunRow, "wizardId">): Promise<string> {
  const w = await db.query.wizard.findFirst({ where: eq(schema.wizard.id, run.wizardId) });
  return w?.spaceId ?? "";
}

export async function loadSpace(run: RunRow): Promise<SpaceRow> {
  const w = await db.query.wizard.findFirst({ where: eq(schema.wizard.id, run.wizardId) });
  const p = w && (await db.query.space.findFirst({ where: eq(schema.space.id, w.spaceId) }));
  if (!p) {
    throw new Error("space missing");
  }
  return p;
}

/** Where a run's data is: the space it carries, else its wizard's space. */
async function dataSpaceOf(run: RunRow, space: SpaceRow): Promise<{ id: string; name: string }> {
  if (!run.clientSpaceId) {
    return { id: space.id, name: space.name };
  }
  const client = await db.query.space.findFirst({
    columns: { id: true, name: true },
    where: eq(schema.space.id, run.clientSpaceId),
  });
  if (!client) {
    throw new Error("space missing");
  }
  return client;
}

/** The statuses that tell someone, and what the notice says. */
const TOLD: Partial<Record<RunRow["status"], NoticeKind>> = {
  waiting_input: "needs_you",
  done: "done",
  failed: "failed",
};

/**
 * The reminder of a person's step, written with the wait and due at `remind`. It goes by the same
 * key as the wait, so an answer or a timeout settles it, and it replaces the last wait's. It reaches
 * whoever the step asks. Whoever opened the page themselves has left by then, if they are not
 * looking: it has no `by`.
 */
async function remindersOf(
  run: Parameters<typeof noticesFor>[0],
  step: Step | undefined,
): Promise<NoticeValues[]> {
  if (!isPersonStep(step) || !step.remind || !(await durableRunsOn())) {
    return [];
  }
  return noticesFor(run, "reminder", {
    step,
    waitKey: `step:${step.id}`,
    detail: step.title,
    dueAt: new Date(Date.now() + waitDurationMs(step.remind)),
  });
}

/** The notices a status change writes, one per person told. A notice never breaks a run. */
async function noticesOfStatus(
  runId: string,
  patch: Partial<typeof schema.run.$inferInsert>,
  by?: Actor,
): Promise<NoticeValues[]> {
  const kind = patch.status && TOLD[patch.status];
  if (!kind) {
    return [];
  }
  try {
    const run = await db.query.run.findFirst({ where: eq(schema.run.id, runId) });
    if (!run) {
      return [];
    }
    const cursor = patch.cursor === undefined ? run.cursor : patch.cursor;
    const step = stepOf(run.definition, cursor);
    const told = await noticesFor(run, kind, {
      by,
      step: kind === "needs_you" ? step : null,
      waitKey: kind === "needs_you" && cursor ? `step:${cursor}` : null,
      detail:
        kind === "needs_you" ? step?.title : kind === "failed" ? (patch.error ?? run.error) : null,
    });
    return kind === "needs_you" ? [...told, ...(await remindersOf(run, step))] : told;
  } catch (err) {
    console.error(`[notices] run ${runId}:`, err);
    return [];
  }
}

/**
 * What a run's move does to a held approval: a review with `approve` for the team is held while the
 * run waits on it. A held row never breaks a run.
 */
async function moveHeld(runId: string, patch: Partial<typeof schema.run.$inferInsert>) {
  if (!((patch.status || patch.cursor !== undefined) && (await durableRunsOn()))) {
    return;
  }
  try {
    const run = await db.query.run.findFirst({ where: eq(schema.run.id, runId) });
    if (!run) {
      return;
    }
    const step = stepOf(run.definition, run.cursor);
    await holdReview(
      run,
      run.status === "waiting_input" &&
        step?.type === "review" &&
        step.approve &&
        whoOf(step) === "team"
        ? { stepId: step.id, title: step.title }
        : null,
    );
  } catch (err) {
    console.error(`[approvals] run ${runId}:`, err);
  }
}

/**
 * Writes the run. Inside its drive the write needs the drive's claim; with `seen`, a person's write
 * needs the `rev` it read, and a wait's write the status it came from: a cancel wins over either. A
 * step may start or answer other runs: only its own run's claim counts. With `"open"` the write
 * holds only on a run that has not ended, and says with `false` that it found none.
 */
async function updateRun(
  runId: string,
  patch: Partial<typeof schema.run.$inferInsert>,
  seen?: { rev: number } | { status: RunStatus } | "open",
  by?: Actor,
): Promise<boolean> {
  const holder = driving.getStore();
  const held = holder?.runId === runId ? holder : undefined;
  const where = and(
    eq(schema.run.id, runId),
    held ? eq(schema.run.claim, held.generation) : undefined,
    seen === "open"
      ? notInArray(schema.run.status, [...RUN_ENDED])
      : seen && ("rev" in seen ? eq(schema.run.rev, seen.rev) : eq(schema.run.status, seen.status)),
  ) as SQL;
  const write = db
    .update(schema.run)
    .set({
      ...patch,
      // A run that rests has no drive to break off, whatever becomes of this process now.
      ...(patch.status && patch.status !== "running" ? { driving: false } : {}),
      rev: sql`${schema.run.rev} + 1`,
      updatedAt: new Date(),
    })
    .where(where);
  // The notices go in with the status: all of it happens, or none.
  const notices = await noticesOfStatus(runId, patch, by);
  const result = notices.length
    ? (
        (await db.batch([...noticeWrites(notices, where), write] as never)) as {
          rowsAffected: number;
        }[]
      ).at(-1)
    : await write;
  if (result?.rowsAffected === 0) {
    if (held) {
      throw new LostClaim();
    }
    if (seen === "open") {
      return false;
    }
    if (seen) {
      throw new RunConflict({ code: "runBusy" });
    }
  }
  await moveHeld(runId, patch);
  // A run that waits holds no credits: it reserves again when it wakes.
  if (patch.status === "sleeping" || patch.status === "waiting_signal") {
    await releaseRun(runId);
  }
  // A run that ended needs no credits held for it any more.
  if (patch.status === "done" || patch.status === "failed" || patch.status === "cancelled") {
    await releaseRun(runId);
    await dropWait(runId);
    await tellRunEnded(runId, patch.status);
    // Plugins hear of it; the run does not wait for them.
    void runEnded(runId, patch.status);
    if (patch.status !== "cancelled") {
      void pushRun(runId, patch.status);
    }
    // A start's run that ended: the start counts it, the owner hears of it.
    void startedRunEnded(runId, patch.status);
  }
  if (patch.status) {
    reportRun(runId, patch.status);
  }
  signalChanged(runId);
  return true;
}

/**
 * A run's end, as a signal keyed by its id: another run can wait for it. `data.status` says how it
 * ended; a failed run that is tried again and then finishes says so once more.
 */
async function tellRunEnded(runId: string, status: "done" | "failed" | "cancelled") {
  if (!(await durableRunsOn())) {
    return;
  }
  try {
    const run = await db.query.run.findFirst({
      where: eq(schema.run.id, runId),
      columns: { wizardId: true },
    });
    if (run) {
      await sendSignal({
        spaceId: await spaceIdOf(run),
        scope: SPACE_SCOPE,
        name: RUN_DONE_SIGNAL,
        key: runId,
        data: { status, wizardId: run.wizardId },
        source: "run",
        delivery: status,
      });
    }
  } catch (err) {
    // The run has ended either way; whoever waits for it has its timeout.
    console.warn(`[run ${runId}] telling of its end:`, (err as Error).message);
  }
}

function stepOf(def: WizardDefinition, id: string | null): Step | undefined {
  return id ? def.steps.find((s) => s.id === id) : undefined;
}

/** What a failure is read against: the cloud, and an organization on its own provider accounts. */
function failureContext() {
  return { managed, ownAccount: managed && hasOwnAccount(currentTenantOrNull()) };
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
  if (
    /insufficient_credits|\b402\b/i.test(msg) ||
    classifyFailure(err, failureContext()).why === "credits"
  ) {
    return saidOf(new NoCreditsError());
  }
  // A runtime that runs alone pays its provider itself: its admin can top the account up. So
  // does an organization whose calls run on its own accounts.
  if (
    (!managed || failureContext().ownAccount) &&
    /minimum balance|insufficient_funds|top up your credits/i.test(msg)
  ) {
    return note("providerCreditLow");
  }
  if (/rate.?limit|429/i.test(msg)) {
    return note("aiServiceBusyRight");
  }
  if (/timeout|timed out/i.test(msg)) {
    return note("stepTookTooLong");
  }
  const { why } = classifyFailure(err, failureContext());
  if (why === "rate_limit") {
    return note("aiServiceBusyRight");
  }
  if (why === "timeout") {
    return note("stepTookTooLong");
  }
  if (why === "server" || why === "network") {
    return note("aiServiceNotReached");
  }
  // The platform's own provider account (budget, quota, key): nothing the person can fix.
  if (
    /budget|quota|insufficient|billing|credit balance|api key|unauthori[sz]ed|401|403/i.test(msg)
  ) {
    return note("aiServiceNotReached");
  }
  return note("stepFailed", { detail: msg.slice(0, 300) });
}

// --- creating & driving ------------------------------------------------------

/** The wizard's `label` from what the run knows so far; null without one. */
async function labelOf(def: WizardDefinition, state: RunState): Promise<string | null> {
  return def.label && (await durableRunsOn())
    ? fillLabel(def.label, { def, state, brand: {} })
    : null;
}

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
  /** The space it runs in where that is not its wizard's, or a client's (docs/plans/org-spaces.md). */
  clientSpaceId?: string | null;
  /** The Work chat it was started from (docs/plans/org-spaces.md). */
  chatId?: string | null;
  /**
   * A start began the run, nobody is there: `start` is what started it, `fill` the answers it
   * brings. Pages are filled as the run reaches them; what is missing waits for the owner.
   */
  startedBy?: StartedBy | null;
  start?: StartEvent;
  fill?: Record<string, unknown>;
  /** Which time of the start this is (`occurrenceKey`): a second run of it is refused. */
  occurrence?: string;
}): Promise<string> {
  const id = nanoid(18);
  const first = input.definition.steps[0];
  // A started run fills its first page itself, in the drive loop.
  const waits = first.type === "form" && !input.startedBy;
  const state: RunState = { values: {}, outputs: {}, history: [], notes: {} };
  if (input.startedBy) {
    state.start = input.start;
    state.fill = input.fill ?? {};
  }
  // What `requires` says of the wizard's agents is what their files say: the checks before the
  // start read it. A definition that comes without `requires` gets it from the files. An agent
  // without a file fails at its step.
  if (wizardAgentsUsed(input.definition).length) {
    const { agents } = await wizardAgentFiles(
      input.files.map((f) => f.path),
      async (path) => (await snapshotFile(input.files, path))?.data.toString("utf8") ?? null,
    );
    if (!input.definition.requires) {
      input.definition = withRequires(input.definition, agents);
    }
    const [stale] = agentsMismatch(input.definition, agents);
    if (stale) {
      console.warn(`[run] ${stale.message}`);
      throw new ModelUnavailableError(note("agentNeedsChanged", { name: stale.name }));
    }
  }
  // What the wizard needs and this runtime lacks: nothing starts. Off, nothing starts that would
  // need the clock; a run that already waits goes on.
  const requires = input.definition.requires ?? requiresOf(input.definition);
  const switches = await remoteFeatures().catch(() => null);
  for (const name of requires.features ?? []) {
    if (!feature(name, switches)) {
      throw new ModelUnavailableError(note(name === "durableRuns" ? "waitsOff" : "codeStepsOff"));
    }
  }
  const installed = new Set((await loadedPlugins(currentTenant())).map((p) => p.source.id));
  const lacking = (requires.plugins ?? []).filter((p) => !installed.has(p));
  if (lacking.length) {
    throw new ModelUnavailableError(note("pluginsMissing", { plugins: lacking.join(", ") }));
  }
  // The wizard's own database (`requires.data`, `data`): a runtime that keeps none refuses here.
  const noData = dataRequirement(input.definition);
  if (noData) {
    throw new ModelUnavailableError(noData);
  }
  // A step every run passes through needs a model this runtime cannot serve, or a connection none
  // of whose connectors connects here: refuse before anything is held.
  const blocked = blockingMessage([
    ...(await missingModelsSaid(input.definition)),
    ...(await missingConnectionsSaid(input.definition, await spaceIdOf(input))),
  ]);
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
  // What the run may reach outside, from the definition it starts on: fixed here, never widened.
  const grant = grantOf(input.definition);
  // Without an account nobody can come back for a result later: it is kept a week. A run that
  // carries its space is kept with that space.
  const expiresAt =
    input.mode === "live" && !input.clientSpaceId
      ? new Date(Date.now() + env.limits.resultTtlDays * 24 * 60 * 60 * 1000)
      : null;
  // A first page waits at once, with the deadline the flow gives it.
  const started = transition(
    input.definition,
    { cursor: null, status: "running", state, wakeAt: null },
    { kind: "start" },
    await flowHost(input.definition),
  );
  const deadline = waits
    ? await deadlineOf({ expiresAt }, first, started.run.wakeAt)
    : { wakeAt: null };
  const insert = db
    .insert(schema.run)
    .values({
      id,
      wizardId: input.wizardId,
      tenantId: currentTenant(),
      definition: input.definition,
      files: input.files,
      grant,
      version: input.version,
      mode: input.mode,
      runner: input.runner ?? null,
      visitorId: input.visitorId ?? null,
      userId: input.userId ?? null,
      impersonatedBy: currentImpersonator()?.adminId ?? null,
      ipHash: input.ipHash ?? null,
      origin: input.origin ?? null,
      lang: input.lang ?? null,
      unattended: input.unattended ?? false,
      client: input.client ?? null,
      clientSpaceId: input.clientSpaceId ?? null,
      chatId: input.chatId ?? null,
      startedBy: input.startedBy ?? null,
      occurrence: input.occurrence ?? null,
      status: waits ? "waiting_input" : "running",
      cursor: first.id,
      state,
      label: await labelOf(input.definition, state),
      expiresAt,
      ...deadline,
    })
    .onConflictDoNothing({ target: [schema.run.wizardId, schema.run.occurrence] });
  // Whoever starts a run stands on its first page: today that tells nobody, by `noticesFor`'s rule.
  const facts = {
    id,
    wizardId: input.wizardId,
    userId: input.userId ?? null,
    visitorId: input.visitorId ?? null,
    runner: input.runner ?? null,
    unattended: input.unattended ?? false,
    impersonatedBy: currentImpersonator()?.adminId ?? null,
    startedBy: input.startedBy ?? null,
    mode: input.mode,
  };
  const notices = waits
    ? [
        ...(await noticesFor(facts, "needs_you", {
          detail: first.title,
          waitKey: `step:${first.id}`,
          by: { userId: input.userId, visitorId: input.visitorId },
          step: first,
        })),
        ...(await remindersOf(facts, first)),
      ]
    : [];
  const inserted = notices.length
    ? (
        (await db.batch([insert, ...noticeWrites(notices, eq(schema.run.id, id))] as never)) as {
          rowsAffected: number;
        }[]
      )[0]
    : await insert;
  if (inserted.rowsAffected === 0) {
    await releaseRun(id);
    throw new OccurrenceTaken();
  }
  if (await durableRunsOn()) {
    const name = input.userId ? await nameOf(input.userId) : null;
    await emitEvent(
      id,
      null,
      "run_started",
      name ? note("runStartedBy", { name }) : note("runStarted"),
    );
  }
  const may = grantNote(
    grant,
    input.definition,
    await grantConnectors(input.wizardId, input.definition),
  );
  if (may) {
    await emitEvent(id, first.id, "info", may);
  }
  await indexRun({
    runId: id,
    visitorId: input.visitorId,
    ipHash: input.ipHash,
    wakeAt: deadline.wakeAt,
  });
  if (waits) {
    await waitsForAnswer(id, first, deadline.wakeAt);
  }
  reportRun(id, waits ? "waiting_input" : "running");
  if (!waits) {
    kick(id);
  }
  return id;
}

/**
 * The wizard's connectors as the space has them, by connection id, for the line that says what
 * the run may do: their names, and what kind each action is. A connector the space does not have
 * is left out; the line then names the connection as the definition does.
 */
async function grantConnectors(
  wizardId: string,
  definition: WizardDefinition,
): Promise<Record<string, KnownConnector>> {
  const out: Record<string, KnownConnector> = {};
  const imported = (definition.connections ?? []).filter((c) => c.connector);
  if (!imported.length) {
    return out;
  }
  const spaceId = await spaceIdOf({ wizardId });
  for (const c of imported) {
    const resolved = await resolveConnector(spaceId, c.connector as string).catch(() => null);
    if (resolved) {
      out[c.id] = {
        name: resolved.connector.name,
        kinds: Object.fromEntries(
          resolved.connector.actions.map((a) => [a.id, kindOf(a.group)] as const),
        ),
      };
    }
  }
  return out;
}

/**
 * Puts the run to work: in line in the control database, and — when this process is a runner
 * (`runner`, `all`) — taken at once if the tenant has a slot. The studio and the doors leave it
 * for a runner's next look.
 */
export function kick(runId: string) {
  const tenant = currentTenant();
  void wakeRun(runId)
    .then(() => (env.serves.runner ? take(runId, tenant) : nudgeRunner(runId, tenant)))
    .catch((err) => console.error(`[run ${runId}]`, err));
}

/**
 * A process without a runner tells one at once, so the run does not wait for a runner's next look
 * at the line (`POLL_MS`). A runner that cannot take it, or does not answer, changes nothing: the
 * line still has the run, and the next look takes it.
 */
async function nudgeRunner(runId: string, tenant: string) {
  const runners = await otherRunners();
  const runner = runners[Math.floor(Math.random() * runners.length)];
  if (!runner) {
    return;
  }
  try {
    await fetch(`${runner.url}/api/peer/runs/${encodeURIComponent(runId)}/take`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${peerTicket(runId, tenant)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ tenant }),
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // The line has the run: the runner's next look takes it.
  }
}

/** Another process of this runtime asks this runner to take a run now (routes/peer.ts). */
export function takeNow(runId: string, tenant: string) {
  if (!env.serves.runner) {
    return false;
  }
  void take(runId, tenant).catch((err) => console.error(`[run ${runId}]`, err));
  return true;
}

/** The claim in the control database, and on the run's own row, where this process's writes need it. */
async function claimAndHold(runId: string, tenant: string): Promise<number | null> {
  const generation = await claimRun(runId, tenant, await concurrencyLimit(tenant));
  if (generation !== null) {
    await withTenant(tenant, () => holdRun(runId, generation));
  }
  return generation;
}

/**
 * Claims the run for this process and starts driving it; nothing when another holds it, or the
 * tenant or this process is full. Answers once the run is claimed: driving takes as long as the
 * steps do, and the line goes on meanwhile.
 */
async function take(runId: string, tenant: string): Promise<void> {
  if (active.has(runId) || active.size >= env.runner.maxRuns) {
    return;
  }
  // The slot counts from here, so takes at the same moment stay under the cap.
  const abort = new AbortController();
  active.set(runId, abort);
  let generation: number | null = null;
  try {
    generation = await claimAndHold(runId, tenant);
  } finally {
    // A claim that could not be held passes on with its silence (RUNNER_STALE_MS).
    if (generation === null) {
      active.delete(runId);
    }
  }
  if (generation !== null) {
    void driveClaimed(runId, tenant, generation, abort);
  }
}

/** Drives a claimed run to its next wait, and gives it back. */
async function driveClaimed(
  runId: string,
  tenant: string,
  generation: number,
  abort: AbortController,
): Promise<void> {
  const heldSince = Date.now();
  let longHoldReported = false;
  // The heartbeat keeps the claim, and hears of a cancel the web wrote or of a newer claim while a
  // step works.
  const beat = setInterval(() => {
    void heartbeatRuns([runId]).catch((err) => console.warn(`[run ${runId}] heartbeat:`, err));
    // At work all along: the admin app hears it now and then, so a long step is not stuck.
    void withTenant(tenant, () => reportRun(runId, "running")).catch(() => undefined);
    void withTenant(tenant, () => loadRun(runId))
      .then((run) => {
        // A run woken from its wait still says so for the moment its drive reserves credits.
        const working =
          run?.status === "running" ||
          run?.status === "sleeping" ||
          run?.status === "waiting_signal" ||
          (run?.status === "waiting_input" && run.wakeAt !== null);
        if (run && run.claim !== generation) {
          // Not a cancel: the turn of a durable step belongs to the runner that has the run now.
          abort.abort("stop");
        } else if (run && !working) {
          abort.abort();
        }
        if (run && !longHoldReported && Date.now() - heldSince >= LONG_HOLD_MS) {
          longHoldReported = true;
          const step = stepOf(run.definition, run.cursor);
          console.warn(
            `[run ${runId}] has held a slot for ${Math.round((Date.now() - heldSince) / 60_000)} min: tenant ${tenant}, step ${run.cursor} (${step?.type}).`,
          );
        }
      })
      .catch((err) => console.warn(`[run ${runId}] cancel check:`, err));
  }, HEARTBEAT_MS);
  beat.unref();
  await driving
    .run({ runId, generation }, () =>
      withTenant(tenant, () => drive(runId, abort.signal)).catch(async (err) => {
        if (err instanceof LostClaim) {
          console.warn(`[run ${runId}] another runner holds it now; this one stops.`);
          return;
        }
        console.error(`[run ${runId}]`, err);
        await withTenant(tenant, async () => {
          const run = await loadRun(runId);
          const lang = run ? textLang(wizardLang(run.definition)) : "en";
          // A run that ended meanwhile, a cancel among them, stays as it ended.
          await updateRun(
            runId,
            { status: "failed", error: saidText(friendly(err), lang) },
            "open",
          );
        }).catch((e) => console.error(`[run ${runId}] marking it failed:`, e));
      }),
    )
    .finally(async () => {
      clearInterval(beat);
      // What fails here leaves the rest of the cleanup to run.
      await withTenant(tenant, () => releaseResources(runId)).catch((err) =>
        console.error(`[run ${runId}] releasing its resources:`, err),
      );
      // A run the shutdown stopped goes back in line for the next runner; the rest is done for now.
      if (!stopping) {
        await restRun(runId).catch((err) => console.error(`[run ${runId}] rest:`, err));
      }
      // Only now: a take that came earlier would be rested here, its resources released.
      active.delete(runId);
      void withTenant(tenant, () => signalChanged(runId)).catch((err) =>
        console.error(`[run ${runId}] signal:`, err),
      );
      // A slot came free: the next run of the line need not wait for the poll.
      void lookAtLine();
    });
}

let stopping = false;
let looking = false;
let markedLine = 0;
let pinged = 0;
/** Since when this runner waits for the line's query; null while it doesn't. */
let asking: number | null = null;

/**
 * The runner still looks at the line: `runner.line_at` at most every 10 s, the outside
 * monitor's heartbeat at most once a minute. Driving a run takes as long as its steps, so only
 * a query of the line that never returns stops both (health.ts).
 */
function lineMoved() {
  const now = Date.now();
  if (asking !== null && now - asking > 30_000) {
    return;
  }
  if (now - markedLine >= 10_000) {
    markedLine = now;
    void markLine().catch((err) => console.warn("[line] marking:", (err as Error).message));
  }
  if (env.runner.heartbeatUrl && now - pinged >= 60_000) {
    pinged = now;
    void fetch(env.runner.heartbeatUrl, { signal: AbortSignal.timeout(5000) })
      .then((res) => res.body?.cancel())
      .catch((err) => console.warn("[line] heartbeat:", (err as Error).message));
  }
}

/** Since when the line's query hangs, when it does: this runner takes no run then (health.ts). */
export const lineAskedSince = () => asking;

/** Takes what waits in line, run by run; each claim counts the tenant's limit by itself. */
async function lookAtLine() {
  if (looking || stopping) {
    return;
  }
  looking = true;
  try {
    asking = Date.now();
    const waiting = await waitingRuns();
    asking = null;
    for (const r of waiting) {
      if (stopping) {
        return;
      }
      await take(r.runId, r.tenantId).catch((err) => console.error(`[line ${r.runId}]`, err));
    }
  } catch (err) {
    asking = null;
    console.error("[line]", err);
  } finally {
    looking = false;
  }
}

/** A runner: looks at the line every POLL_MS, from now on. Runs a stopped process left behind are in it. */
export function startRunner() {
  const timer = setInterval(() => {
    lineMoved();
    void lookAtLine();
  }, POLL_MS);
  timer.unref();
  void lookAtLine();
  const clock = setInterval(() => void lookAtClock(), env.runner.clockMs);
  clock.unref();
  void lookAtClock();
}

/** The clock: what came due goes in line, and the line need not wait for its next look. */
async function lookAtClock() {
  if (stopping) {
    return;
  }
  try {
    if (await wakeDue()) {
      await lookAtLine();
    }
  } catch (err) {
    console.warn("[clock]", (err as Error).message);
  }
}

/** Stops the runs this process holds and hands them back to the line. */
export async function stopRunner() {
  stopping = true;
  for (const abort of active.values()) {
    // A stop, not a cancel: a durable turn stays where it is for the next runner.
    abort.abort("stop");
  }
  await disownRuns().catch(() => undefined);
}

/** What conditions read in this run: answers, outputs, and how many rows each stored list has. */
async function flowValues(run: RunRow, state: RunState): Promise<Record<string, unknown>> {
  return branchValues(state.values, state.outputs, await listCounts(run));
}

/**
 * What a page knows besides the person's input: what its fields' `when` read from before the
 * page (its own earlier answers left out, so a revisit decides on what is typed now) and the
 * choices its `optionsFrom` fields find in the run.
 */
export async function formContext(run: RunRow, step: FormStep): Promise<Required<FormContext>> {
  const needs = formNeeds(step.fields);
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
  ctx: Required<FormContext>,
): Pick<RunView, "known" | "options" | "cards" | "decidedFields"> {
  return { known: ctx.known, options: ctx.options, cards: ctx.cards, decidedFields: ctx.decided };
}

/** The wizard's lists with the person's rows, by list id; a shared list's as its holder may read them. */
async function storedLists(
  run: RunRow,
  holder?: RunHolder,
): Promise<Record<string, { def: ListDef; rows: ListRow[] }>> {
  const scope = scopeOf(run);
  const who = subjectsOf({ holder: holder ?? (await runHolder(run)), store: scope });
  const out: Record<string, { def: ListDef; rows: ListRow[] }> = {};
  for (const def of run.definition.lists ?? []) {
    out[def.id] = { def, rows: await listRows(scope, def, who) };
  }
  return out;
}

/**
 * What a step works with. A share job works with the same — the run's browser, store and
 * answers — under a step id, progress lines and questions of its own.
 */
export async function makeContext(
  run: RunRow,
  space: SpaceRow,
  state: RunState,
  signal: AbortSignal,
  own: Partial<Pick<StepContext, "stepId" | "emit" | "ask" | "share">> = {},
): Promise<StepContext> {
  const store = scopeOf(run);
  const resources = resourcesFor(run.id);
  resources.bind(store, run, own.share, space.id, run.definition.data ? sandboxDataHost() : null);
  const stepId = own.stepId ?? run.cursor ?? "";
  const holder = await runHolder(run);
  return {
    runId: run.id,
    tenantId: run.tenantId,
    test: run.mode === "test",
    stepId,
    holder,
    store,
    def: run.definition,
    lang: run.lang,
    files: run.files,
    state,
    scope: {
      def: run.definition,
      state,
      brand: spaceProfile(space),
      lists: await storedLists(run, holder),
    },
    space,
    dataSpace: await dataSpaceOf(run, space),
    spaceFiles: await runSpaceFiles(space.id),
    signal,
    resources,
    ask: own.ask ?? ((ask) => askOf(run, ask, stepId, signal)),
    emit:
      own.emit ?? ((type, message, asset) => emitEvent(run.id, run.cursor, type, message, asset)),
    call: { runId: run.id, stepId },
    ...(own.share ? { share: true } : {}),
    saveState: async () => {
      await updateRun(run.id, { state });
    },
    chargeUsd: (usd) => addLocalCost(run.id, stepId, usd),
    saveAsset: (input) =>
      saveAsset({
        ...input,
        runId: run.id,
        stepId: input.stepId ?? own.stepId ?? run.cursor,
      }),
  };
}

/**
 * A step's question to the person. An autopilot's test run asks nobody. A started run answers a
 * confirm itself when its start allows changes; otherwise nobody is there and the tool leaves
 * the change open. A sign-in it puts to the owner, who is told.
 */
async function askOf(
  run: RunRow,
  ask: AskInput,
  stepId: string,
  signal: AbortSignal,
): Promise<AskResult | null> {
  if (run.unattended) {
    return null;
  }
  if (run.startedBy && ask.kind === "confirm") {
    const start = await startOf(run);
    return start?.allowChanges ? { type: "done" } : null;
  }
  return askPerson(run.id, { ...ask, stepId }, signal);
}

/** A decided branch is taken only when its pick leads the runner-up by this much. */
const BRANCH_MARGIN = 0.1;

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
 * The decision over a step's open `ask` rules: one choice among their statements and "none", by
 * its index in `next`, null for none. Kept in the run; a pick that does not lead clearly (where
 * there are probabilities) is none.
 */
async function decideBranch(
  run: RunRow,
  step: Step,
  state: RunState,
  signal: AbortSignal,
): Promise<number | null> {
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
  return rule;
}

/**
 * The decided fields (`ask`, `group`) of a page a decision keeps, in one call as the run reaches
 * the page. A field whose condition on earlier data already fails is not asked about. With the
 * fields always shown, at most MAX_SHOWN_FIELDS appear.
 */
async function decideFormFields(
  run: RunRow,
  page: FormStep,
  state: RunState,
  signal: AbortSignal,
): Promise<string[]> {
  const values = await flowValues(run, state);
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

export async function durableRunsOn() {
  return feature("durableRuns", await remoteFeatures().catch(() => null));
}

/**
 * Does a step's work under its deadline. Past it the work hears `deadline` on the signal it was
 * given, and the answer is a StepDeadline even if the work never ends: a hung step gives its slot
 * back. A stop of the run itself passes through to the work.
 */
async function withDeadline<T>(
  stepType: string,
  signal: AbortSignal,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (!(await durableRunsOn())) {
    return work(signal);
  }
  const minutes = env.runner.stepDeadlines[stepType] ?? env.runner.stepDeadlines.default;
  const limit = new AbortController();
  const stop = () => limit.abort(signal.reason);
  if (signal.aborted) {
    stop();
  }
  signal.addEventListener("abort", stop, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const past = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // In this order: what the abort makes the work throw comes second.
      reject(new StepDeadline());
      limit.abort("deadline");
    }, minutes * 60_000);
    timer.unref();
  });
  try {
    return await Promise.race([work(limit.signal), past]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
  }
}

/** A wait for a signal with no deadline still ends some day: this long, and it is gone with the run. */
const NO_DEADLINE_KEPT_MS = 365 * 86_400_000;

/** A run that waits is kept past its start: its wait, and the same time to come back for it. */
function keptUntil(run: Pick<RunRow, "expiresAt">, wakeAt: Date | null): Date | null {
  if (!run.expiresAt) {
    return null;
  }
  const end = wakeAt ? wakeAt.getTime() : Date.now() + NO_DEADLINE_KEPT_MS;
  const kept = end + env.limits.resultTtlDays * 86_400_000;
  return new Date(Math.max(run.expiresAt.getTime(), kept));
}

/** The time a `wait` line of the log said. */
function saidUntil(said: { note: RunNote | null } | null): Date | null {
  const until = said?.note?.params?.until;
  return isNoteTime(until) ? new Date(until.at) : null;
}

/**
 * The run stands at a `wait`: it leaves every process and stays as a row. False: the wait is behind
 * it already (a time gone by, a signal that came first, or it could not be entered and the step's
 * `onFail` took the run on), and the run goes on at once.
 */
async function enterWait(run: RunRow, step: WaitStep, interrupted: boolean): Promise<boolean> {
  // Back after a crash on the way in: the visit stays one, and the time it said stays too.
  const open = interrupted && (await visitLeftOpen(run.id, step.id));
  if (!open) {
    await emitEvent(run.id, step.id, "step_started", step.title);
  }
  const said = open ? await saidInVisit(run.id, step.id, "wait") : null;
  let result = await flow(run, { kind: "resume" });
  let came: RunNote | undefined;
  if (result.command.kind === "waitSignal") {
    // The wait is written first, then the run looks: a signal that came before is found here, and
    // one that comes after finds the wait and wakes the run.
    const spaceId = await spaceIdOf(run);
    await registerWait(run, spaceId, step, result.command.key);
    const signal = await findSignal(run, spaceId, step, result.command.key);
    if (signal) {
      await dropWait(run.id);
      result = await flow(
        run,
        { kind: "signal", stepId: step.id, id: signal.id, data: await withMailText(signal) },
        result.run,
      );
      came = note("signalCame");
    }
  }
  const until = saidUntil(said);
  if (until && result.run.cursor === step.id && result.run.wakeAt !== null) {
    // The time said before the crash, not a new one from now; one gone by is over.
    result =
      until.getTime() > Date.now() || step.signal
        ? { ...result, run: { ...result.run, wakeAt: until.getTime() } }
        : await flow(run, { kind: "woke" }, { ...result.run, wakeAt: until.getTime() });
  }
  const goesOn = await apply(run, run.state, result, {
    seen: { status: "running" },
    stand: true,
    own: step.id,
    said: Boolean(said),
  });
  if (passed(run.state, result.run.state, step.id)) {
    if (came) {
      await emitEvent(run.id, step.id, "info", came);
    }
    await emitEvent(run.id, step.id, "step_done", step.title);
  }
  return !goesOn;
}

/** The key a wait for a signal listens on, from the run's answers; empty fails the run. */
function waitKeyOf(run: RunRow, step: WaitStep): string {
  const key = waitKeyText(run, step);
  if (!key) {
    throw new NotedError(note("signalKeyEmpty", { key: step.signal?.key ?? "" }));
  }
  return key;
}

function waitKeyText(run: RunRow, step: WaitStep): string {
  const scope = { def: run.definition, state: run.state, brand: {} };
  return renderTemplate(step.signal?.key ?? "", scope).trim();
}

/** Holds the credits a run needs to go on; what it says when they are refused, else null. */
async function holdAgain(run: RunRow): Promise<RunNote | null> {
  // Without the Manage-App nothing is held: the estimate is worked out only where a hold is made.
  const held = await reserveForRun(
    run.id,
    async () =>
      (
        await estimateRun(
          run.wizardId,
          run.version,
          run.definition,
          await stepsWithoutModel(run.definition),
        )
      ).reserve,
    guestRun(run),
  );
  return held === true
    ? null
    : note(held === "guest_budget" ? "guestBudget" : "wizardRunOutCredits");
}

/**
 * A woken run holds credits again before it goes on to a step: it gave its hold back while it
 * waited, and a hold lapses anyway. Null: held, or nothing left to pay for. A note: refused.
 * Undefined: the Manage-App out of reach, which is no refusal: the time stays due, the clock tries
 * again.
 */
async function holdOnWake(run: RunRow, result: FlowResult): Promise<RunNote | null | undefined> {
  const next = stepOf(run.definition, result.run.cursor);
  if (!next || next.type === "result") {
    return null;
  }
  try {
    return await holdAgain(run);
  } catch (err) {
    console.warn(`[run ${run.id}] holding credits on wake:`, (err as Error).message);
    await setWake(run.id, run.wakeAt ?? new Date());
    return undefined;
  }
}

/**
 * A run that waits is woken: true when it goes on, false when it does not. The row decides, not
 * the wake: one that comes early or twice, with no signal for it, puts the time back and changes
 * nothing.
 */
async function wakeFromWait(run: RunRow): Promise<boolean> {
  const step = stepOf(run.definition, run.cursor);
  const wait = step?.type === "wait" ? step : undefined;
  const signal = wait?.signal
    ? await findSignal(run, await spaceIdOf(run), wait, waitKeyOf(run, wait))
    : null;
  const result =
    wait && signal
      ? await flow(run, {
          kind: "signal",
          stepId: wait.id,
          id: signal.id,
          data: await withMailText(signal),
        })
      : await flow(run, { kind: "woke" });
  if (result.command.kind === "stay") {
    await setWake(run.id, run.wakeAt);
    return false;
  }
  const refused = await holdOnWake(run, result);
  if (refused === undefined) {
    return false;
  }
  if (wait?.signal) {
    // Which of them ended it, the log says after the move.
    await dropWait(run.id);
    await setWake(run.id, null);
    // A person's "Continue now" said so itself, and a wake that came back after a crash has said it.
  } else if (wait && !(await saidInVisit(run.id, wait.id, "woken"))) {
    await emitEvent(run.id, wait.id, "woken", note("runWaitOver"));
  }
  if (refused) {
    // The wait is over either way: the top-up goes on from the next step and does not wait again.
    await waitForPerson(run, result.run, { class: "credits" }, { status: run.status });
    return false;
  }
  await apply(run, run.state, result, {
    seen: { status: run.status },
    own: wait?.id,
    after: async () => {
      if (!wait) {
        return;
      }
      if (wait.signal) {
        await emitEvent(run.id, wait.id, "info", note(signal ? "signalCame" : "signalTimedOut"));
      }
      await emitEvent(run.id, wait.id, "step_done", wait.title);
    },
  });
  return true;
}

// --- a person's step with a deadline -------------------------------------------
// It waits as a `wait` does: a row with `wake_at`, no process, no slot, no credits. An answer and the
// deadline each write on the `rev` they read, so one wins and the other finds the run moved on.

const isPersonStep = (step: Step | undefined): step is FormStep | ReviewStep =>
  step?.type === "form" || step?.type === "review";

/**
 * A step a run reaches with no runner: a page or review nothing has to decide or fill first. The
 * step's keys only, so with `durableRuns` off it says the same. `state` is the state after
 * `advance`: an `ask` rule set `deciding` there and left the cursor on the answered step.
 */
function needsNoRunner(
  step: Step | undefined,
  startedBy: StartedBy | null,
  state: RunState,
): step is FormStep | ReviewStep {
  return (
    isPersonStep(step) &&
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

/** How many pages `ahead` holds at most. */
const AHEAD_MAX = 20;

/**
 * The plain pages a run can reach from the page it waits on, with no server: the current page and
 * every page its rules lead to that the shortcut covers (`needsNoRunner`) and that needs nothing
 * only the server has. A page's `next` is null where the server decides: an `ask`, a `max`, a rule
 * back (its loops are counted), a name the browser has no value for. In the definition `def` it
 * is shown in (a translation's words).
 */
async function aheadOf(
  run: RunRow,
  def: WizardDefinition,
  from: FormStep,
): Promise<Record<string, AheadForm & { progress: RunView["progress"] }>> {
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
  const plain = async (step: Step | undefined): Promise<boolean> =>
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
    Object.keys(await closedChoices(def, step, run.state.values)).length === 0;
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
      if (target?.type === "form" && !out[target.id] && (await plain(target))) {
        queue.push(target);
      }
    }
  }
  return out;
}

/** Whether the step may wait for long: it gives its hold back, and holds again as it goes on. */
async function waitsLong(step: FormStep | ReviewStep): Promise<boolean> {
  return Boolean(step.timeout || step.remind) && (await durableRunsOn());
}

/** A person's step's deadline as the flow set it, and how long the run is kept for it. */
async function deadlineOf(
  run: Pick<RunRow, "expiresAt">,
  step: Step | undefined,
  wakeAt: number | null,
): Promise<{ wakeAt: Date | null; expiresAt?: Date | null }> {
  const at = wakeAt === null ? null : new Date(wakeAt);
  if (!isPersonStep(step) || !(await waitsLong(step))) {
    return { wakeAt: at };
  }
  const last = at ?? new Date(Date.now() + waitDurationMs(step.remind as string));
  return { wakeAt: at, expiresAt: keptUntil(run, last) };
}

/** The wait is on the row: its hold goes back, and the log says until when. */
async function waitsForAnswer(runId: string, step: Step | undefined, wakeAt: Date | null) {
  if (!isPersonStep(step) || !(await waitsLong(step))) {
    return;
  }
  await releaseRun(runId);
  if (wakeAt) {
    await emitEvent(
      runId,
      step.id,
      "wait",
      note("runWaitsAnswerUntil", { until: { at: wakeAt.toISOString() } }),
    );
  }
}

/**
 * A person's answer takes the run on, if the deadline has not. A step that gave its hold back holds
 * again before the run's next step that costs anything (`holdLater`, in `drive()`). The control
 * copy of the deadline stays too: the extra wake finds the run moved on, and clearing it here could
 * wipe the next wait's. A next step that needs no runner is stood at here, in the same update
 * (docs/plans/fast-creation.md, Part 4). `told`: what the answer says in the log, right after the
 * update. True: the run is `running` and a runner has work.
 */
async function answerGoesOn(
  run: RunRow,
  step: FormStep | ReviewStep,
  result: FlowResult,
  patch: Partial<typeof schema.run.$inferInsert> = {},
  by?: Actor,
  told?: () => Promise<void>,
): Promise<boolean> {
  const { state } = result.run;
  const next = stepOf(run.definition, result.run.cursor);
  if (next && next.type !== "result" && (await waitsLong(step))) {
    // The step gave its hold back while it waited. The run holds again right before its next step
    // that costs anything (`drive()`), so the answer and the pages after it wait for no estimate
    // and no call to the Manage-App, and no step that costs runs without a hold.
    state.holdLater = true;
  }
  const stand = result.command.kind === "ask" && needsNoRunner(next, run.startedBy, state);
  const { answered } = state;
  if (stand) {
    // As `drive()` stands at a page, with the answer's time logged; `by` is not told of it.
    delete state.answered;
  }
  try {
    const goesOn = await apply(run, run.state, result, {
      seen: { rev: run.rev },
      by,
      patch,
      stand,
      after: told,
    });
    if (stand) {
      if (answered) {
        console.info(
          `[timing] page run=${run.id} ms=${Math.max(0, Date.now() - answered.at)} direct=true role=${env.role} durable=${(await durableRunsOn()) ? "on" : "off"} runner=no`,
        );
      }
      // As from `drive()`: without durable runs a phone hears it (with them, the notices do).
      void pushRun(run.id, "waiting");
    }
    return goesOn;
  } catch (err) {
    // Lost to the deadline: say that, not that the wizard is busy.
    if (err instanceof RunConflict) {
      await requireWaiting(run.id, step.id);
    }
    throw err;
  }
}

/**
 * The clock woke a run at a person's step. The row decides: a wake that comes early puts the time
 * back and changes nothing, one that finds the time up moves the run past the step, as the author
 * wrote. Nobody's answer is invented: its fields stay empty, and an approval is not given.
 * True: look at the run again, it went on or moved. False: nothing for this drive to do.
 */
async function wakeFromPersonStep(run: RunRow): Promise<boolean> {
  const step = stepOf(run.definition, run.cursor);
  if (!isPersonStep(step) || !run.wakeAt) {
    return false;
  }
  const result = await flow(run, { kind: "woke" });
  if (result.command.kind === "stay") {
    await setWake(run.id, run.wakeAt);
    return false;
  }
  const refused = await holdOnWake(run, result);
  if (refused === undefined) {
    return false;
  }
  const timedOut = async () => {
    await emitEvent(run.id, step.id, "woken", note("stepTimedOut"));
    await emitEvent(run.id, step.id, "step_done", step.title);
  };
  try {
    if (refused) {
      await waitForPerson(run, result.run, { class: "credits" }, { rev: run.rev });
      await timedOut();
    } else {
      await apply(run, run.state, result, { seen: { rev: run.rev }, after: timedOut });
    }
  } catch (err) {
    // Not another runner: the run moved under this write. An answer, or a translation landing, in
    // which case the time is still up. The next look decides, so no wake is lost.
    if (!(err instanceof LostClaim)) {
      throw err;
    }
    const holder = driving.getStore();
    if ((await loadRun(run.id))?.claim !== holder?.generation) {
      throw err;
    }
    await startDriving(run.id);
    return true;
  }
  return !refused;
}

// --- the flow ------------------------------------------------------------------
// Where a run goes is `transition()`'s answer (packages/shared/src/transition.ts), for every move: a
// step done or failed, a decision, an answer, back, a wake, a signal, a retry. This file is its
// host: it loads and writes the row, runs the steps, holds credits, tells people and keeps the log.

/** The row as the flow reads it; `state`: a step's working copy instead of the row's. */
function flowRun(
  run: Pick<RunRow, "cursor" | "status" | "state" | "wakeAt">,
  state: RunState = run.state,
): FlowRun {
  return { cursor: run.cursor, status: run.status, state, wakeAt: run.wakeAt?.getTime() ?? null };
}

/** Rows per stored list, for rules that read `lists.<list>.count`. */
async function listCounts(run: RunRow): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  if (run.definition.lists?.length) {
    for (const [id, list] of Object.entries(await storedLists(run))) {
      counts[id] = list.rows.length;
    }
  }
  return counts;
}

/** What the flow needs from this runtime, read before the call. */
async function flowHost(
  def: WizardDefinition,
  counts: Record<string, number> = {},
): Promise<FlowHost> {
  return {
    now: Date.now(),
    render: (text, state) => renderTemplate(text, { def, state, brand: {} }),
    listCounts: counts,
    durable: await durableRunsOn(),
    lookAgainMs: lookAgainMs(),
  };
}

/** One move of the run. One it can't take as it stands is a conflict for whoever asked. */
async function flow(run: RunRow, event: FlowEvent, from = flowRun(run)): Promise<FlowResult> {
  const host = await flowHost(run.definition, await listCounts(run));
  try {
    return transition(run.definition, from, event, host);
  } catch (err) {
    if (!(err instanceof FlowRefused)) {
      throw err;
    }
    switch (err.code) {
      case "notThisStep":
        throw new RunConflict({ code: "pageOutdated" });
      case "unknownTarget":
        throw new RunConflict("Unknown target");
      default:
        throw new RunConflict({ code: err.code });
    }
  }
}

/** The flow stands the run at a wait, a person's step or the result. */
function arrives({ run }: FlowResult): boolean {
  return (
    run.status === "waiting_input" ||
    run.status === "waiting_signal" ||
    (run.status === "sleeping" && !run.state.pause) ||
    (run.status === "done" && run.cursor !== null)
  );
}

/** Whether the move wrote the wait `stepId`'s output: it is behind the run. */
function passed(before: RunState, after: RunState, stepId: string): boolean {
  const output = after.outputs[stepId];
  return output !== undefined && output.at !== before.outputs[stepId]?.at;
}

interface Apply {
  /** The row as read: a person's write needs its `rev`, a wait's its status. */
  seen?: { rev: number } | { status: RunStatus };
  by?: Actor;
  patch?: Partial<typeof schema.run.$inferInsert>;
  /**
   * Stand the run at the wait, person's step or result the move arrives at. Otherwise the row says
   * `running` there and the drive loop stands it (`resume`), with what that step says and does
   * first: the log's lines, a start's answers, a page's picked fields.
   */
  stand?: boolean;
  /** The wait the move came from: its lines are the caller's. */
  own?: string;
  /** The log has said this wait's time already (a crash on the way in). */
  said?: boolean;
  /** Why the step failed, for the words of a run that fails. */
  err?: unknown;
  /** Right after the row: what the step the move came from says in the log. */
  after?: () => Promise<void>;
}

/** Writes a move of the run, with what goes with it. True: the run is at work (`running`). */
async function apply(
  run: RunRow,
  before: RunState,
  result: FlowResult,
  o: Apply = {},
): Promise<boolean> {
  const def = run.definition;
  const stands = Boolean(o.stand) || !arrives(result);
  const to: FlowRun = stands ? result.run : { ...result.run, status: "running", wakeAt: null };
  const step = stepOf(def, to.cursor);
  // What the content rules stopped is kept on the run, whichever way it goes: Manage hears of it
  // with the failed turn.
  if (o.err instanceof ContentBlockedError) {
    to.state.blocked = o.err.kind;
  }
  if (result.error) {
    await emitEvent(run.id, result.error.stepId, "error", result.error.said);
    if (result.command.kind !== "fail") {
      await emitEvent(
        run.id,
        result.error.stepId,
        "info",
        note("stepFailedGoesOn", { step: step?.title ?? "" }),
      );
    }
  }
  let error: string | null = null;
  if (to.status === "failed") {
    const said = result.error?.said ?? (await failSaid(o.err));
    if (!result.error) {
      await emitEvent(run.id, to.cursor, "error", said);
    }
    error = saidText(said, textLang(wizardLang(def)));
  }
  const tell = stands && result.command.kind === "sleep" ? result.command.tell : undefined;
  if (tell) {
    await tellPerson(run, to.cursor ?? "", tell);
  }
  const wakeAt = to.wakeAt === null ? null : new Date(to.wakeAt);
  // The control copy first: a crash after it gives a wake that finds the run as it was.
  if (wakeAt) {
    await setWake(run.id, wakeAt);
  }
  const waiting = to.status === "sleeping" || to.status === "waiting_signal";
  // A run that reached its result keeps the data the result names; one that goes on has none yet.
  if (to.status === "done" && step?.type === "result" && step.data) {
    to.state.data = await resultDataOf(step.data, run, to.state);
  } else if (to.status !== "done") {
    delete to.state.data;
  }
  await updateRun(
    run.id,
    {
      state: to.state,
      cursor: to.cursor,
      status: to.status,
      wakeAt,
      error,
      ...(waiting ? { expiresAt: keptUntil(run, wakeAt) } : {}),
      ...(to.status === "waiting_input" ? await deadlineOf(run, step, to.wakeAt) : {}),
      ...(def.label ? { label: await labelOf(def, to.state) } : {}),
      // Woken from a person's step, the drive now works on it.
      ...(to.status === "running" && driving.getStore()?.runId === run.id ? { driving: true } : {}),
      ...o.patch,
    },
    o.seen,
    o.by,
  );
  await o.after?.();
  // A wait passed on the way (a date gone by) is one line in, one line out.
  for (const wait of def.steps) {
    if (wait.type === "wait" && wait.id !== o.own && passed(before, to.state, wait.id)) {
      await emitEvent(run.id, wait.id, "step_started", wait.title);
      await emitEvent(run.id, wait.id, "step_done", wait.title);
    }
  }
  if (stands && to.status === "waiting_input") {
    await waitsForAnswer(run.id, step, wakeAt);
  }
  if (stands && step?.type === "wait" && !to.state.pause && !o.said) {
    const until = wakeAt ? { until: { at: wakeAt.toISOString() } } : undefined;
    if (to.status === "sleeping" && until) {
      await emitEvent(run.id, step.id, "wait", note("runWaitsUntil", until));
    } else if (to.status === "waiting_signal") {
      await emitEvent(
        run.id,
        step.id,
        "wait",
        until ? note("runWaitsSignalUntil", until) : note("runWaitsSignal"),
      );
    }
  }
  return to.status === "running";
}

// --- when a step fails ---------------------------------------------------------
// Nothing waits in memory: a retry and a wait for a person are one more reason to sleep, so they
// hold no process, no slot and no credits, and they survive a restart. How long and how often is
// the flow's (`FLOW_LIMITS` in packages/shared/src/transition.ts).

/**
 * How often a run that waits for a person looks whether they acted. A top-up on the Manage-App is
 * seen by the reservation alone, so that look costs nothing. A runtime that runs alone has only
 * the provider itself to ask, with a call of the step's, so it asks less often.
 */
const lookAgainMs = () => (managed ? 5 : 30) * 60_000;

/** What a failed step says: its own note, a tier's refusal, or the error in plain words. */
async function failSaid(err: unknown): Promise<Said> {
  return noteOf(err) ?? (await tierRefusalSaid(err)) ?? friendly(err);
}

/**
 * Someone has to act before the run goes on, and this is the one place that tells them: the run's
 * log, which the runner, the studio's panel and a channel's thread show, and a notice for whoever
 * isn't looking. A crash before the run sleeps tells again, and that notice replaces this one.
 */
async function tellPerson(run: RunRow, stepId: string, pause: RunPause) {
  const said = pause.kind === "sign_in" ? await signInSaid(run, pause) : note("stepWaitsCredits");
  await emitEvent(run.id, stepId, "error", said);
  try {
    const notice = await noticeFor(run, "needs_you", {
      waitKey: `pause:${pause.kind}`,
      detail: saidText(said, textLang(wizardLang(run.definition))),
    });
    if (notice) {
      await db.batch(noticeWrites(notice, eq(schema.run.id, run.id)) as never);
    }
  } catch (err) {
    // A notice never breaks a run.
    console.error(`[notices] run ${run.id}:`, err);
  }
}

/**
 * Out of credits or signed out before the step `at` stands at: the run waits for a person, and
 * fails only if nobody ever comes.
 */
async function waitForPerson(
  run: RunRow,
  at: FlowRun,
  failure: Extract<FlowFailure, { class: "credits" | "sign_in" }>,
  seen: { rev: number } | { status: RunStatus },
) {
  const stepId = at.cursor ?? run.cursor ?? "";
  const result = await flow(
    run,
    { kind: "stepFailed", stepId, failure },
    { ...at, cursor: stepId, status: "running", wakeAt: null },
  );
  await apply(run, run.state, result, {
    seen,
    err:
      failure.class === "credits"
        ? new NoCreditsError()
        : new NotedError(await signInSaid(run, failure)),
  });
}

/** The connection of the space behind the wizard's connection a sign-in is for, if it is one. */
async function spaceRowOf(run: RunRow, connectionId: string | undefined) {
  const named = run.definition.connections?.find((c) => c.id === connectionId)?.spaceConnection;
  return named ? spaceConnectionOf(await spaceIdOf(run), named) : null;
}

/** What a run that waits for a sign-in says: one that signs in as the space is an admin's to fix. */
async function signInSaid(
  run: RunRow,
  pause: { service: string; connection?: string },
): Promise<RunNote> {
  const row = await spaceRowOf(run, pause.connection);
  return note(row?.signIn === "space" ? "stepWaitsAdminSignIn" : "stepWaitsSignIn", {
    service: pause.service,
  });
}

/**
 * The person signed in: a run that waits for a sign-in to one of the wizard's connections looks
 * again now, not at its next look. Still not signed in, the step waits again and says nothing new.
 */
export async function signedIn(runId: string) {
  const run = await loadRun(runId);
  const pause = run?.status === "sleeping" ? run.state.pause : undefined;
  if (!(run && pause?.kind === "sign_in" && pause.connection)) {
    return;
  }
  const now = new Date();
  try {
    await updateRun(run.id, { wakeAt: now }, { rev: run.rev });
  } catch (err) {
    // It moved on meanwhile: it no longer waits for this.
    if (err instanceof RunConflict) {
      return;
    }
    throw err;
  }
  await setWake(run.id, now);
  await wakeDue(now);
  kick(run.id);
}

/**
 * The error as the flow sorts it. A retry starts the step from the top, so one that may have done
 * something out there is not started again by itself, or the mail goes out twice: a person can still
 * choose "try again". A refused sign-in did nothing, so it waits for one whatever the step did.
 */
function flowFailure(err: unknown, failure: Failure, acted: boolean): FlowFailure {
  switch (failure.class) {
    case "retry":
      return { class: "retry", retryAfterMs: failure.retryAfterMs };
    case "credits":
      return { class: "credits" };
    case "sign_in":
      if (err instanceof SignInNeeded) {
        return {
          class: "sign_in",
          service: err.service,
          ...(err.connection ? { connection: err.connection } : {}),
        };
      }
      return acted ? { class: "final" } : { class: "sign_in", service: "" };
    default:
      return { class: "final" };
  }
}

/**
 * A step failed; true when the run goes on elsewhere (`onFail`), false when this drive is over for
 * now: it sleeps for a retry, waits for a person, or failed.
 */
async function stepFailed(run: RunRow, stepId: string, err: unknown, acted = false) {
  // From the row, not from the step's copy: what the step did to its copy is not to stay, and what
  // was written while it worked (run_effect's visit) is.
  const latest = (await loadRun(run.id)) ?? run;
  // A turn starts over after a failure: its calls get new ids, so `run_effect` can't match them. The
  // row knows what an earlier process of this turn did.
  const didAct = acted || Boolean(turnOf(latest.state, stepId)?.acted);
  const failure = classifyFailure(err, failureContext());
  const result = await flow(latest, {
    kind: "stepFailed",
    stepId,
    failure: flowFailure(err, failure, didAct),
    acted: didAct,
  });
  const { command } = result;
  if (command.kind === "sleep" && result.run.state.pause?.kind === "retry") {
    const minutes = Math.round(((result.run.wakeAt ?? Date.now()) - Date.now()) / 60_000);
    console.warn(
      `[run ${run.id} step ${stepId}] ${failure.why}, try ${result.run.state.retries?.count ?? 1} in ${minutes} min:`,
      (err as Error)?.message,
    );
    await emitEvent(run.id, stepId, "info", note("stepRetries", { minutes }));
  } else if (command.kind !== "sleep" && command.kind !== "fail") {
    // Past every try: the run goes where the step's `onFail` says.
    await emitEvent(run.id, stepId, "error", await failSaid(err));
    await emitEvent(
      run.id,
      stepId,
      "info",
      note("stepFailedGoesOn", {
        step: stepOf(run.definition, result.run.cursor)?.title ?? "",
      }),
    );
  }
  return apply(latest, latest.state, result, {
    ...(command.kind === "sleep" ? { seen: { status: "running" } } : {}),
    err,
  });
}

/**
 * A run that slept for a retry or for a person is woken. Like `wakeFromWait` the row decides, and
 * the run holds credits again before it spends. Refused: it waits for them, whatever it slept for.
 * A person who acted is noticed here; one who has not sends the step back to `stepFailed`.
 */
async function wakeFromPause(run: RunRow): Promise<boolean> {
  const result = await flow(run, { kind: "woke" });
  if (result.command.kind === "stay") {
    await setWake(run.id, run.wakeAt);
    return false;
  }
  const refused = await holdOnWake(run, result);
  if (refused === undefined) {
    return false;
  }
  if (refused) {
    await waitForPerson(
      run,
      { ...flowRun(run), state: result.run.state },
      { class: "credits" },
      { status: "sleeping" },
    );
    return false;
  }
  return apply(run, run.state, result, { seen: { status: "sleeping" } });
}

/**
 * A drive begins. True when it goes on after an interruption: another drive had the run at work and
 * never reached a rest, because of a crash or a deploy. The log says so, written before the mark, so
 * a crash in between says it again for the second interruption it is.
 */
async function startDriving(runId: string): Promise<boolean> {
  if (!(await durableRunsOn())) {
    return false;
  }
  const run = await db.query.run.findFirst({
    where: eq(schema.run.id, runId),
    columns: { status: true, cursor: true, driving: true },
  });
  // A wake of a person's step may well change nothing: the run only works once its time is up.
  if (run?.status === "waiting_input") {
    return false;
  }
  const interrupted = run?.status === "running" && run.driving;
  if (interrupted) {
    await emitEvent(runId, run.cursor, "resumed", note("runResumed"));
  }
  const holder = driving.getStore();
  await db
    .update(schema.run)
    .set({ driving: true })
    .where(
      and(
        eq(schema.run.id, runId),
        holder?.runId === runId ? eq(schema.run.claim, holder.generation) : undefined,
      ),
    );
  return interrupted;
}

async function drive(runId: string, signal: AbortSignal) {
  // The step starts afresh here: a question or a device call another process left has no one
  // waiting.
  await clearStaleAsk(runId);
  await clearDeviceCalls(runId);
  let interrupted = await startDriving(runId);
  while (!signal.aborted) {
    const run = await loadRun(runId);
    if (run?.status === "sleeping" || run?.status === "waiting_signal") {
      if (!(await (run.state.pause ? wakeFromPause(run) : wakeFromWait(run)))) {
        return;
      }
      continue;
    }
    if (run?.status === "waiting_input" && run.wakeAt) {
      if (!(await wakeFromPersonStep(run))) {
        return;
      }
      continue;
    }
    if (run?.status !== "running") {
      return;
    }
    const def = run.definition;
    // A step's `ask` branches wait on a decision before the run goes on.
    const deciding = run.state.deciding ? stepOf(def, run.state.deciding) : undefined;
    if (deciding) {
      const state = structuredClone(run.state);
      try {
        const rule = await withDeadline("decision", signal, (limit) =>
          decideBranch(run, deciding, state, limit),
        );
        if (signal.aborted) {
          return;
        }
        await syncRunCost(runId);
        await apply(
          run,
          run.state,
          await flow(run, { kind: "decided", stepId: deciding.id, rule }, flowRun(run, state)),
        );
      } catch (err) {
        if (signal.aborted) {
          return;
        }
        if (err instanceof LostClaim) {
          throw err;
        }
        console.error(`[run ${runId} deciding ${deciding.id}]`, err);
        if (!(await stepFailed(run, deciding.id, err))) {
          return;
        }
      }
      continue;
    }
    const step = stepOf(def, run.cursor);
    // A page whose fields a decision picks: picked once, as the run reaches it.
    if (step?.type === "form" && step.fields.some(isDecidedField) && !run.state.pages?.[step.id]) {
      const state = structuredClone(run.state);
      try {
        const shown = await withDeadline("decision", signal, (limit) =>
          decideFormFields(run, step, state, limit),
        );
        if (signal.aborted) {
          return;
        }
        state.pages = { ...state.pages, [step.id]: { shown } };
        await syncRunCost(runId);
        delete state.retries;
        await updateRun(runId, { state, error: null });
      } catch (err) {
        if (signal.aborted) {
          return;
        }
        if (err instanceof LostClaim) {
          throw err;
        }
        console.error(`[run ${runId} fields of ${step.id}]`, err);
        if (!(await stepFailed(run, step.id, err))) {
          return;
        }
      }
      continue;
    }
    if (!step || step.type === "result") {
      await apply(run, run.state, await flow(run, { kind: "resume" }), { stand: true });
      return;
    }
    if (step.type === "wait") {
      try {
        const back = interrupted;
        interrupted = false;
        if (await enterWait(run, step, back)) {
          return;
        }
      } catch (err) {
        if (err instanceof LostClaim) {
          throw err;
        }
        if (!(await stepFailed(run, step.id, err))) {
          return;
        }
      }
      continue;
    }
    // What the team is asked waits for the team, also on a started run.
    if (
      (step.type === "form" || step.type === "review") &&
      run.startedBy &&
      !(whoOf(step) === "team" && (await durableRunsOn()))
    ) {
      // Nobody is there: the start's answers fill the page, its setting passes the review.
      if (!(await passStep(run, step))) {
        return;
      }
      continue;
    }
    if (step.type === "form" || step.type === "review") {
      // Reached right from someone's answer: they know, they did it. After a step that worked it
      // is news again.
      const { lastBy, answered } = run.state;
      const stood = await flow(run, { kind: "resume" });
      delete stood.run.state.answered;
      await apply(run, run.state, stood, {
        stand: true,
        by: lastBy?.next === step.id ? lastBy : undefined,
      });
      if (answered) {
        // The two times can come from two machines: small numbers on the cloud's split roles are rough.
        console.info(
          `[timing] page run=${runId} ms=${Math.max(0, Date.now() - answered.at)} direct=${answered.next === step.id} role=${env.role} durable=${(await durableRunsOn()) ? "on" : "off"} runner=yes`,
        );
      }
      // A step that ran is over and the next one is the person's: a phone in a pocket hears it.
      void pushRun(runId, "waiting");
      return;
    }
    // An answer moved the run on without holding again (`answerGoesOn`): it holds before it spends.
    if (run.state.holdLater) {
      const refused = await holdAgain(run).catch((err) => {
        // The Manage-App out of reach stops no run: `canSpend` still guards the step.
        console.warn(`[run ${runId}] holding credits before ${step.id}:`, (err as Error).message);
        return null;
      });
      const { holdLater: _, ...state } = run.state;
      if (refused) {
        await waitForPerson(run, flowRun(run, state), { class: "credits" }, { status: "running" });
        return;
      }
      await updateRun(runId, { state });
      continue;
    }
    if (!(await canSpend())) {
      // With durable runs off the flow fails the run at once.
      await waitForPerson(run, flowRun(run), { class: "credits" }, { status: "running" });
      return;
    }
    // Back in a step a crash broke off: it starts over, and stays one visit in the log.
    if (!(interrupted && (await visitLeftOpen(runId, step.id)))) {
      await emitEvent(runId, step.id, "step_started", step.working ?? step.title);
    }
    interrupted = false;
    const space = await loadSpace(run);
    const state = structuredClone(run.state);
    resourcesFor(runId).acted = false;
    try {
      let changed = await enterVisit(step, state);
      // A durable turn's id is on the row before it starts, so whoever goes on finds it.
      if (
        step.type === "agent" &&
        step.durable &&
        !step.foreach &&
        state.turn?.stepId !== step.id &&
        (await effectsOn())
      ) {
        state.turn = newTurn(runId, step.id);
        changed = true;
      }
      if (changed) {
        await updateRun(runId, { state });
      }
      const output = await withDeadline(step.type, signal, async (limit) => {
        const ctx = await makeContext(run, space, state, limit);
        // A guest's answers are checked once before any model works on them, and what a step
        // wrote for a guest before it is kept (docs/plans/guest-content-guards.md).
        const guest = guestRun(run) && (await guestChecksOn());
        if (guest) {
          const answers = [answersAsText(ctx.scope), ...Object.values(state.notes)].join("\n");
          const hash = createHash("sha256").update(answers).digest("base64url").slice(0, 24);
          if (state.inputChecked !== hash) {
            await checkGuestInput({ text: answers, call: ctx.call, signal: limit });
            state.inputChecked = hash;
          }
        }
        const made = await runAutomaticStep(step, ctx);
        if (guest && !limit.aborted) {
          await checkGuestText({
            text: made.text || (made.json ? JSON.stringify(made.json) : ""),
            call: ctx.call,
            signal: limit,
          });
        }
        return made;
      });
      if (signal.aborted) {
        return;
      }
      await syncRunCost(runId);
      const done = await flow(
        run,
        { kind: "stepDone", stepId: step.id, output },
        flowRun(run, state),
      );
      await apply(run, run.state, done, {
        after: async () => {
          const masked = takeMasked(runId, step.id);
          if (masked) {
            await emitEvent(runId, step.id, "info", maskedNote(masked));
          }
          await emitEvent(runId, step.id, "step_done", step.title);
        },
      });
    } catch (err) {
      if (signal.aborted) {
        return;
      }
      if (err instanceof LostClaim) {
        throw err;
      }
      if (err instanceof TurnAsks) {
        // The turn stopped for a person: its conversation is stored and no runner holds anything.
        await syncRunCost(runId);
        await updateRun(runId, { state, status: "waiting_input" });
        await emitEvent(runId, step.id, "info", {
          code: "turnAsked",
          params: { question: err.question.slice(0, 200) },
        });
        void pushRun(runId, "asks");
        return;
      }
      console.error(`[run ${runId} step ${step.id}]`, err);
      await noteFreeTierRefusal(err);
      if (!(await stepFailed(run, step.id, err, liveResources(runId)?.acted))) {
        return;
      }
    }
  }
}

/**
 * A started run at a page or a review: the page is answered from the start's `fill` when every
 * required field has a value, a review passes when the start says so. True: it goes on. False: the
 * owner has to come, and the run waits for them.
 */
async function passStep(run: RunRow, step: FormStep | ReviewStep): Promise<boolean> {
  const stood = await flow(run, { kind: "resume" });
  let event: FlowEvent | null = null;
  if (step.type === "review") {
    const start = await startOf(run);
    // An approval is a person's: no setting gives it.
    if (start?.passReviews && !step.approve) {
      event = { kind: "reviewed", stepId: step.id, approved: true };
    }
  } else {
    const shown = run.state.pages?.[step.id]?.shown;
    const fill = run.state.fill ?? {};
    const input = Object.fromEntries(
      step.fields
        .filter((f) => (!shown || shown.includes(f.id)) && f.id in fill)
        .map((f) => [f.id, fill[f.id]]),
    );
    const { values, errors } = readFormInput(step, input, await formContext(run, step));
    if (!errors.length) {
      event = { kind: "answered", stepId: step.id, values };
    }
  }
  if (!event) {
    await apply(run, run.state, stood, { stand: true });
    return false;
  }
  return apply(run, run.state, await flow(run, event, stood.run));
}

// --- commands ----------------------------------------------------------------

/**
 * A person's step is behind the run: its timeline says so, as for a step that ran by itself, and
 * says who, where someone in the organization answered it.
 */
async function tellAnswered(
  run: RunRow,
  stepId: string,
  by?: Actor,
  said: "stepAnsweredBy" | "stepApprovedBy" | "stepDeclinedBy" = "stepAnsweredBy",
) {
  if (!(await durableRunsOn())) {
    return;
  }
  const title = stepOf(run.definition, stepId)?.title ?? stepId;
  const name = by?.userId ? await nameOf(by.userId) : null;
  if (name) {
    await emitEvent(run.id, stepId, "info", note(said, { name, step: title }));
  }
  await emitEvent(run.id, stepId, "step_done", title);
}

/**
 * Keeps who gave an answer with the run: the wait it leads to right there tells them nothing, and
 * the next person who tries to answer the step hears who was first. Nothing without the switch.
 */
async function keepAnswerer(state: RunState, stepId: string, next: string | null, by?: Actor) {
  if (!(by && (await durableRunsOn()))) {
    return;
  }
  state.lastBy = { userId: by.userId ?? null, visitorId: by.visitorId ?? null, next };
  const name = by.userId ? await nameOf(by.userId) : null;
  if (by.userId && name) {
    state.answeredBy = { ...state.answeredBy, [stepId]: { userId: by.userId, name } };
  }
}

async function requireWaiting(runId: string, stepId: string) {
  const run = await loadRun(runId);
  if (!run) {
    throw new RunConflict("Run not found");
  }
  // The first answer counts: the next one hears whose it was.
  const first = run.state.answeredBy?.[stepId];
  if (first && (run.status !== "waiting_input" || run.cursor !== stepId)) {
    throw new RunConflict(note("answeredAlready", { name: first.name }));
  }
  const open = run.status === "waiting_input" || run.status === "done";
  if (!open || run.cursor !== stepId) {
    const output = run.state.outputs[stepId]?.json as { timedOut?: boolean } | undefined;
    if (output?.timedOut) {
      throw new RunConflict({ code: "answerTooLate" });
    }
  }
  if (!open) {
    throw new RunConflict({ code: "runBusy" });
  }
  if (run.cursor !== stepId) {
    throw new RunConflict({ code: "pageOutdated" });
  }
  return run;
}

/** The run's typed answers without this page's, as a patch; nothing when it has none. */
function unsentWithout(run: RunRow, stepId: string): { unsent?: RunRow["unsent"] } {
  if (!run.unsent?.[stepId]) {
    return {};
  }
  const { [stepId]: _, ...rest } = run.unsent;
  return { unsent: Object.keys(rest).length ? rest : null };
}

/**
 * What is typed on a page and not sent yet, kept apart from the run's state: neither `state` nor
 * `rev` changes, so typing never makes an answer or a drive fail, in any status. No step reads it.
 * One page's entry is written in place, so two pages saving at once keep both.
 */
export async function keepUnsent(run: RunRow, stepId: string, values: Record<string, unknown>) {
  const step = stepOf(run.definition, stepId);
  if (step?.type !== "form") {
    throw new RunConflict("Not a page");
  }
  await db
    .update(schema.run)
    .set({
      unsent: sql`json_set(coalesce(${schema.run.unsent}, '{}'), ${`$.${stepId}`}, json(${JSON.stringify(values)}))`,
    })
    .where(eq(schema.run.id, run.id));
}

/**
 * `by`: who answers, as the door established it; none for what the engine does itself. `seq`: the
 * page's number from a runner that sends one page at a time, and its tab; a retry of a number the
 * run already has from that tab is done, and says so (true), before anything is checked against
 * where the run stands.
 */
export async function submitPage(
  runId: string,
  stepId: string,
  input: Record<string, unknown>,
  by?: Actor,
  sent?: { seq: number; tab?: string },
): Promise<boolean> {
  const at = Date.now();
  if (sent) {
    const last = (await loadRun(runId))?.state.pagesSent;
    if (last && last.tab === sent.tab && sent.seq <= last.n) {
      return true;
    }
  }
  const run = await requireWaiting(runId, stepId);
  const step = stepOf(run.definition, stepId);
  if (step?.type !== "form") {
    throw new RunConflict("Not a page");
  }
  const { values, errors } = readFormInput(step, input, await formContext(run, step));
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
        await spaceIdOf(run),
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
  const result = await flow(run, { kind: "answered", stepId, values });
  const { state, cursor } = result.run;
  if (sent) {
    state.pagesSent = { n: sent.seq, step: stepId, ...(sent.tab ? { tab: sent.tab } : {}) };
  }
  state.answered = { at, next: cursor };
  await keepAnswerer(state, stepId, cursor, by);
  const goesOn = await answerGoesOn(
    run,
    step,
    result,
    // What was typed on the page is in the answer now: its entry goes in the same update.
    unsentWithout(run, stepId),
    by,
    () => tellAnswered(run, stepId, by),
  );
  if (goesOn) {
    kick(runId);
  }
  return false;
}

/** The person answers what a durable step asked: its turn goes on with that, on any runner. */
export async function answerTurn(runId: string, answer: string) {
  const run = await loadRun(runId);
  if (!run) {
    throw new RunConflict("Run not found");
  }
  const turn = run.state.turn;
  if (run.status !== "waiting_input" || !turn?.question || run.cursor !== turn.stepId) {
    throw new RunConflict({ code: "askClosed" });
  }
  const words = answer.trim().slice(0, 10_000);
  // A guest's words are held to the same rules as their answers on a page.
  if (guestRun(run) && (await guestChecksOn())) {
    await checkGuestText({ text: words });
  }
  const state = structuredClone(run.state);
  state.turn = { ...turn, answer: words };
  await updateRun(runId, { state, status: "running", error: null }, run);
  await emitEvent(runId, turn.stepId, "info", { code: "turnAnswered" });
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
  // A tool's answer is kept as it came; an agent step with `foreach` hands on its rows.
  if (
    !isDataStep(step) ||
    step.type === "tool" ||
    (step.type === "agent" && step.foreach) ||
    outputOf(step).format !== "json"
  ) {
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
  await updateRun(runId, { state }, run);
}

/**
 * Keeps something a person's request added to the run's state, nothing else about the run moves.
 * False: the run moved since `run` was read, and nothing is written.
 */
export async function writeRunState(
  run: Pick<RunRow, "id" | "rev">,
  state: RunState,
): Promise<boolean> {
  const result = await db
    .update(schema.run)
    .set({ state, rev: sql`${schema.run.rev} + 1` })
    .where(and(eq(schema.run.id, run.id), eq(schema.run.rev, run.rev)));
  return result.rowsAffected > 0;
}

export type ReviewAction =
  | { type: "accept"; edits?: Record<string, string | Record<string, unknown>>; note?: string }
  /** A review with `approve` is declined; `note` says why. */
  | { type: "decline"; note?: string }
  | { type: "regenerate"; target: string; note: string; items?: number[] };

/**
 * `accept` on a review with `approve` approves it, so every door that accepts can approve. `by`: who
 * answers, as the door established it; none for what the engine does itself.
 */
export async function reviewStep(runId: string, stepId: string, action: ReviewAction, by?: Actor) {
  const at = Date.now();
  const run = await requireWaiting(runId, stepId);
  const step = stepOf(run.definition, stepId);
  if (step?.type !== "review") {
    throw new RunConflict("Not a review");
  }
  if (action.type === "decline" && !step.approve) {
    throw new RunConflict({ code: "notAnApproval" });
  }
  if (action.type === "accept" || action.type === "decline") {
    const edits = action.type === "accept" ? action.edits : undefined;
    const edited: Record<string, StepOutput> = {};
    for (const [target, edit] of Object.entries(edits ?? {})) {
      const output = run.state.outputs[target];
      if (!step.edit || !step.show.includes(target) || !output) {
        continue;
      }
      edited[target] =
        typeof edit === "string"
          ? { ...output, text: edit.slice(0, 50_000) }
          : editedJson(run.definition, target, output, edit);
      // A guest's own words in a result are held to the same rules as what a step wrote.
      if (guestRun(run) && (await guestChecksOn())) {
        await checkGuestText({ text: typeof edit === "string" ? edit : JSON.stringify(edit) });
      }
    }
    const words = action.note?.trim().slice(0, 2000) || undefined;
    if (words && step.approve && guestRun(run) && (await guestChecksOn())) {
      await checkGuestText({ text: words });
    }
    const approved = action.type === "accept";
    const result = await flow(run, {
      kind: "reviewed",
      stepId,
      approved,
      ...(words ? { note: words } : {}),
      edited,
    });
    const { state, cursor } = result.run;
    state.answered = { at, next: cursor };
    await keepAnswerer(state, stepId, cursor, by);
    const goesOn = await answerGoesOn(run, step, result, {}, by, async () => {
      if (step.approve && whoOf(step) === "team" && (await durableRunsOn())) {
        await decidedHeld(run, { stepId, title: step.title }, approved, by?.userId ?? null).catch(
          (err) => console.error(`[approvals] run ${runId}:`, err),
        );
      }
      await tellAnswered(
        run,
        stepId,
        by,
        step.approve ? (approved ? "stepApprovedBy" : "stepDeclinedBy") : "stepAnsweredBy",
      );
    });
    if (goesOn) {
      kick(runId);
    }
    return;
  }
  // A step with several results makes only the named ones again.
  const result = await flow(run, {
    kind: "regenerate",
    stepId,
    target: action.target,
    note: action.note,
    ...(action.items?.length ? { items: action.items } : {}),
  });
  result.run.state.answered = { at, next: action.target };
  const goesOn = await answerGoesOn(run, step, result);
  await emitEvent(runId, action.target, "info", "Wird neu erstellt …");
  if (goesOn) {
    kick(runId);
  }
}

export async function goBack(runId: string, by?: Actor) {
  const run = await loadRun(runId);
  if (!run) {
    throw new RunConflict({ code: "runBusy" });
  }
  // What belonged to the step left behind goes with it, and whoever answered the page asked again
  // no longer has: the flow's `back`.
  await apply(run, run.state, await flow(run, { kind: "back" }), {
    seen: { rev: run.rev },
    by,
    stand: true,
  });
}

export async function retry(runId: string) {
  const run = await loadRun(runId);
  if (run?.status !== "failed") {
    throw new RunConflict("Nothing to retry");
  }
  // A failure gave the run's hold back: a refusal on wake must not be walked around here.
  const refused = (await durableRunsOn()) ? await holdAgain(run) : null;
  if (refused) {
    throw new RunConflict(refused);
  }
  // A person's "try again" gets every try anew. A turn that failed has dropped its snapshot: the
  // step starts over with a new one.
  await apply(run, run.state, await flow(run, { kind: "resume" }), { seen: { rev: run.rev } });
  kick(runId);
}

export async function cancel(runId: string) {
  active.get(runId)?.abort();
  // A run that is over already stays as it ended.
  if (!(await updateRun(runId, { status: "cancelled", wakeAt: null }, "open"))) {
    return;
  }
  // After the row: a crash in between gives a wake that finds the run over, never a lost cancel.
  await setWake(runId, null);
}

/** A write that only holds on the run as it was read; a run that moved on meanwhile refuses. */
async function whileItWaits(run: RunRow, patch: Partial<typeof schema.run.$inferInsert>) {
  try {
    await updateRun(run.id, patch, { rev: run.rev });
  } catch (err) {
    throw err instanceof RunConflict ? new RunConflict({ code: "runMovedOn" }) : err;
  }
}

/**
 * "Continue now": a wait is over now, so nobody has to sit it out. The row first: a crash after it
 * leaves the control copy on the old time, and the run goes on then. The clock's own statement puts
 * it in line, which also clears the control copy.
 */
export async function wakeNow(runId: string, by: string) {
  const run = await loadRun(runId);
  const now = new Date();
  // A time already gone by is the clock's: the run is about to go on, or going on.
  // A wait for a signal or a person goes on as at its deadline; without one there is no time to
  // bring forward.
  if (
    !(
      run?.status === "sleeping" ||
      run?.status === "waiting_signal" ||
      run?.status === "waiting_input"
    ) ||
    !run.wakeAt ||
    run.wakeAt <= now
  ) {
    throw new RunConflict({ code: "runMovedOn" });
  }
  await whileItWaits(run, { wakeAt: now });
  await emitEvent(runId, run.cursor, "woken", note("runWokenBy", { name: by }));
  await setWake(runId, now);
  await wakeDue(now);
  kick(runId);
}

/** What "Stop" may end: a run that waits, for a time or for a person. */
const STOPPABLE = new Set<RunStatus>(["sleeping", "waiting_signal", "waiting_input"]);

/** "Stop" on a run that waits. Unlike `cancel` it refuses a run that has moved on. */
export async function stopRun(runId: string, by: string) {
  const run = await loadRun(runId);
  if (!(run && STOPPABLE.has(run.status))) {
    throw new RunConflict({ code: "runMovedOn" });
  }
  await whileItWaits(run, { status: "cancelled", wakeAt: null });
  active.get(runId)?.abort();
  await emitEvent(runId, run.cursor, "stopped", note("runStoppedBy", { name: by }));
  // After the row: a crash in between gives a wake that finds the run over, never a lost stop.
  await setWake(runId, null);
}

// --- view --------------------------------------------------------------------

/** The formats a deliverable can really be downloaded in: a still widget has no video. */
export async function availableFormats(step: Step, run: RunRow, wanted?: Format[]) {
  const possible = formatsFor(step);
  let formats = wanted ? wanted.filter((f) => possible.includes(f)) : possible;
  const output = run.state.outputs[step.id];
  if (step.type === "widget" && formats.includes("mp4")) {
    // A video is rendered when its step runs; any other widget on demand.
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
/** What a page's `components` read besides its answers. A step that stays in the space stays there. */
async function formDataOf(
  refs: Record<string, string>,
  run: RunRow,
  def: WizardDefinition,
  name: string,
  hide: ReadonlySet<string>,
): Promise<Record<string, unknown>> {
  const open = Object.entries(refs).filter(([, ref]) => {
    const [head, id] = dataRef(ref).split(".");
    return !(head === "steps" && hide.has(id));
  });
  const scope = {
    def,
    state: run.state,
    brand: { name },
    ...(open.some(([, ref]) => listRef(dataRef(ref))) ? { lists: await storedLists(run) } : {}),
  };
  return surfaceData(Object.fromEntries(open), { def, state: run.state, scope });
}

/** What the result step's `data` names, read from the run as a surface reads it. */
async function resultDataOf(
  refs: Record<string, string>,
  run: RunRow,
  state: RunState,
): Promise<Record<string, unknown>> {
  const def = run.definition;
  const reads = (head: string) => Object.values(refs).some((ref) => dataRef(ref).startsWith(head));
  const scope = {
    def,
    state,
    brand: reads("brand.") ? spaceProfile(await loadSpace(run)) : {},
    ...(Object.values(refs).some((ref) => listRef(dataRef(ref)))
      ? { lists: await storedLists(run) }
      : {}),
  };
  return surfaceData(refs, { def, state, scope });
}

function prefillOf(
  step: FormStep,
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

/** The viewer is the person whose run it is. */
const ownsRun = (run: RunRow, viewer: Caller) =>
  Boolean(
    viewer.local ||
      viewer.link ||
      (viewer.userId && viewer.userId === run.userId) ||
      (viewer.visitorId && viewer.visitorId === run.visitorId),
  );

/**
 * What a run that waits for a sign-in to one of the wizard's connections offers the viewer. A
 * connection that signs in as the space is an admin's to sign in again. The card is for the
 * person whose run it is: the wizard's own account, or their own sign-in to a connection of the
 * space where each person signs in, if it is open to them. A guest never gets that one.
 */
async function signInOf(
  run: RunRow,
  def: WizardDefinition,
  viewer: Caller | undefined,
): Promise<RunSignIn | null> {
  const pause = run.status === "sleeping" ? run.state.pause : undefined;
  const connection =
    pause?.kind === "sign_in" ? def.connections?.find((c) => c.id === pause.connection) : undefined;
  if (!connection) {
    return null;
  }
  const row = await spaceRowOf(run, connection.id);
  if (connection.spaceConnection && !row) {
    return null;
  }
  if (row?.signIn === "space") {
    return { admin: true };
  }
  if (!(viewer && ownsRun(run, viewer))) {
    return null;
  }
  const spaceId = await spaceIdOf(run);
  const lang = textLang(wizardLang(def));
  if (!row) {
    const [view] = await connectionViews([connection], scopeOf(run), spaceId, lang);
    // An account the step met and could not use is no account: the card connects anew.
    return { connection: { ...view, account: null } };
  }
  const who = {
    kind: viewer.role && isAdminRole(viewer.role) ? ("admin" as const) : ("person" as const),
    id: viewer.userId ?? "",
  };
  if (!(run.userId && viewer.userId === run.userId && inAudience(row.audience, who))) {
    return null;
  }
  return {
    connection: {
      id: connection.id,
      kind: connection.kind ?? null,
      connector: row.connectorId,
      title: connection.title ?? row.name,
      description: connection.description ?? null,
      account: null,
      connectors: await connectorOptions(
        { id: connection.id, connector: row.connectorId },
        spaceId,
        lang,
      ),
    },
  };
}

/**
 * The run as the viewer sees it. `hide`: steps whose output stays in the space (broker/kept.ts):
 * shown with no output and `kept`, left out of `outputs`; empty for a member, or a member's run.
 * `viewer`: who looks, for what only they can do here (the connect card while the run waits for
 * their sign-in).
 */
export async function runView(
  run: RunRow,
  brand: RunView["brand"],
  hide: ReadonlySet<string> = new Set(),
  viewer?: Caller,
): Promise<RunView> {
  // In the viewer's language every text of the view is the translation; ids and values stay.
  const memory = run.lang ? await storedTranslation(run.wizardId, run.lang) : null;
  const translated = memory ? translateDefinition(run.definition, memory) : null;
  const def = translated?.def ?? run.definition;
  const step = stepOf(def, run.cursor) ?? null;
  const closed =
    step?.type === "form" && run.status === "waiting_input"
      ? await closedChoices(def, step, run.state.values)
      : {};
  const index = step ? def.steps.indexOf(step) : def.steps.length;
  const sections = sectionsOf(def);
  const refs =
    step?.type === "review"
      ? step.show
      : step?.type === "result"
        ? [...new Set(step.deliverables.map((d) => d.from))]
        : [];
  const shownIds = refs.filter((ref) => !listRef(ref));
  const listIds = [
    ...refs.map(listRef),
    ...(step?.type === "form" ? step.fields.map((f) => (f.kind === "list" ? f.list : null)) : []),
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
          formats: await availableFormats(s, run, deliverable?.formats),
          label: deliverable?.label ?? null,
        };
      }),
  );
  return {
    id: run.id,
    status: run.status,
    wakeAt:
      run.status === "sleeping" || run.status === "waiting_signal" || run.status === "waiting_input"
        ? (run.wakeAt?.toISOString() ?? null)
        : null,
    pause: run.status === "sleeping" ? (run.state.pause ?? null) : null,
    signIn: await signInOf(run, def, viewer),
    waitsFor:
      run.status === "waiting_signal" && step?.type === "wait"
        ? waitKeyText(run, step) || null
        : null,
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
    // Nobody to talk to while it waits, and nothing to say.
    talk: run.status !== "sleeping" && run.status !== "waiting_signal" && (await talkAllowed(run)),
    step,
    answered: run.state.history.map((id) => stepOf(def, id)).filter((s): s is Step => Boolean(s)),
    values: run.state.values,
    rev: run.rev,
    // What the browser may do alone, and what was typed and not sent: `viewFor` keeps both from a
    // viewer who may not answer.
    ...(run.status === "waiting_input" && step?.type === "form" && !run.startedBy
      ? {
          ahead: await aheadOf(run, def, step),
          pagesSent: run.state.pagesSent?.n ?? 0,
        }
      : {}),
    ...(run.status === "waiting_input" && step?.type === "form" && run.unsent?.[step.id]
      ? { unsent: run.unsent[step.id] }
      : {}),
    prefill: step?.type === "form" ? prefillOf(step, run, closed) : {},
    ...(step?.type === "form" && step.data
      ? { pageData: await formDataOf(step.data, run, def, brand.name, hide) }
      : {}),
    ...(step?.type === "form" ? viewContext(await formContext(run, step)) : {}),
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
    events: (await recentEvents(run.id, 0, 30)).map((ev) =>
      memory?.[ev.message] && !ev.note ? { ...ev, message: memory[ev.message].text } : ev,
    ),
    brand,
    ask: run.status === "running" ? run.ask : null,
    question: run.status === "waiting_input" ? (run.state.turn?.question ?? null) : null,
    lists,
    connections:
      step?.type === "form" && step.fields.some((f) => f.kind === "connection")
        ? await connectionViews(
            def.connections ?? [],
            scopeOf(run),
            await spaceIdOf(run),
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

/**
 * A signal for this one run and the wait it stands at: "Testereignis senden", or what a person
 * writes on a channel while the run waits. Null: the run does not wait for a signal now, or the
 * data does not fit; then nothing is written, and what was said goes where the run stands.
 */
export async function signalRun(
  runId: string,
  input: {
    data?: Record<string, unknown>;
    source: string;
    delivery?: string | null;
    /** Only a wait for this name takes it; without, the wait the run stands at. */
    only?: string;
  },
) {
  const run = await loadRun(runId);
  const step = run ? stepOf(run.definition, run.cursor) : undefined;
  if (run?.status !== "waiting_signal" || step?.type !== "wait" || !step.signal) {
    return null;
  }
  const { only, ...signal } = input;
  if (only ? step.signal.name !== only : signalMissing(input.data, step.signal.fields).length) {
    return null;
  }
  if (signalMissing(input.data, step.signal.fields).length) {
    return null;
  }
  return sendSignal({
    spaceId: await spaceIdOf(run),
    scope: runScope(run.id),
    name: step.signal.name,
    key: waitKeyOf(run, step),
    ...signal,
  });
}

/** The brand's own kinds of file: a space that takes the organization's brand shows the root's. */
const BRAND_FILES = new Set(["logo", "pattern", "asset"]);

/** The space's ready files a run sees, with the organization's brand files where it takes them. */
async function runSpaceFiles(spaceId: string) {
  const own = (await spaceFiles(spaceId)).filter((f) => f.status === "ready");
  const from = await brandSpaceId(spaceId);
  if (from === spaceId) {
    return own;
  }
  const brand = (await spaceFiles(from)).filter(
    (f) => f.status === "ready" && BRAND_FILES.has(f.kind),
  );
  return [...brand, ...own.filter((f) => !BRAND_FILES.has(f.kind))];
}
