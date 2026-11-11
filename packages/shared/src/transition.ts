// SPDX-License-Identifier: FSL-1.1-MIT OR MIT
/**
 * A run's flow as one pure function. In: where the run stands (`FlowRun`) and what happened
 * (`FlowEvent`). Out: where it stands now, and the one thing its host does next (`FlowCommand`).
 *
 * The cursor moves; nothing is replayed. The function keeps nothing: its host stores the run it
 * returns, wakes it at `wakeAt`, matches signals to it, runs its automatic steps and calls models,
 * and comes back with the next event. Its rules are the engine's (apps/runtime/src/engine/runner.ts)
 * as of the durable runs: waits, signals, timeouts, retries, `onFail`, back and regenerate.
 *
 * Left to the host: what a page accepts (`readFormInput`), the fields a decision picks for a page,
 * a start's `passStep`, credit holds, a durable AI step's turn, what happens once (`run_effect`),
 * who may answer, telling people, the label and the log.
 *
 * The runtime is such a host (apps/runtime/src/engine/runner.ts): every move of a run goes through
 * here. It writes a move at once and stands the run at a wait or a person's step in its drive loop,
 * with `resume`, where the log says so and that step's own work comes first.
 */
import {
  branchValues,
  type FormStep,
  followRules,
  loopKey,
  otherwiseOf,
  type ReviewStep,
  type Step,
  type WaitStep,
  type Who,
  type WizardDefinition,
  waitDurationMs,
} from "./definition.js";
import {
  CAN_GO_BACK,
  note,
  RUN_ENDED,
  type RunNote,
  type RunPause,
  type RunState,
  type RunStatus,
  type StepOutput,
} from "./run.js";

/** What the host keeps of a run. */
export interface FlowRun {
  cursor: string | null;
  status: RunStatus;
  state: RunState;
  /** When the clock wakes the run, in ms; null: nothing due. */
  wakeAt: number | null;
}

/** Why a step failed, as the host sorted its error (runtime: engine/failures.ts). */
export type FlowFailure =
  /** A provider's 429, 5xx, timeout or network: worth another try. */
  | { class: "retry"; retryAfterMs: number | null }
  /** Out of credits: the run waits for a top-up. */
  | { class: "credits" }
  /** A sign-in ran out: the run waits for the person to sign in again. */
  | { class: "sign_in"; service: string }
  /** Anything else. */
  | { class: "final" };

/** What happened to the run. */
export type FlowEvent =
  | { kind: "start" }
  /** The host ran the step the last command named. */
  | { kind: "stepDone"; stepId: string; output: StepOutput }
  /** It failed. `acted`: it may have done something out there, so it is not started again by itself. */
  | { kind: "stepFailed"; stepId: string; failure: FlowFailure; acted?: boolean }
  /** A model picked one of the step's `ask` rules, by its index in `next`; null: none of them. */
  | { kind: "decided"; stepId: string; rule: number | null }
  /** A person answered a page: its values as `readFormInput` accepted them. */
  | { kind: "answered"; stepId: string; values: Record<string, unknown> }
  /**
   * A person accepted a review, or declined one with `approve`. `note`: why, on an approval.
   * `edited`: the outputs as the person changed them (the review's `edit`), applied as given.
   */
  | {
      kind: "reviewed";
      stepId: string;
      approved: boolean;
      note?: string;
      edited?: Record<string, StepOutput>;
    }
  /** A review sends one of the outputs it shows back to be made again, with a note. */
  | { kind: "regenerate"; stepId: string; target: string; note: string; items?: number[] }
  | { kind: "back" }
  /** A signal the run's wait matches. `id`: its delivery, taken once. */
  | { kind: "signal"; stepId: string; id: string; data: Record<string, unknown> | null }
  /** The clock: `wakeAt` came, or someone pressed "Continue now". */
  | { kind: "woke" }
  /**
   * Stand the run at its cursor again: a person's "try again" on a failed run, or a host that moved
   * the run and comes back to stand it at that step (its drive loop, after a crash on the way in).
   */
  | { kind: "resume" }
  | { kind: "cancel" };

/** The one thing the host does next. */
export type FlowCommand =
  /** Run an automatic step (agent, generate, widget, surface, motion graphics). */
  | { kind: "run"; step: Step }
  /** Ask a model which of these `ask` rules holds, then send `decided`. */
  | { kind: "decide"; stepId: string; rules: number[] }
  /** Show the step to `who`, remind at `remindAt`, then wait for `answered` or `reviewed`. */
  | { kind: "ask"; step: FormStep | ReviewStep; who: Who; remindAt: number | null }
  /** Nothing runs until `wakeAt`. `tell`: the run waits for a person, who hears of it now. */
  | { kind: "sleep"; tell?: Exclude<RunPause, { kind: "retry" }> }
  /** Watch for this signal; one stored since the run began counts, so look for it first. */
  | { kind: "waitSignal"; name: string; key: string }
  /** The run is done or cancelled. */
  | { kind: "end" }
  /** The run failed at this step. */
  | { kind: "fail"; stepId: string | null }
  /** Nothing changed: a wake that came early, a signal taken already. */
  | { kind: "stay" };

export interface FlowResult {
  run: FlowRun;
  command: FlowCommand;
  /**
   * A step the flow itself could not enter (an `until` that is no date, a signal key that came out
   * empty), and why: it failed as a step fails, so the run took its `onFail` or failed.
   */
  error?: { stepId: string; said: RunNote };
}

/** What the function needs from its host, all of it known before the call. */
export interface FlowHost {
  now: number;
  /** A template such as "{{steps.send.thread_id}}", filled from the state. */
  render(text: string, state: RunState): string;
  /** Rows per stored list, for rules that read `lists.<list>.count`. */
  listCounts?: Record<string, number>;
  /**
   * Durable runs on: deadlines on a person's step, retries and `onFail`. Off: a person's step
   * waits with no deadline and a failed step fails the run. Default on.
   */
  durable?: boolean;
  /** How often a run that waits for a person looks whether they acted. Default 5 minutes. */
  lookAgainMs?: number;
}

/** An event the run can't take as it stands. */
export class FlowRefused extends Error {
  constructor(
    readonly code: "runBusy" | "noStepBefore" | "notThisStep" | "notAnApproval" | "unknownTarget",
  ) {
    super(code);
    this.name = "FlowRefused";
  }
}

export const FLOW_LIMITS = {
  /** Minutes before each new try of a step that failed for a passing reason. */
  retryMinutes: [1, 5, 30],
  /** The longest `Retry-After` a run sleeps for. */
  retryAfterMaxMs: 6 * 3600_000,
  /** How long a run waits for a person to top up or sign in before it fails. */
  personWaitMaxMs: 30 * 86_400_000,
  /** How often a step's `onFail` is taken. */
  onFailMax: 3,
  /** How long a run waits before it tries a step again under the step's `retries`. */
  failureRetryMs: 10_000,
  lookAgainMs: 5 * 60_000,
} as const;

export function transition(
  def: WizardDefinition,
  run: FlowRun,
  event: FlowEvent,
  host: FlowHost,
): FlowResult {
  const state = structuredClone(run.state);
  const at = new Date(host.now).toISOString();

  switch (event.kind) {
    case "start":
      return enter(def, state, def.steps[0]?.id ?? null, host);

    case "stepDone":
      expect(run, "running", event.stepId);
      state.outputs[event.stepId] = event.output;
      // A note and a redo asked for this result are answered by it; its visit and turn are over.
      delete state.notes[event.stepId];
      delete state.redo?.[event.stepId];
      delete state.visiting;
      delete state.retries;
      delete state.turn;
      return go(def, state, event.stepId, host);

    case "stepFailed":
      expect(run, "running", event.stepId);
      return failed(def, state, event, host);

    case "decided": {
      if (run.status !== "running" || state.deciding !== event.stepId) {
        throw new FlowRefused("notThisStep");
      }
      delete state.deciding;
      delete state.retries;
      const rule = event.rule === null ? undefined : stepOf(def, event.stepId)?.next?.[event.rule];
      if (!rule?.goto) {
        const otherwise = otherwiseOf(def, event.stepId, state.loops);
        return taken(def, state, event.stepId, otherwise.rule, otherwise.cursor, host);
      }
      return taken(
        def,
        state,
        event.stepId,
        event.rule,
        rule.goto === "end" ? null : rule.goto,
        host,
      );
    }

    case "answered": {
      expect(run, "waiting_input", event.stepId);
      const step = stepOf(def, event.stepId);
      if (step?.type !== "form") {
        throw new FlowRefused("notThisStep");
      }
      state.values = { ...state.values, ...event.values };
      // Fields left empty on a revisited page are cleared, not kept from before.
      for (const field of step.fields) {
        if (!(field.id in event.values)) {
          delete state.values[field.id];
        }
      }
      forgetLaterPages(def, state, step);
      handOn(step, state, at);
      state.history.push(step.id);
      return go(def, state, step.id, host);
    }

    case "reviewed": {
      expect(run, "waiting_input", event.stepId);
      const step = stepOf(def, event.stepId);
      if (step?.type !== "review") {
        throw new FlowRefused("notThisStep");
      }
      if (!event.approved && !step.approve) {
        throw new FlowRefused("notAnApproval");
      }
      for (const [target, output] of Object.entries(event.edited ?? {})) {
        if (step.edit && step.show.includes(target) && state.outputs[target]) {
          state.outputs[target] = output;
        }
      }
      const words = event.note?.trim().slice(0, 2000) || undefined;
      handOn(
        step,
        state,
        at,
        step.approve ? { approved: event.approved, ...(words ? { note: words } : {}) } : undefined,
      );
      state.history.push(step.id);
      return go(def, state, step.id, host);
    }

    case "regenerate": {
      expect(run, "waiting_input", event.stepId);
      const step = stepOf(def, event.stepId);
      if (step?.type !== "review") {
        throw new FlowRefused("notThisStep");
      }
      if (!step.show.includes(event.target)) {
        throw new FlowRefused("unknownTarget");
      }
      state.notes[event.target] = event.note.slice(0, 2000) || "Please make a new variant.";
      if (event.items?.length) {
        state.redo = { ...state.redo, [event.target]: event.items };
      } else {
        delete state.redo?.[event.target];
      }
      return enter(def, state, event.target, host);
    }

    case "back": {
      if (!CAN_GO_BACK.has(run.status)) {
        throw new FlowRefused("runBusy");
      }
      const previous = state.history.pop();
      if (!previous) {
        throw new FlowRefused("noStepBefore");
      }
      // What belongs to the step left behind goes with it.
      delete state.deciding;
      delete state.visiting;
      delete state.retries;
      delete state.pause;
      delete state.turn;
      delete state.answeredBy?.[previous];
      delete state.lastBy;
      return enter(def, state, previous, host);
    }

    case "signal": {
      expect(run, "waiting_signal", event.stepId);
      const step = stepOf(def, event.stepId);
      if (step?.type !== "wait" || !step.signal) {
        throw new FlowRefused("notThisStep");
      }
      if (state.signals?.includes(event.id)) {
        return { run, command: { kind: "stay" } };
      }
      state.signals = [...(state.signals ?? []), event.id];
      state.outputs[step.id] = {
        json: { came: true, timedOut: false, data: signalData(step, event.data) },
        at,
      };
      return go(def, state, step.id, host);
    }

    case "woke":
      return woke(def, run, state, host, at);

    case "resume":
      if (run.status === "failed") {
        // Every try anew; a turn that failed has dropped its snapshot.
        delete state.retries;
        delete state.pause;
        delete state.turn;
      } else if (run.status !== "running") {
        throw new FlowRefused("runBusy");
      }
      return standAt(def, state, run.cursor, host);

    case "cancel":
      // A run that is over stays as it ended.
      if (RUN_ENDED.has(run.status)) {
        throw new FlowRefused("runBusy");
      }
      return settle(run.cursor, "cancelled", state, null, { kind: "end" });
  }
}

/** The data a signal hands on: what its wait's `fields` name, or all of it. */
export function signalData(
  step: WaitStep,
  data: Record<string, unknown> | null,
): Record<string, unknown> {
  const fields = step.signal?.fields;
  if (!(fields && data)) {
    return data ?? {};
  }
  return Object.fromEntries(fields.map((id) => [id, data[id]]));
}

/** The clock woke the run. The row decides, not the wake: one that comes early changes nothing. */
function woke(
  def: WizardDefinition,
  run: FlowRun,
  state: RunState,
  host: FlowHost,
  at: string,
): FlowResult {
  const stay: FlowResult = { run, command: { kind: "stay" } };
  const step = stepOf(def, run.cursor);
  if (run.status === "sleeping" || run.status === "waiting_signal") {
    if (state.pause) {
      // A retry, or a wait for credits or a sign-in: the same step again.
      if (run.wakeAt !== null && run.wakeAt > host.now) {
        return stay;
      }
      delete state.pause;
      return standAt(def, state, run.cursor, host);
    }
    if (step?.type !== "wait") {
      return enter(def, state, run.cursor, host);
    }
    const due = run.wakeAt !== null ? run.wakeAt <= host.now : !step.signal;
    if (!due) {
      return stay;
    }
    state.outputs[step.id] = {
      json: step.signal ? { came: false, timedOut: true } : { waited: true },
      at,
    };
    return go(def, state, step.id, host);
  }
  if (run.status === "waiting_input" && run.wakeAt !== null && isPersonStep(step)) {
    if (run.wakeAt > host.now) {
      return stay;
    }
    // Its time is up: nobody's answer is invented. The fields stay empty, no approval is given.
    if (step.type === "form") {
      for (const field of step.fields) {
        delete state.values[field.id];
      }
      forgetLaterPages(def, state, step);
    }
    state.outputs[step.id] = {
      json: {
        timedOut: true,
        ...(step.type === "review" && step.approve ? { approved: false } : {}),
      },
      at,
    };
    state.history.push(step.id);
    return go(def, state, step.id, host);
  }
  return stay;
}

/** A step failed: a new try, a wait for a person, its `onFail`, or the end of the run. */
function failed(
  def: WizardDefinition,
  state: RunState,
  event: Extract<FlowEvent, { kind: "stepFailed" }>,
  host: FlowHost,
): FlowResult {
  const { stepId, failure } = event;
  if (host.durable === false) {
    return settle(stepId, "failed", state, null, { kind: "fail", stepId });
  }
  // A step that may have acted is not started again by itself: the mail would go out twice. A
  // refused sign-in did nothing.
  if (!event.acted || failure.class === "sign_in") {
    const retries =
      state.retries?.step === stepId
        ? state.retries
        : { step: stepId, count: 0, since: new Date(host.now).toISOString() };
    if (failure.class === "credits" || failure.class === "sign_in") {
      const pause: Exclude<RunPause, { kind: "retry" }> =
        failure.class === "credits"
          ? { kind: "credits" }
          : { kind: "sign_in", service: failure.service };
      if (host.now - Date.parse(retries.since) > FLOW_LIMITS.personWaitMaxMs) {
        delete state.pause;
        delete state.retries;
        return settle(stepId, "failed", state, null, { kind: "fail", stepId });
      }
      const told = retries.told === pause.kind;
      state.retries = { ...retries, told: pause.kind };
      state.pause = pause;
      const wakeAt = host.now + (host.lookAgainMs ?? FLOW_LIMITS.lookAgainMs);
      return settle(stepId, "sleeping", state, wakeAt, {
        kind: "sleep",
        ...(told ? {} : { tell: pause }),
      });
    }
    if (failure.class === "retry" && retries.count < FLOW_LIMITS.retryMinutes.length) {
      const delay =
        failure.retryAfterMs === null
          ? FLOW_LIMITS.retryMinutes[retries.count] * 60_000
          : Math.min(Math.max(failure.retryAfterMs, 60_000), FLOW_LIMITS.retryAfterMaxMs);
      state.retries = { ...retries, count: retries.count + 1 };
      state.pause = { kind: "retry" };
      return settle(stepId, "sleeping", state, host.now + delay, { kind: "sleep" });
    }
    // The step's own failure: tried again as often as its `retries` says, before `onFail`.
    const step = stepOf(def, stepId);
    const allowed = step && "retries" in step ? (step.retries ?? 0) : 0;
    if (failure.class === "final" && (retries.failures ?? 0) < allowed) {
      state.retries = { ...retries, failures: (retries.failures ?? 0) + 1 };
      state.pause = { kind: "retry" };
      return settle(stepId, "sleeping", state, host.now + FLOW_LIMITS.failureRetryMs, {
        kind: "sleep",
      });
    }
  }
  // Past every try: where the step's `onFail` says, at most `onFailMax` times.
  const target = stepOf(def, stepOf(def, stepId)?.onFail ?? null);
  const key = target ? loopKey(stepId, target.id) : "";
  if (!target || (state.loops?.[key] ?? 0) >= FLOW_LIMITS.onFailMax) {
    return settle(stepId, "failed", state, null, { kind: "fail", stepId });
  }
  state.loops = { ...state.loops, [key]: (state.loops?.[key] ?? 0) + 1 };
  delete state.retries;
  delete state.deciding;
  delete state.visiting;
  delete state.turn;
  return enter(def, state, target.id, host);
}

/** The run stands at `stepId` again: where a decision over its rules was open, that first. */
function standAt(
  def: WizardDefinition,
  state: RunState,
  stepId: string | null,
  host: FlowHost,
): FlowResult {
  return stepId !== null && state.deciding === stepId
    ? go(def, state, stepId, host)
    : enter(def, state, stepId, host);
}

/** Leaves `fromId` by its `next` rules: to a step, to the end, or to a decision first. */
function go(def: WizardDefinition, state: RunState, fromId: string, host: FlowHost): FlowResult {
  const values = branchValues(state.values, state.outputs, host.listCounts);
  const outcome = followRules(def, fromId, values, state.loops);
  if (outcome.kind === "decide") {
    state.deciding = fromId;
    return settle(fromId, "running", state, null, {
      kind: "decide",
      stepId: fromId,
      rules: outcome.rules,
    });
  }
  return taken(def, state, fromId, outcome.rule, outcome.cursor, host);
}

/** A rule was taken: it counts toward its loop's limit, and the run arrives where it leads. */
function taken(
  def: WizardDefinition,
  state: RunState,
  fromId: string,
  rule: number | null,
  cursor: string | null,
  host: FlowHost,
): FlowResult {
  const goto = rule === null ? undefined : stepOf(def, fromId)?.next?.[rule]?.goto;
  if (goto) {
    const key = loopKey(fromId, goto);
    state.loops = { ...state.loops, [key]: (state.loops?.[key] ?? 0) + 1 };
  }
  return enter(def, state, cursor, host);
}

/** The run arrives at `stepId`: how it stands there, and what the host does. */
function enter(
  def: WizardDefinition,
  state: RunState,
  stepId: string | null,
  host: FlowHost,
): FlowResult {
  const step = stepOf(def, stepId);
  if (!step) {
    return settle(null, "done", state, null, { kind: "end" });
  }
  switch (step.type) {
    case "result":
      return settle(step.id, "done", state, null, { kind: "end" });

    case "wait":
      return step.signal
        ? enterSignalWait(def, step, state, host)
        : enterTimeWait(def, step, state, host);

    case "form":
    case "review": {
      const deadlines = host.durable !== false;
      const wakeAt = deadlines && step.timeout ? host.now + waitDurationMs(step.timeout) : null;
      const remindAt = deadlines && step.remind ? host.now + waitDurationMs(step.remind) : null;
      return settle(step.id, "waiting_input", state, wakeAt, {
        kind: "ask",
        step,
        who: step.who ?? "person",
        remindAt,
      });
    }

    default:
      return settle(step.id, "running", state, null, { kind: "run", step });
  }
}

function enterSignalWait(
  def: WizardDefinition,
  step: WaitStep,
  state: RunState,
  host: FlowHost,
): FlowResult {
  const signal = step.signal as NonNullable<WaitStep["signal"]>;
  const key = host.render(signal.key, state).trim();
  if (!key) {
    return cannotEnter(def, step, state, host, note("signalKeyEmpty", { key: signal.key }));
  }
  const wakeAt = signal.timeout ? host.now + waitDurationMs(signal.timeout) : null;
  return settle(step.id, "waiting_signal", state, wakeAt, {
    kind: "waitSignal",
    name: signal.name,
    key,
  });
}

function enterTimeWait(
  def: WizardDefinition,
  step: WaitStep,
  state: RunState,
  host: FlowHost,
): FlowResult {
  let wakeAt = host.now + waitDurationMs(step.for ?? "1m");
  if (step.until) {
    const said = host.render(step.until, state).trim();
    wakeAt = new Date(said).getTime();
    if (Number.isNaN(wakeAt)) {
      return cannotEnter(def, step, state, host, note("waitDateUnreadable", { date: said }));
    }
  }
  if (wakeAt <= host.now) {
    // A time gone by waits for nothing.
    state.outputs[step.id] = { json: { waited: true }, at: new Date(host.now).toISOString() };
    return go(def, state, step.id, host);
  }
  return settle(step.id, "sleeping", state, wakeAt, { kind: "sleep" });
}

/** The flow can't enter `step`: it fails as a step fails, for good, and says why. */
function cannotEnter(
  def: WizardDefinition,
  step: Step,
  state: RunState,
  host: FlowHost,
  said: RunNote,
): FlowResult {
  const result = failed(
    def,
    state,
    { kind: "stepFailed", stepId: step.id, failure: { class: "final" } },
    host,
  );
  return { ...result, error: { stepId: step.id, said } };
}

/** What a person's answer hands on, for `next` to read. */
function handOn(
  step: FormStep | ReviewStep,
  state: RunState,
  at: string,
  decision?: { approved: boolean; note?: string },
) {
  if (step.timeout || decision) {
    state.outputs[step.id] = {
      json: { ...(step.timeout ? { timedOut: false } : {}), ...decision },
      at,
    };
  }
}

/** Later pages decide their fields again on what is answered now. */
function forgetLaterPages(def: WizardDefinition, state: RunState, step: Step) {
  for (const later of def.steps.slice(def.steps.indexOf(step) + 1)) {
    delete state.pages?.[later.id];
  }
}

function settle(
  cursor: string | null,
  status: RunStatus,
  state: RunState,
  wakeAt: number | null,
  command: FlowCommand,
): FlowResult {
  return { run: { cursor, status, state, wakeAt }, command };
}

function stepOf(def: WizardDefinition, id: string | null): Step | undefined {
  return id === null ? undefined : def.steps.find((s) => s.id === id);
}

function isPersonStep(step: Step | undefined): step is FormStep | ReviewStep {
  return step?.type === "form" || step?.type === "review";
}

function expect(run: FlowRun, status: RunStatus, stepId: string) {
  if (run.status !== status) {
    throw new FlowRefused("runBusy");
  }
  if (run.cursor !== stepId) {
    throw new FlowRefused("notThisStep");
  }
}
