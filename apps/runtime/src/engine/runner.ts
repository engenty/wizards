import { AsyncLocalStorage } from "node:async_hooks";
import { advance } from "@engenty/wizards-engine/advance";
import { type FormContext, type InputError, readFormInput } from "@engenty/wizards-engine/input";
import { surfaceData } from "@engenty/wizards-engine/surface";
import {
  fillLabel,
  renderTemplate,
  resolveRef,
  scopeLists,
} from "@engenty/wizards-engine/template";
import type { AskResult, StepContext, StepServices } from "@engenty/wizards-engine/types";
import { StepError } from "@engenty/wizards-engine/types";
import {
  branchValues,
  type CardOption,
  cardsFromData,
  dataRef,
  type Format,
  type FormStep,
  formNeeds,
  isDecidedField,
  listRef,
  optionsFromData,
  type ReviewStep,
  RUN_DONE_SIGNAL,
  type Step,
  signalMissing,
  textLang,
  type WaitStep,
  type WizardDefinition,
  waitDurationMs,
  wizardLang,
} from "@engenty/wizards-shared/definition";
import { agentsMismatch, requiresOf, withRequires } from "@engenty/wizards-shared/requires";
import type {
  AskInput,
  RunHostRef,
  RunNote,
  RunStatus,
  Said,
  StepOutput,
} from "@engenty/wizards-shared/run";
import { note, type RunState, type RunView, saidText } from "@engenty/wizards-shared/run";
import {
  type RunReport,
  type RunReportAnswer,
  ServiceError,
} from "@engenty/wizards-shared/run-services";
import {
  formatsOf,
  needsNoRunner,
  rendersOnDemand,
  type ViewedRun,
  viewDefinition,
  viewNeeds,
  viewOf,
  whoOf,
} from "@engenty/wizards-shared/run-view";
import { CONVERSATION_RUNNERS, DEFAULT_RUNNER_SETTINGS } from "@engenty/wizards-shared/runners";
import type { StartEvent, StartedBy } from "@engenty/wizards-shared/starts";
import type { ListDef, ListRow } from "@engenty/wizards-shared/store";
import {
  type FlowEvent,
  type FlowHost,
  FlowRefused,
  type FlowResult,
  type FlowRun,
  transition,
} from "@engenty/wizards-shared/transition";
import { wizardAgentsUsed } from "@engenty/wizards-shared/wizard-code";
import type { WorkspaceFile } from "@engenty/wizards-shared/workspace";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { currentImpersonator } from "../auth/impersonation.js";
import { effectsOn } from "../broker/effect.js";
import { grantNote, grantOf, type KnownConnector, kindOf } from "../broker/index.js";
import { runHolder, subjectsOf } from "../broker/rwx.js";
import { tokenOf } from "../broker/token.js";
import { resolveConnector } from "../connectors/external.js";
import { connectionViews } from "../connectors/index.js";
import { addLocalCost, releaseRun, reserveForRun } from "../credits/credits.js";
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
} from "../models.js";
import { runEnded } from "../plugins/events.js";
import { pluginsOf as loadedPlugins } from "../plugins/registry.js";
import type { InProcessContext, SpaceRow } from "../run-services/in-process.js";
import { inProcessServices } from "../run-services/index.js";
import { stopJobs } from "../run-services/jobs.js";
import { ContentBlockedError, checkGuestText, guestChecksOn, guestRun } from "../safety.js";
import { sandboxDataHost } from "../sandbox/data.js";
import { peerTicket } from "../secrets/signing.js";
import { nameOf } from "../services/access.js";
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
  setLineHost,
  setWake,
  waitingRuns,
  wakeDue,
  wakeRun,
} from "../tenants/control.js";
import { currentTenant, currentTenantOrNull } from "../tenants/tenant.js";
import { hasOwnAccount } from "../upstreams.js";
import { askPerson, clearStaleAsk } from "./asks.js";
import { clearDeviceCalls } from "./device.js";
import { editedJson } from "./edits.js";
import { emitEvent, recentEvents, signalChanged } from "./events.js";
import { classifyFailure } from "./failures.js";
import { runtimeHost } from "./host.js";
import { handOver, hostFor, requireFit } from "./hosts.js";
import {
  type Actor,
  type NoticeKind,
  type NoticeValues,
  noticesFor,
  noticeWrites,
} from "./notices.js";
import { releaseRunResources } from "./owner.js";
import { pushRun } from "./push.js";
import {
  blockingMessage,
  closedChoices,
  missingClasses,
  missingModelsSaid,
  stepsWithoutModel,
  tierRefusalSaid,
} from "./requirements.js";
import { resourcesFor } from "./resources.js";
import { hostedRun, wakeElsewhere } from "./run-host-client.js";
import { type RunPatch, type RunValues, runStore } from "./run-store.js";
import { dropWait, runScope, SPACE_SCOPE, sendSignal } from "./signals.js";
import { startedRunEnded, startOf } from "./starts.js";
import { runTurns } from "./turns.js";
import type { RunRow } from "./types.js";
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

/** This time of a start began a run already: the database refused a second one. */
export class OccurrenceTaken extends Error {}

/** Another runner claimed the run while this one drove it: this drive ends, without a word on the run. */
export class LostClaim extends Error {}

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
  await runStore.claim(runId, generation);
}

export async function loadRun(runId: string): Promise<RunRow | undefined> {
  return runStore.get(runId);
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
  patch: RunPatch,
  by?: Actor,
): Promise<NoticeValues[]> {
  const kind = patch.status && TOLD[patch.status];
  if (!kind) {
    return [];
  }
  try {
    const run = await runStore.get(runId);
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
async function moveHeld(runId: string, patch: RunPatch) {
  if (!((patch.status || patch.cursor !== undefined) && (await durableRunsOn()))) {
    return;
  }
  try {
    const run = await runStore.get(runId);
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
 * Where the record stood when a host's copy of a run that works elsewhere came (`keepReport`): its
 * status and step, and the copy's revision, which the record's must be lower than.
 */
interface CopySeen {
  status: RunStatus;
  cursor: string | null;
  below: number;
}

/**
 * What a write of the run holds on besides the drive's claim: a person's write the `rev` it read, a
 * wait's write the status it came from, a host's copy the status the tenant read and a revision.
 */
type Seen = { rev: number } | { status: RunStatus } | { copy: CopySeen };

/**
 * A host's copy that stands where the record stood (the same status at the same step: the state
 * moved on within a step) changes the state alone and sets nothing off.
 */
const standsStill = (copy: CopySeen | null, status: RunStatus | undefined, cursor: unknown) =>
  copy !== null && copy.status === status && copy.cursor === cursor;

/**
 * Writes the run. Inside its drive the write needs the drive's claim; with `seen`, a person's write
 * needs the `rev` it read, and a wait's write the status it came from: a cancel wins over either. A
 * step may start or answer other runs: only its own run's claim counts.
 */
async function updateRun(runId: string, patch: RunPatch, seen?: Seen, by?: Actor) {
  const holder = driving.getStore();
  const held = holder?.runId === runId ? holder : undefined;
  const copy = seen && "copy" in seen ? seen.copy : null;
  // The notices go in with the status: all of it happens, or none.
  const notices = standsStill(copy, patch.status, patch.cursor)
    ? []
    : await noticesOfStatus(runId, patch, by);
  const changed = await runStore.move(
    runId,
    patch,
    {
      claim: held?.generation,
      ...(copy ? { status: copy.status, below: copy.below } : seen),
    },
    notices.length ? (where) => noticeWrites(notices, where) : undefined,
  );
  if (changed === 0) {
    if (held) {
      throw new LostClaim();
    }
    if (seen) {
      throw new RunConflict({ code: "runBusy" });
    }
  }
  await moveHeld(runId, patch);
  // A host's copy sets off only what a change of status sets off.
  if (patch.status && copy?.status !== patch.status) {
    await statusMoved(runId, copy?.status ?? null, patch.status);
  }
  signalChanged(runId);
}

const isOver = (status: RunStatus) =>
  status === "done" || status === "failed" || status === "cancelled";

/**
 * What a run's status change sets off at its tenant: credits held or given back, the end's signal,
 * plugins, the phone, the run's start, Manage's copy. A run this runtime drives and a host's copy
 * of one that works elsewhere both come here, after the write that changed the status. `from`: the
 * status that write held on, when it held on one (a host's copy): a run that was over already sets
 * off no end again. Null: the drive's or a person's write, as before other hosts.
 */
async function statusMoved(runId: string, from: RunStatus | null, to: RunStatus) {
  // A run that waits holds no credits: it reserves again when it wakes.
  if (to === "sleeping" || to === "waiting_signal") {
    await releaseRun(runId);
  }
  // A run that ended needs no credits held for it any more.
  if (isOver(to) && !(from && isOver(from))) {
    await releaseRun(runId);
    await dropWait(runId);
    await tellRunEnded(runId, to);
    // Plugins hear of it; the run does not wait for them.
    void runEnded(runId, to);
    if (to !== "cancelled") {
      void pushRun(runId, to);
    }
    // A start's run that ended: the start counts it, the owner hears of it.
    void startedRunEnded(runId, to);
  }
  reportRun(runId, to);
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
    const run = await runStore.pick(runId, "wizardId");
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
export function failureContext() {
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
  /** The client space it runs in, with its parent's wizard (docs/plans/client-portal.md). */
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
  /**
   * The host the caller drives the run on (`POST /api/v1/spaces/:id/runs`): it must fit the
   * wizard, no other is picked, nothing is handed over and no runner here drives it.
   */
  drivenOn?: RunHostRef;
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
  // A step every run passes through needs a model this runtime cannot serve: refuse before anything is held.
  const blocked = blockingMessage(await missingModelsSaid(input.definition));
  if (blocked) {
    throw new ModelUnavailableError(blocked);
  }
  // Where the run lives: the caller's host, another host that can run the wizard, else this
  // runtime (null).
  if (input.drivenOn) {
    await requireFit(input.definition, input.drivenOn.kind);
  }
  const host = input.drivenOn ?? (await hostFor(input.definition));
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
  // Without an account nobody can come back for a result later: it is kept a week. A run of a
  // client space is the client's, kept with it.
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
  const values: RunValues = {
    id,
    wizardId: input.wizardId,
    tenantId: currentTenant(),
    definition: input.definition,
    files: input.files,
    grant,
    // The run's token is signed from the run with this id whenever it is needed (broker/token.ts).
    tokenId: nanoid(24),
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
  };
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
  const inserted = await runStore.create(
    values,
    notices.length ? (where) => noticeWrites(notices, where) : undefined,
  );
  if (inserted === 0) {
    await releaseRun(id);
    throw new OccurrenceTaken();
  }
  if (host) {
    // Before anything else reads the run: its token names the host's kind.
    await runStore.setHost(id, host);
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
    // The caller's host keeps the run's time itself: the clock here never puts it in line.
    wakeAt: input.drivenOn ? null : deadline.wakeAt,
    host,
  });
  if (waits) {
    await waitsForAnswer(id, first, deadline.wakeAt);
  }
  reportRun(id, waits ? "waiting_input" : "running");
  if (input.drivenOn) {
    return id;
  }
  // A run its host took is driven there.
  if (host && (await placeRun(id, host))) {
    return id;
  }
  if (!waits) {
    kick(id);
  }
  return id;
}

/**
 * Hands a new run to the host `hostFor` picked: the token is signed from the record, which names
 * the host. A host that does not take it leaves the run here, before any step ran: it fits here
 * too, since this runtime runs every wizard.
 */
async function placeRun(id: string, host: RunHostRef): Promise<boolean> {
  const run = await runStore.get(id);
  const token = run && (await tokenOf(run));
  try {
    if (!run || !token) {
      throw new Error("The run has no token.");
    }
    await handOver(host, {
      runId: id,
      token,
      definition: run.definition,
      files: run.files,
      run: {
        cursor: run.cursor,
        status: run.status,
        state: run.state,
        wakeAt: run.wakeAt?.getTime() ?? null,
        rev: run.rev,
      },
    });
    return true;
  } catch (err) {
    console.warn(`[run ${id}] stays here: ${err instanceof Error ? err.message : String(err)}`);
    await runStore.setHost(id, null);
    await setLineHost(id, null);
    return false;
  }
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
          await updateRun(runId, { status: "failed", error: saidText(friendly(err), lang) });
        }).catch((e) => console.error(`[run ${runId}] marking it failed:`, e));
      }),
    )
    .finally(async () => {
      clearInterval(beat);
      // What fails here leaves the rest of the cleanup to run.
      await withTenant(tenant, () => releaseRunResources(runId)).catch((err) =>
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

/**
 * The clock: what came due goes in line, and the line need not wait for its next look. A run on
 * another host hears its wake from there.
 */
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
  await wakeElsewhere().catch((err) => console.warn("[clock]", (err as Error).message));
}

/** Stops the runs this process holds and hands them back to the line. */
export async function stopRunner() {
  stopping = true;
  for (const abort of active.values()) {
    // A stop, not a cancel: a durable turn stays where it is for the next runner.
    abort.abort("stop");
  }
  // The jobs too: whichever runner a run asks next starts them again.
  stopJobs();
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

/** The wizard's lists with the person's rows, by list id; a shared list's as its holder may read them. */
async function storedLists(
  run: RunRow,
): Promise<Record<string, { def: ListDef; rows: ListRow[] }>> {
  const scope = scopeOf(run);
  const who = subjectsOf({ holder: await runHolder(run), store: scope });
  const out: Record<string, { def: ListDef; rows: ListRow[] }> = {};
  for (const def of run.definition.lists ?? []) {
    out[def.id] = { def, rows: await listRows(scope, def, who) };
  }
  return out;
}

type OwnOfStep = Partial<Pick<StepContext, "stepId" | "emit" | "ask" | "share">>;

/**
 * What a step works with. A share job works with the same — the run's browser, store and
 * answers — under a step id, progress lines and questions of its own. `services`: the run's
 * services another process serves (the broker over HTTP, engine/host.ts); then this process makes
 * no resources for the run. Left out: this process's own.
 */
export async function makeContext(
  run: RunRow,
  space: SpaceRow,
  state: RunState,
  signal: AbortSignal,
  own: OwnOfStep = {},
  services?: StepServices,
): Promise<StepContext> {
  if (services) {
    const ctx: StepContext = { ...(await stepContext(run, space, state, signal, own)), services };
    ctx.scope.lists = await scopeLists(run.definition, services.data);
    return ctx;
  }
  const {
    store,
    space: _,
    spaceFiles,
    resources,
    call,
    chargeUsd,
    saveAsset,
    ...ctx
  } = await inProcessContext(run, space, state, signal, own);
  return ctx;
}

/** The step context but for its services: the run, its state, the person, the log. */
async function stepContext(
  run: RunRow,
  space: SpaceRow,
  state: RunState,
  signal: AbortSignal,
  own: OwnOfStep,
): Promise<Omit<StepContext, "services">> {
  const stepId = own.stepId ?? run.cursor ?? "";
  return {
    runId: run.id,
    tenantId: run.tenantId,
    test: run.mode === "test",
    stepId,
    holder: await runHolder(run),
    def: run.definition,
    lang: run.lang,
    files: run.files,
    state,
    scope: {
      def: run.definition,
      state,
      brand: spaceProfile(space),
    },
    dataSpace: await dataSpaceOf(run, space),
    signal,
    ask: own.ask ?? ((ask) => askOf(run, ask, stepId, signal)),
    emit:
      own.emit ?? ((type, message, asset) => emitEvent(run.id, run.cursor, type, message, asset)),
    ...(own.share ? { share: true } : {}),
    saveState: () => updateRun(run.id, { state }),
    turns: runTurns(run.id),
    durable: await effectsOn(),
  };
}

/**
 * The step context as the run's services keep it (run-services/in-process.ts): with the rows and
 * functions of this process. A share job's targets work with it.
 */
export async function inProcessContext(
  run: RunRow,
  space: SpaceRow,
  state: RunState,
  signal: AbortSignal,
  own: OwnOfStep = {},
): Promise<InProcessContext> {
  const store = scopeOf(run);
  const resources = resourcesFor(run.id);
  resources.bind(store, run, own.share, space.id, run.definition.data ? sandboxDataHost() : null);
  const base = await stepContext(run, space, state, signal, own);
  const { stepId } = base;
  const ctx: InProcessContext = {
    ...base,
    store,
    space,
    spaceFiles: await runSpaceFiles(space.id),
    resources,
    call: { runId: run.id, stepId },
    chargeUsd: (usd) => addLocalCost(run.id, stepId, usd),
    saveAsset: (input) =>
      saveAsset({
        ...input,
        runId: run.id,
        stepId: input.stepId ?? own.stepId ?? run.cursor,
      }),
    services: inProcessServices(run, () => ctx),
  };
  ctx.scope.lists = await scopeLists(run.definition, ctx.services.data);
  return ctx;
}

/**
 * The run's context at one of its steps, as the runner makes it when the run works on that step
 * (`runtimeHost`'s `context`): the run's services asked from outside (routes/run-services.ts)
 * answer with it. `stepId` null: the step the run is at.
 */
export async function contextAt(
  run: RunRow,
  stepId: string | null,
  signal: AbortSignal,
): Promise<InProcessContext> {
  const cursor = stepId ?? run.cursor;
  return inProcessContext({ ...run, cursor }, await loadSpace(run), run.state, signal);
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

export async function durableRunsOn() {
  return feature("durableRuns", await remoteFeatures().catch(() => null));
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
export async function holdAgain(run: RunRow): Promise<RunNote | null> {
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

// --- a person's step with a deadline -------------------------------------------
// It waits as a `wait` does: a row with `wake_at`, no process, no slot, no credits. An answer and the
// deadline each write on the `rev` they read, so one wins and the other finds the run moved on.

const isPersonStep = (step: Step | undefined): step is FormStep | ReviewStep =>
  step?.type === "form" || step?.type === "review";

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
  patch: RunPatch = {},
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

// --- the flow ------------------------------------------------------------------
// Where a run goes is `transition()`'s answer (packages/shared/src/transition.ts), for every move: a
// step done or failed, a decision, an answer, back, a wake, a signal, a retry. This file is its
// host: it loads and writes the row, runs the steps, holds credits, tells people and keeps the log.

/** The row as the flow reads it; `state`: a step's working copy instead of the row's. */
export function flowRun(
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
  patch?: RunPatch;
  /**
   * Stand the run at the wait, person's step or result the move arrives at. Otherwise the row says
   * `running` there and the runner stands it (`resume`), with what that step says and does
   * first: the log's lines, a start's answers, a page's picked fields.
   */
  stand?: boolean;
  /** Right after the row: what the step the move came from says in the log. */
  after?: () => Promise<void>;
}

/** Writes a person's move of the run, with what goes with it. True: the run is at work (`running`). */
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
  let said: Said | undefined;
  if (to.status === "failed") {
    said = result.error?.said ?? (await failSaid(undefined));
    if (!result.error) {
      await emitEvent(run.id, to.cursor, "error", said);
    }
  }
  // The control copy first: a crash after it gives a wake that finds the run as it was.
  if (to.wakeAt !== null) {
    await setWake(run.id, new Date(to.wakeAt));
  }
  await writeMove(run, to, { seen: o.seen, by: o.by, patch: o.patch, said });
  await o.after?.();
  // A wait passed on the way (a date gone by) is one line in, one line out.
  for (const wait of def.steps) {
    if (wait.type === "wait" && passed(before, to.state, wait.id)) {
      await emitEvent(run.id, wait.id, "step_started", wait.title);
      await emitEvent(run.id, wait.id, "step_done", wait.title);
    }
  }
  if (stands && to.status === "waiting_input" && to.wakeAt !== null && isPersonStep(step)) {
    if (await waitsLong(step)) {
      await emitEvent(
        run.id,
        step.id,
        "wait",
        note("runWaitsAnswerUntil", { until: { at: new Date(to.wakeAt).toISOString() } }),
      );
    }
  }
  return to.status === "running";
}

/**
 * The row of a move, with what goes with it on the row: the error's words, how long the run is
 * kept, a person's deadline, the label, the result's data. `said`: why the run failed. A person's
 * step that may wait long gives its hold back.
 */
export async function writeMove(
  run: RunRow,
  to: FlowRun,
  o: {
    seen?: Seen;
    by?: Actor;
    patch?: RunPatch;
    err?: unknown;
    said?: Said;
  } = {},
): Promise<void> {
  const def = run.definition;
  const step = stepOf(def, to.cursor);
  // What the content rules stopped is kept on the run, whichever way it goes: Manage hears of it
  // with the failed turn.
  if (o.err instanceof ContentBlockedError) {
    to.state.blocked = o.err.kind;
  }
  const error =
    to.status === "failed"
      ? saidText(o.said ?? (await failSaid(o.err)), textLang(wizardLang(def)))
      : null;
  const wakeAt = to.wakeAt === null ? null : new Date(to.wakeAt);
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
  // The wait is on the row: its hold goes back, once.
  const copy = o.seen && "copy" in o.seen ? o.seen.copy : null;
  if (
    to.status === "waiting_input" &&
    !standsStill(copy, to.status, to.cursor) &&
    isPersonStep(step) &&
    (await waitsLong(step))
  ) {
    await releaseRun(run.id);
  }
}

/** How often a host's copy is tried again when another copy changed the record in between. */
const REPORT_TRIES = 3;

/**
 * A host's copy of a run that works elsewhere (docs/plans/runs-on-their-own.md, D7): the host
 * posts its state as each step starts (the services build a step's context from the record), at
 * each person's step and at the end, and the record takes it as the runner's own move is written
 * (`writeMove`): the notices with it, the label, a person's deadline, the result's data, the
 * error's words, and then what the status change sets off (`statusMoved`). A copy at the status
 * and step the record has already writes the state alone. The record keeps the host's revision. A
 * copy no newer than the record changes nothing, nor does one for a run that is over, so the end
 * sets everything off once. The run's cost is not taken
 * from the copy: the services booked each call. `no_run`: no such run; `here`: this runtime
 * drives the run itself.
 */
export async function keepReport(
  runId: string,
  report: RunReport,
): Promise<RunReportAnswer | "no_run" | "here"> {
  for (let tries = 1; ; tries++) {
    const run = await loadRun(runId);
    if (!run) {
      return "no_run";
    }
    if (!run.host) {
      return "here";
    }
    if (isOver(run.status) || run.rev >= report.rev) {
      return { kept: false, status: run.status, rev: run.rev };
    }
    const to: FlowRun = {
      cursor: report.cursor,
      status: report.status,
      state: report.state,
      wakeAt: report.wakeAt,
    };
    try {
      await writeMove(run, to, {
        seen: { copy: { status: run.status, cursor: run.cursor, below: report.rev } },
        patch: { rev: report.rev },
        ...(report.error ? { said: report.error } : {}),
      });
      return { kept: true, status: report.status, rev: report.rev };
    } catch (err) {
      // Another copy came in between: the record is read again, and this one may be the older.
      if (!(err instanceof RunConflict) || tries >= REPORT_TRIES) {
        throw err;
      }
    }
  }
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
export const lookAgainMs = () => (managed ? 5 : 30) * 60_000;

/** What a failed step says: its own note, a tier's refusal, or the error in plain words. */
export async function failSaid(err: unknown): Promise<Said> {
  if (err instanceof ServiceError && err.said !== undefined) {
    // Said where the service met it, as it would have been in the step: a job that failed, a
    // call of the run's services over HTTP (routes/run-services.ts).
    return err.said;
  }
  return noteOf(err) ?? (await tierRefusalSaid(err)) ?? friendly(err);
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
  const run = await runStore.pick(runId, "status", "cursor", "driving");
  // A wake of a person's step may well change nothing: the run only works once its time is up.
  if (run?.status === "waiting_input") {
    return false;
  }
  const interrupted = run?.status === "running" && run.driving;
  if (interrupted) {
    await emitEvent(runId, run.cursor, "resumed", note("runResumed"));
  }
  const holder = driving.getStore();
  await runStore.markDriving(runId, holder?.runId === runId ? holder.generation : undefined);
  return interrupted;
}

/** What a drive tells the engine about the run as it finds it; null: nothing for it to do. */
function eventOf(run: RunRow): FlowEvent | null {
  if (run.status === "sleeping" || run.status === "waiting_signal") {
    return { kind: "woke" };
  }
  // A wake of a person's step may well change nothing: the run only goes on once its time is up.
  if (run.status === "waiting_input" && run.wakeAt) {
    return { kind: "woke" };
  }
  return run.status === "running" ? { kind: "resume" } : null;
}

/** Takes the run to its next wait or its end: the engine on this runtime as its host. */
async function drive(runId: string, signal: AbortSignal) {
  // The step starts afresh here: a question or a device call another process left has no one
  // waiting.
  await clearStaleAsk(runId);
  await clearDeviceCalls(runId);
  let interrupted = await startDriving(runId);
  while (!signal.aborted) {
    const run = await loadRun(runId);
    const event = run ? eventOf(run) : null;
    if (!(run && event)) {
      return;
    }
    const host = await runtimeHost(run, signal, interrupted);
    try {
      await advance(host, event);
      return;
    } catch (err) {
      // Not another runner: the run moved under this write. An answer, a stop, or a translation
      // landing, in which case a time may still be up. The next look decides, so no wake is lost.
      if (!(err instanceof LostClaim)) {
        throw err;
      }
      if ((await loadRun(runId))?.claim !== driving.getStore()?.generation) {
        throw err;
      }
      interrupted = host.interrupted;
      await startDriving(runId);
    }
  }
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
  await runStore.keepUnsent(run.id, stepId, values);
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
  return runStore.writeState(run.id, run.rev, state);
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
  await updateRun(runId, { status: "cancelled", wakeAt: null });
  // After the row: a crash in between gives a wake that finds the run over, never a lost cancel.
  await setWake(runId, null);
}

/** A write that only holds on the run as it was read; a run that moved on meanwhile refuses. */
async function whileItWaits(run: RunRow, patch: RunPatch) {
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
  const output = run.state.outputs[step.id];
  return formatsOf(step, output, wanted, rendersOnDemand(step, output) && (await hasFfmpeg()));
}

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

/** What a page's `prefill` refs read from the run; empty values are left out. */
function prefilled(step: FormStep, run: RunRow): Record<string, unknown> {
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

/** The run as `viewOf` and `reportOf` read it. */
export function viewedRun(run: RunRow): ViewedRun {
  return {
    ...run,
    wakeAt: run.wakeAt?.toISOString() ?? null,
    expiresAt: run.expiresAt?.toISOString() ?? null,
  };
}

/**
 * The run as the viewer sees it (`viewOf`), with what it reads from this runtime. `hide`: steps
 * whose output stays in the space (broker/kept.ts); empty for a member, or a member's run.
 */
export async function runView(
  run: RunRow,
  brand: RunView["brand"],
  hide: ReadonlySet<string> = new Set(),
): Promise<RunView> {
  const viewed = viewedRun(run);
  const needs = viewNeeds(run.definition, viewed);
  const translation = run.lang ? await storedTranslation(run.wizardId, run.lang) : null;
  const def = viewDefinition(run.definition, translation)?.def ?? run.definition;
  const step = stepOf(def, run.cursor);
  const page = step?.type === "form" ? step : null;
  return viewOf(run.definition, viewed, {
    brand,
    hide,
    translation,
    missing: needs.missing ? [...(await missingClasses())] : [],
    lists: needs.lists ? await storedLists(run) : {},
    ffmpeg: needs.ffmpeg && (await hasFfmpeg()),
    page: page ? await formContext(run, page) : null,
    prefill: page ? prefilled(page, run) : {},
    ...(page?.data ? { pageData: await formDataOf(page.data, run, def, brand.name, hide) } : {}),
    waitKey: step?.type === "wait" && run.status === "waiting_signal" ? waitKeyText(run, step) : "",
    talk: needs.talk && (await talkAllowed(run)),
    events: await recentEvents(run.id, 0, 30),
    connections: needs.connections
      ? await connectionViews(
          def.connections ?? [],
          scopeOf(run),
          await spaceIdOf(run),
          textLang(wizardLang(def)),
        )
      : [],
    secrets: needs.secrets && (await listSecrets(scopeOf(run))).length > 0,
    publicUrl: env.publicUrl,
    shareJob: needs.shareJob ? await latestShareJob(run.id) : null,
  });
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
  const record = await loadRun(runId);
  // Where the run stands is its host's; the signal is kept here, and its host hears of it.
  const run = record && (await hostedRun(record));
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
