import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
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
  RUN_DONE_SIGNAL,
  type Step,
  signalMissing,
  textLang,
  type WaitStep,
  type WizardDefinition,
  waitDurationMs,
  whenHolds,
  wizardLang,
} from "@engenty/wizards-shared/definition";
import type { RunNote, RunPause, RunStatus, Said, StepOutput } from "@engenty/wizards-shared/run";
import {
  CAN_GO_BACK,
  type ClosedChoice,
  isNoteTime,
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
import { and, eq, lt, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { currentImpersonator } from "../auth/impersonation.js";
import { enterVisit } from "../broker/effect.js";
import { grantNote, grantOf, type KnownConnector, kindOf } from "../broker/index.js";
import { runHolder, subjectsOf } from "../broker/rwx.js";
import { resolveConnector } from "../connectors/external.js";
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
import { prompt } from "../prompts.js";
import {
  ContentBlockedError,
  checkGuestInput,
  checkGuestText,
  guestChecksOn,
  guestRun,
} from "../safety.js";
import { nameOf } from "../services/access.js";
import { reportRun } from "../services/manage-reports.js";
import { switchedOffRunners } from "../services/runners.js";
import { spaceFiles } from "../services/space-files.js";
import { spaceProfile } from "../services/spaces.js";
import { storedTranslation } from "../services/translations.js";
import { latestShareJob } from "../sharing/state.js";
import { listRows, listSecrets, scopeOf } from "../store/index.js";
import {
  claimRun,
  disownRuns,
  heartbeatRuns,
  indexRun,
  markLine,
  restRun,
  setWake,
  waitingRuns,
  wakeDue,
  wakeRun,
} from "../tenants/control.js";
import { currentTenant } from "../tenants/tenant.js";
import { askPerson, clearStaleAsk } from "./asks.js";
import { decide } from "./decide.js";
import { clearDeviceCalls } from "./device.js";
import { emitEvent, recentEvents, saidInVisit, signalChanged, visitLeftOpen } from "./events.js";
import { classifyFailure, type Failure } from "./failures.js";
import { type InputError, type PageContext, readPageInput } from "./input.js";
import { pushRun } from "./push.js";
import {
  blockingMessage,
  closedChoices,
  maskedNote,
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
  signalData,
} from "./signals.js";
import { outputSchema, runAutomaticStep } from "./steps.js";
import { answersAsText, fillLabel, renderTemplate, resolveRef } from "./template.js";
import type { RunHolder, RunRow, SpaceRow, StepContext } from "./types.js";
import { SignInNeeded, StepError } from "./types.js";

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

/** Where a run's data is: the client space it was started in, else its wizard's space. */
async function dataSpaceOf(run: RunRow, space: SpaceRow): Promise<{ id: string; name: string }> {
  if (!run.clientSpaceId) {
    return { id: space.id, name: space.name };
  }
  const client = await db.query.space.findFirst({
    columns: { id: true, name: true },
    where: eq(schema.space.id, run.clientSpaceId),
  });
  if (!client) {
    throw new Error("client space missing");
  }
  return client;
}

/**
 * Writes the run. Inside its drive the write needs the drive's claim; with `seen`, a person's write
 * needs the `rev` it read, and a wait's write the status it came from: a cancel wins over either. A
 * step may start or answer other runs: only its own run's claim counts.
 */
async function updateRun(
  runId: string,
  patch: Partial<typeof schema.run.$inferInsert>,
  seen?: { rev: number } | { status: RunStatus },
) {
  const holder = driving.getStore();
  const held = holder?.runId === runId ? holder : undefined;
  const result = await db
    .update(schema.run)
    .set({
      ...patch,
      // A run that rests has no drive to break off, whatever becomes of this process now.
      ...(patch.status && patch.status !== "running" ? { driving: false } : {}),
      rev: sql`${schema.run.rev} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.run.id, runId),
        held ? eq(schema.run.claim, held.generation) : undefined,
        seen && ("rev" in seen ? eq(schema.run.rev, seen.rev) : eq(schema.run.status, seen.status)),
      ),
    );
  if (result.rowsAffected === 0) {
    if (held) {
      throw new LostClaim();
    }
    if (seen) {
      throw new RunConflict({ code: "runBusy" });
    }
  }
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
  }
  if (patch.status) {
    reportRun(runId, patch.status);
  }
  signalChanged(runId);
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
    classifyFailure(err, { managed }).why === "credits"
  ) {
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
  const { why } = classifyFailure(err, { managed });
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

/**
 * A step that failed ends the run. A failure with a note (Apple Intelligence's) goes into the log
 * as that note, so a runner shows it in its language; the run's error is in the wizard's.
 */
async function failRun(run: RunRow, stepId: string, err: unknown) {
  const said = noteOf(err) ?? (await tierRefusalSaid(err)) ?? friendly(err);
  const message = saidText(said, textLang(wizardLang(run.definition)));
  await emitEvent(run.id, stepId, "error", said);
  // What the content rules stopped is kept on the run: Manage hears of it with the failed turn.
  const blocked =
    err instanceof ContentBlockedError
      ? (
          await db.query.run.findFirst({
            where: eq(schema.run.id, run.id),
            columns: { state: true },
          })
        )?.state
      : undefined;
  await updateRun(run.id, {
    status: "failed",
    error: message,
    ...(blocked && err instanceof ContentBlockedError
      ? { state: { ...blocked, blocked: err.kind } }
      : {}),
  });
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
  /** The client space it runs in, with its parent's wizard (docs/plans/client-portal.md). */
  clientSpaceId?: string | null;
}): Promise<string> {
  const id = nanoid(18);
  const first = input.definition.steps[0];
  const state: RunState = { values: {}, outputs: {}, history: [], notes: {} };
  // Off, nothing starts that would need the clock; a run that already waits goes on.
  if (input.definition.steps.some((s) => s.type === "wait") && !(await durableRunsOn())) {
    throw new ModelUnavailableError(note("waitsOff"));
  }
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
  // What the run may reach outside, from the definition it starts on: fixed here, never widened.
  const grant = grantOf(input.definition);
  await db.insert(schema.run).values({
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
    status: first.type === "page" ? "waiting_input" : "running",
    cursor: first.id,
    state,
    label: await labelOf(input.definition, state),
    // Without an account nobody can come back for a result later: it is kept a week. A run of a
    // client space is the client's, kept with it.
    expiresAt:
      input.mode === "live" && !input.clientSpaceId
        ? new Date(Date.now() + env.limits.resultTtlDays * 24 * 60 * 60 * 1000)
        : null,
  });
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
  await indexRun({ runId: id, visitorId: input.visitorId, ipHash: input.ipHash });
  reportRun(id, first.type === "page" ? "waiting_input" : "running");
  if (first.type !== "page") {
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
    .then(() => {
      if (env.serves.runner) {
        return take(runId, tenant);
      }
    })
    .catch((err) => console.error(`[run ${runId}]`, err));
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
          run?.status === "waiting_signal";
        if (run && (!working || run.claim !== generation)) {
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
          await updateRun(runId, { status: "failed", error: saidText(friendly(err), lang) });
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
  resources.bind(store, run, own.share);
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
    spaceFiles: (await spaceFiles(space.id)).filter((f) => f.status === "ready"),
    signal,
    resources,
    ask:
      own.ask ??
      ((ask) =>
        run.unattended ? Promise.resolve(null) : askPerson(run.id, { ...ask, stepId }, signal)),
    emit:
      own.emit ?? ((type, message, asset) => emitEvent(run.id, run.cursor, type, message, asset)),
    call: { runId: run.id, stepId },
    ...(own.share ? { share: true } : {}),
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
function keptUntil(run: RunRow, wakeAt: Date | null): Date | null {
  if (!run.expiresAt) {
    return null;
  }
  const end = wakeAt ? wakeAt.getTime() : Date.now() + NO_DEADLINE_KEPT_MS;
  const kept = end + env.limits.resultTtlDays * 86_400_000;
  return new Date(Math.max(run.expiresAt.getTime(), kept));
}

/** When a wait ends; an `until` that says no date fails the run with what it says. */
function wakeTimeOf(run: RunRow, step: WaitStep): Date {
  if (!step.until) {
    return new Date(Date.now() + waitDurationMs(step.for ?? "1m"));
  }
  const said = renderTemplate(step.until, {
    def: run.definition,
    state: run.state,
    brand: {},
  }).trim();
  const wakeAt = new Date(said);
  if (Number.isNaN(wakeAt.getTime())) {
    throw new NotedError(note("waitDateUnreadable", { date: said }));
  }
  return wakeAt;
}

/** The time a `wait` line of the log said. */
function saidUntil(said: { note: RunNote | null } | null): Date | null {
  const until = said?.note?.params?.until;
  return isNoteTime(until) ? new Date(until.at) : null;
}

/**
 * A `wait` is reached: the run leaves every process and stays as a row. False: the time has gone
 * by already, and the run goes on at once.
 */
async function enterWait(run: RunRow, step: WaitStep, interrupted: boolean): Promise<boolean> {
  // Back after a crash on the way in: the visit stays one, and the time it said stays too.
  const open = interrupted && (await visitLeftOpen(run.id, step.id));
  if (!open) {
    await emitEvent(run.id, step.id, "step_started", step.title);
  }
  if (step.signal) {
    return enterSignalWait(run, step);
  }
  const said = open ? await saidInVisit(run.id, step.id, "wait") : null;
  const wakeAt = saidUntil(said) ?? wakeTimeOf(run, step);
  if (wakeAt.getTime() <= Date.now()) {
    await finishWait(run, step, await waitOver(run, step));
    return false;
  }
  if (!said) {
    await emitEvent(
      run.id,
      step.id,
      "wait",
      note("runWaitsUntil", { until: { at: wakeAt.toISOString() } }),
    );
  }
  await setWake(run.id, wakeAt);
  await updateRun(
    run.id,
    { status: "sleeping", wakeAt, expiresAt: keptUntil(run, wakeAt), error: null },
    { status: "running" },
  );
  return true;
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

/**
 * The wait is written first, then the run looks: a signal that came before is found here, and one
 * that comes after finds the wait and wakes the run. Its wake meanwhile keeps the run in line.
 */
async function enterSignalWait(run: RunRow, step: WaitStep): Promise<boolean> {
  const key = waitKeyOf(run, step);
  const spaceId = await spaceIdOf(run);
  await registerWait(run, spaceId, step, key);
  const signal = await findSignal(run, spaceId, step, key);
  if (signal) {
    await dropWait(run.id);
    await finishWait(run, step, await waitOver(run, step, signal));
    return false;
  }
  const timeout = step.signal?.timeout;
  const wakeAt = timeout ? new Date(Date.now() + waitDurationMs(timeout)) : null;
  if (wakeAt) {
    await setWake(run.id, wakeAt);
  }
  await updateRun(
    run.id,
    { status: "waiting_signal", wakeAt, expiresAt: keptUntil(run, wakeAt), error: null },
    { status: "running" },
  );
  return true;
}

interface WaitOver {
  state: RunState;
  cursor: string | null;
  said?: RunNote;
}

/** The wait is behind the run: its output, and the way on. `signal`: what ended it, if anything. */
async function waitOver(
  run: RunRow,
  step: WaitStep,
  signal?: { id: string; data: Record<string, unknown> | null } | null,
): Promise<WaitOver> {
  const state = structuredClone(run.state);
  let json: Record<string, unknown> = { waited: true };
  if (signal) {
    json = { came: true, timedOut: false, data: signalData(step, signal.data) };
    state.signals = [...(state.signals ?? []), signal.id];
  } else if (step.signal) {
    json = { came: false, timedOut: true };
  }
  state.outputs[step.id] = { json, at: new Date().toISOString() };
  const said = step.signal ? note(signal ? "signalCame" : "signalTimedOut") : undefined;
  return { state, cursor: await advance(run, step.id, state), said };
}

async function finishWait(run: RunRow, step: WaitStep, { state, cursor, said }: WaitOver) {
  await updateRun(
    run.id,
    { state, cursor, status: cursor ? "running" : "done", wakeAt: null, error: null },
    { status: run.status },
  );
  if (said) {
    await emitEvent(run.id, step.id, "info", said);
  }
  await emitEvent(run.id, step.id, "step_done", step.title);
}

/** Holds the credits a run needs to go on; what it says when they are refused, else null. */
async function holdAgain(run: RunRow): Promise<RunNote | null> {
  const estimate = await estimateRun(
    run.wizardId,
    run.version,
    run.definition,
    await stepsWithoutModel(run.definition),
  );
  const held = await reserveForRun(run.id, estimate.reserve, guestRun(run));
  return held === true
    ? null
    : note(held === "guest_budget" ? "guestBudget" : "wizardRunOutCredits");
}

/**
 * A run that waits is woken: true when it goes on, false when it does not. The row decides, not
 * the wake: one that comes early or twice, with no signal for it, puts the time back and changes
 * nothing.
 */
async function wakeFromWait(run: RunRow): Promise<boolean> {
  const step = stepOf(run.definition, run.cursor);
  if (step?.type !== "wait") {
    await updateRun(run.id, { status: "running", wakeAt: null }, { status: run.status });
    return true;
  }
  const signal = step.signal
    ? await findSignal(run, await spaceIdOf(run), step, waitKeyOf(run, step))
    : null;
  const due = run.wakeAt ? run.wakeAt.getTime() <= Date.now() : !step.signal;
  if (!(signal || due)) {
    await setWake(run.id, run.wakeAt);
    return false;
  }
  const over = await waitOver(run, step, signal);
  const next = stepOf(run.definition, over.cursor);
  let refused: RunNote | null = null;
  // A sleeping run gave its hold back, and a hold lapses anyway: it holds again before it spends.
  if (next && next.type !== "result") {
    try {
      refused = await holdAgain(run);
    } catch (err) {
      // The Manage-App out of reach is no refusal: the time stays due, the clock tries again.
      console.warn(`[run ${run.id}] holding credits on wake:`, (err as Error).message);
      await setWake(run.id, run.wakeAt ?? new Date());
      return false;
    }
  }
  if (step.signal) {
    // Which of them ended it, `finishWait` says.
    await dropWait(run.id);
    await setWake(run.id, null);
    // A person's "Continue now" said so itself, and a wake that came back after a crash has said it.
  } else if (!(await saidInVisit(run.id, step.id, "woken"))) {
    await emitEvent(run.id, step.id, "woken", note("runWaitOver"));
  }
  if (!refused) {
    await finishWait(run, step, over);
    return true;
  }
  // The wait is over either way: the top-up goes on from the next step and does not wait again.
  await waitForPerson(
    { ...run, cursor: over.cursor },
    over.cursor ?? step.id,
    { kind: "credits" },
    over.state,
    run.status,
  );
  return false;
}

// --- when a step fails ---------------------------------------------------------
// Nothing waits in memory: a retry and a wait for a person are one more reason to sleep, so they
// hold no process, no slot and no credits, and they survive a restart.

/** After how long a step tries again; its length is how many more tries it gets. */
const RETRY_MINUTES = [1, 5, 30];
/** A service may ask for a wait in `Retry-After`, up to this: a run may sleep, but not for a week. */
const RETRY_AFTER_MAX_MS = 6 * 3600_000;
/**
 * How often a run that waits for a person looks whether they acted. A top-up on the Manage-App is
 * seen by the reservation alone, so that look costs nothing. A runtime that runs alone has only
 * the provider itself to ask, with a call of the step's, so it asks less often.
 */
const lookAgainMs = () => (managed ? 5 : 30) * 60_000;
/** A person who hasn't acted after this long won't: the run fails, and "try again" stays. */
const PERSON_WAIT_MAX_MS = 30 * 86_400_000;
/** A step's `onFail` is taken at most this often, so two failing steps can't send a run round forever. */
const ON_FAIL_MAX = 3;

/** The step's count of tries; a new step starts over. */
function retriesOf(state: RunState, stepId: string): NonNullable<RunState["retries"]> {
  return state.retries?.step === stepId
    ? state.retries
    : { step: stepId, count: 0, since: new Date().toISOString() };
}

/** The run sleeps for `pause` until `wakeAt`. The control copy first, as for a `wait`. */
async function sleepFor(
  run: RunRow,
  pause: RunPause,
  wakeAt: Date,
  state: RunState,
  from: RunStatus,
) {
  await setWake(run.id, wakeAt);
  await updateRun(
    run.id,
    {
      state: { ...state, pause },
      cursor: run.cursor,
      status: "sleeping",
      wakeAt,
      expiresAt: keptUntil(run, wakeAt),
      error: null,
    },
    { status: from },
  );
}

/**
 * Someone has to act before the run goes on, and this is the one place that tells them. Today that
 * is the run's log, which the runner, the studio's panel and a channel's thread show, and the phone
 * that follows the run. Nothing reaches an owner who isn't looking: PR 9's notice goes here.
 */
async function tellPerson(run: RunRow, stepId: string, pause: RunPause) {
  await emitEvent(
    run.id,
    stepId,
    "error",
    pause.kind === "sign_in"
      ? note("stepWaitsSignIn", { service: pause.service })
      : note("stepWaitsCredits"),
  );
  void pushRun(run.id, "waiting");
}

/** Out of credits or signed out: the run waits for a person, and fails only if nobody ever comes. */
async function waitForPerson(
  run: RunRow,
  stepId: string,
  pause: Exclude<RunPause, { kind: "retry" }>,
  state: RunState,
  from: RunStatus,
) {
  const retries = retriesOf(state, stepId);
  if (Date.now() - Date.parse(retries.since) > PERSON_WAIT_MAX_MS) {
    const { pause: _, retries: __, ...rest } = state;
    await updateRun(run.id, { state: rest, wakeAt: null }, { status: from });
    await failRun(
      run,
      stepId,
      pause.kind === "credits"
        ? new NoCreditsError()
        : new NotedError(note("stepWaitsSignIn", { service: pause.service })),
    );
    return;
  }
  // Said once: the run looks again every few minutes for as long as it waits.
  if (retries.told !== pause.kind) {
    await tellPerson(run, stepId, pause);
  }
  await sleepFor(
    run,
    pause,
    new Date(Date.now() + lookAgainMs()),
    { ...state, retries: { ...retries, told: pause.kind } },
    from,
  );
}

/** When the step tries again: what the service asked for within its cap, else the next of the list. */
function retryDelayMs(failure: Failure, count: number): number {
  return failure.retryAfterMs === null
    ? RETRY_MINUTES[count] * 60_000
    : Math.min(Math.max(failure.retryAfterMs, 60_000), RETRY_AFTER_MAX_MS);
}

/**
 * A step failed; true when the run goes on elsewhere (`onFail`), false when this drive is over for
 * now. A retry starts the step from the top, so one that may have done something out there
 * (`RunResources.acted`) is not started again by itself, or the mail goes out twice: its failure
 * is final, and a person can still choose "try again". A refused sign-in did nothing.
 */
async function stepFailed(run: RunRow, stepId: string, err: unknown, acted = false) {
  if (!(await durableRunsOn())) {
    await failRun(run, stepId, err);
    return false;
  }
  const failure = classifyFailure(err, { managed });
  // From the row, not from the step's copy: what the step did to its copy is not to stay, and what
  // was written while it worked (run_effect's visit) is.
  const latest = (await loadRun(run.id)) ?? run;
  if (!acted || err instanceof SignInNeeded) {
    if (failure.class === "credits") {
      await waitForPerson(latest, stepId, { kind: "credits" }, latest.state, "running");
      return false;
    }
    if (failure.class === "sign_in") {
      const service = err instanceof SignInNeeded ? err.service : "";
      await waitForPerson(latest, stepId, { kind: "sign_in", service }, latest.state, "running");
      return false;
    }
    const retries = retriesOf(latest.state, stepId);
    if (failure.class === "retry" && retries.count < RETRY_MINUTES.length) {
      const delay = retryDelayMs(failure, retries.count);
      console.warn(
        `[run ${run.id} step ${stepId}] ${failure.why}, try ${retries.count + 1} in ${Math.round(delay / 60_000)} min:`,
        (err as Error)?.message,
      );
      await emitEvent(
        run.id,
        stepId,
        "info",
        note("stepRetries", { minutes: Math.round(delay / 60_000) }),
      );
      await sleepFor(
        latest,
        { kind: "retry" },
        new Date(Date.now() + delay),
        { ...latest.state, retries: { ...retries, count: retries.count + 1 } },
        "running",
      );
      return false;
    }
  }
  return failedForGood(latest, stepId, err);
}

/** Past every try: the run goes where the step's `onFail` says, else it fails as it always did. */
async function failedForGood(run: RunRow, stepId: string, err: unknown): Promise<boolean> {
  const step = stepOf(run.definition, stepId);
  const target = stepOf(run.definition, step?.onFail ?? null);
  const key = target ? loopKey(stepId, target.id) : "";
  if (!target || (run.state.loops?.[key] ?? 0) >= ON_FAIL_MAX) {
    await failRun(run, stepId, err);
    return false;
  }
  const said = noteOf(err) ?? (await tierRefusalSaid(err)) ?? friendly(err);
  await emitEvent(run.id, stepId, "error", said);
  await emitEvent(run.id, stepId, "info", note("stepFailedGoesOn", { step: target.title }));
  const state = structuredClone(run.state);
  state.loops = { ...state.loops, [key]: (state.loops?.[key] ?? 0) + 1 };
  // What the content rules stopped stays known, on this way too.
  if (err instanceof ContentBlockedError) {
    state.blocked = err.kind;
  }
  delete state.retries;
  delete state.deciding;
  await updateRun(run.id, { state, cursor: target.id, status: "running", error: null });
  return true;
}

/**
 * A run that slept for a retry or for a person is woken. Like `wakeFromWait` the row decides, and
 * the run holds credits again before it spends. Refused: it waits for them, whatever it slept for.
 * A person who acted is noticed here; one who has not sends the step back to `stepFailed`.
 */
async function wakeFromPause(run: RunRow): Promise<boolean> {
  if (run.wakeAt && run.wakeAt.getTime() > Date.now()) {
    await setWake(run.id, run.wakeAt);
    return false;
  }
  const stepId = run.cursor ?? "";
  const state = structuredClone(run.state);
  delete state.pause;
  const step = stepOf(run.definition, run.cursor);
  let refused = false;
  if (step && step.type !== "result") {
    try {
      refused = (await holdAgain(run)) !== null;
    } catch (err) {
      // The Manage-App out of reach is no refusal: the time stays due, the clock tries again.
      console.warn(`[run ${run.id}] holding credits on wake:`, (err as Error).message);
      await setWake(run.id, run.wakeAt ?? new Date());
      return false;
    }
  }
  if (refused) {
    await waitForPerson(run, stepId, { kind: "credits" }, state, "sleeping");
    return false;
  }
  await updateRun(
    run.id,
    { state, status: "running", wakeAt: null, error: null },
    { status: "sleeping" },
  );
  return true;
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
    if (run?.status !== "running") {
      return;
    }
    const def = run.definition;
    // A step's `ask` branches wait on a decision before the run goes on.
    const deciding = run.state.deciding ? stepOf(def, run.state.deciding) : undefined;
    if (deciding) {
      const state = structuredClone(run.state);
      try {
        const cursor = await withDeadline("decision", signal, (limit) =>
          decideBranch(run, deciding, state, limit),
        );
        if (signal.aborted) {
          return;
        }
        await syncRunCost(runId);
        delete state.retries;
        await updateRun(runId, { state, cursor, status: cursor ? "running" : "done", error: null });
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
    if (!step) {
      await updateRun(runId, { status: "done" });
      return;
    }
    // A page whose fields a decision picks: picked once, as the run reaches it.
    if (step.type === "page" && step.fields.some(isDecidedField) && !run.state.pages?.[step.id]) {
      const state = structuredClone(run.state);
      try {
        const shown = await withDeadline("decision", signal, (limit) =>
          decidePageFields(run, step, state, limit),
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
    if (step.type === "result") {
      await updateRun(runId, { status: "done" });
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
    if (step.type === "page" || step.type === "review") {
      await updateRun(runId, { status: "waiting_input" });
      // A step that ran is over and the next one is the person's: a phone in a pocket hears it.
      void pushRun(runId, "waiting");
      return;
    }
    if (!(await canSpend())) {
      if (await durableRunsOn()) {
        await waitForPerson(run, step.id, { kind: "credits" }, run.state, "running");
        return;
      }
      const message = new NoCreditsError().message;
      await emitEvent(runId, step.id, "error", message);
      await updateRun(runId, { status: "failed", error: message });
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
      if (await enterVisit(step, state)) {
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
      state.outputs[step.id] = output;
      delete state.notes[step.id];
      delete state.redo?.[step.id];
      delete state.visiting;
      delete state.retries;
      const cursor = await advance(run, step.id, state);
      await updateRun(runId, {
        state,
        cursor,
        status: cursor ? "running" : "done",
        error: null,
        ...(run.definition.label ? { label: await labelOf(run.definition, state) } : {}),
      });
      const masked = takeMasked(runId, step.id);
      if (masked) {
        await emitEvent(runId, step.id, "info", maskedNote(masked));
      }
      await emitEvent(runId, step.id, "step_done", step.title);
    } catch (err) {
      if (signal.aborted) {
        return;
      }
      if (err instanceof LostClaim) {
        throw err;
      }
      console.error(`[run ${runId} step ${step.id}]`, err);
      await noteFreeTierRefusal(err);
      if (!(await stepFailed(run, step.id, err, liveResources(runId)?.acted))) {
        return;
      }
    }
  }
}

// --- commands ----------------------------------------------------------------

/** A person's step is behind the run: its timeline says so, as for a step that ran by itself. */
async function tellAnswered(run: RunRow, stepId: string) {
  if (await durableRunsOn()) {
    await emitEvent(run.id, stepId, "step_done", stepOf(run.definition, stepId)?.title ?? stepId);
  }
}

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
  await updateRun(
    runId,
    { state, cursor, status: "running", error: null, label: await labelOf(run.definition, state) },
    run,
  );
  await tellAnswered(run, stepId);
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
      // A guest's own words in a result are held to the same rules as what a step wrote.
      if (guestRun(run) && (await guestChecksOn())) {
        await checkGuestText({ text: typeof edit === "string" ? edit : JSON.stringify(edit) });
      }
    }
    state.history.push(stepId);
    const cursor = await advance(run, stepId, state);
    await updateRun(runId, { state, cursor, status: "running", error: null }, run);
    await tellAnswered(run, stepId);
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
  await updateRun(runId, { state, cursor: action.target, status: "running", error: null }, run);
  await emitEvent(runId, action.target, "info", "Wird neu erstellt …");
  kick(runId);
}

export async function goBack(runId: string) {
  const run = await loadRun(runId);
  if (!run || !CAN_GO_BACK.has(run.status)) {
    throw new RunConflict({ code: "runBusy" });
  }
  const state = structuredClone(run.state);
  const previous = state.history.pop();
  if (!previous) {
    throw new RunConflict({ code: "noStepBefore" });
  }
  // A decision that failed belongs to the step left behind, and so do a visit that stopped and its
  // tries.
  delete state.deciding;
  delete state.visiting;
  delete state.retries;
  delete state.pause;
  await updateRun(runId, { state, cursor: previous, status: "waiting_input", error: null }, run);
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
  // A person's "try again" gets every try anew.
  const state = structuredClone(run.state);
  delete state.retries;
  delete state.pause;
  await updateRun(runId, { state, status: "running", error: null }, run);
  kick(runId);
}

export async function cancel(runId: string) {
  active.get(runId)?.abort();
  await updateRun(runId, { status: "cancelled", wakeAt: null });
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
  if (run?.status !== "sleeping" || !run.wakeAt || run.wakeAt <= now) {
    throw new RunConflict({ code: "runMovedOn" });
  }
  await whileItWaits(run, { wakeAt: now });
  await emitEvent(runId, run.cursor, "woken", note("runWokenBy", { name: by }));
  await setWake(runId, now);
  await wakeDue(now);
  kick(runId);
}

/** What "Stop" may end: a run that waits, for a time or for a person. */
const STOPPABLE = new Set<RunStatus>(["sleeping", "waiting_input"]);

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

/**
 * The run as the viewer sees it. `hide`: steps whose output stays in the space (broker/kept.ts):
 * shown with no output and `kept`, left out of `outputs`; empty for a member, or a member's run.
 */
export async function runView(
  run: RunRow,
  brand: RunView["brand"],
  hide: ReadonlySet<string> = new Set(),
): Promise<RunView> {
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
      run.status === "sleeping" || run.status === "waiting_signal"
        ? (run.wakeAt?.toISOString() ?? null)
        : null,
    pause: run.status === "sleeping" ? (run.state.pause ?? null) : null,
    waitsFor:
      run.status === "waiting_signal" && step?.type === "wait"
        ? waitKeyText(run, step) || null
        : null,
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
      shownIds
        .filter((id) => !hide.has(id))
        .map((id) => [id, run.state.outputs[id]])
        .filter(([, o]) => o),
    ),
    shown,
    progress: { done: run.status === "done" ? def.steps.length : index, total: def.steps.length },
    canBack: run.state.history.length > 0 && CAN_GO_BACK.has(run.status),
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
