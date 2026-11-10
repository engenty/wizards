/**
 * Takes a run from an event to its next wait or its end, on any host: `transition()` says where
 * the run goes and what happens next, `advance` does that (runs the step, asks the model, stands
 * at the person's step, sleeps, watches for the signal), feeds the next event, and writes every
 * move through its host's store. What only the host can do is a `RunHost` call.
 */
import {
  type FormStep,
  isDecidedField,
  type ReviewStep,
  type Step,
  textLang,
  type WaitStep,
  wizardLang,
} from "@engenty/wizards-shared/definition";
import {
  note,
  type RunPause,
  type RunState,
  type Said,
  saidText,
} from "@engenty/wizards-shared/run";
import { isPending, type Pending } from "@engenty/wizards-shared/run-services";
import { whoOf } from "@engenty/wizards-shared/run-view";
import {
  type FlowCommand,
  type FlowEvent,
  type FlowResult,
  type FlowRun,
  transition,
} from "@engenty/wizards-shared/transition";
import { decideBranch, decideFields, formContextOf, listCounts } from "./decisions.js";
import type { Move, RunHost, RunStart } from "./host.js";
import { readFormInput } from "./input.js";
import { runAutomaticStep } from "./steps/index.js";
import { turnOf } from "./steps/turn.js";
import { renderTemplate } from "./template.js";

/** Takes the run from `event` to its next wait or its end. The last move the flow made. */
export function advance(host: RunHost, event: FlowEvent): Promise<FlowResult> {
  return new Advance(host).go(event);
}

class Advance {
  /** The run as the engine left it; ahead of `stored` between a move and its write. */
  private run!: FlowRun;
  /** The run as the store has it. */
  private stored!: FlowRun;
  private rev = 0;
  private event: FlowEvent = { kind: "resume" };
  /** Why the step failed, for the move its failure makes. */
  private failing: { said: Said; err?: unknown } | null = null;
  /** The step whose work is done: its line comes after its move. */
  private finished: Step | null = null;
  /** The run registered a wait for a signal. */
  private watching = false;
  /** The next move stands the run where it arrives: a signal that came before its wait. */
  private standNext = false;

  constructor(private readonly host: RunHost) {}

  async go(first: FlowEvent): Promise<FlowResult> {
    this.load(await this.host.store.load());
    let event: FlowEvent | null = await this.fromClock(first);
    let result: FlowResult = { run: this.run, command: { kind: "stay" } };
    while (event && !this.host.signal.aborted) {
      this.event = event;
      if (event.kind === "resume" && this.run.status === "running") {
        const work = await this.atWork();
        if (work !== "flow") {
          event = work;
          continue;
        }
      }
      const from = this.run;
      result = await this.move(event, from);
      event = await this.carry(event, result, from);
    }
    return result;
  }

  /**
   * The run is at work where it stands: that step's own work comes first, with no move. A decision
   * over its rules, an automatic step, a page's fields. "flow": the flow stands the run there.
   */
  private async atWork(): Promise<FlowEvent | null | "flow"> {
    const { state, cursor } = this.run;
    if (state.deciding) {
      return this.decide(state.deciding);
    }
    const step = this.stepOf(cursor);
    if (step && !isPersonStep(step) && step.type !== "wait" && step.type !== "result") {
      return this.runStep(step);
    }
    if (step?.type === "form" && step.fields.some(isDecidedField) && !state.pages?.[step.id]) {
      return this.pickFields(step);
    }
    return "flow";
  }

  private load({ run, rev }: { run: FlowRun; rev: number }) {
    this.run = run;
    this.stored = run;
    this.rev = rev;
  }

  private async move(event: FlowEvent, from: FlowRun): Promise<FlowResult> {
    const { host } = this;
    return transition(host.def, from, event, {
      now: host.clock.now(),
      render: (text, state) => renderTemplate(text, { def: host.def, state, brand: {} }),
      listCounts: await listCounts(host.def, host.services.data),
      durable: host.switches.durable,
      lookAgainMs: host.switches.lookAgainMs,
    });
  }

  /** The clock woke a run that waits for a signal: one stored meanwhile ends the wait. */
  private async fromClock(event: FlowEvent): Promise<FlowEvent> {
    const step = this.stepOf(this.run.cursor);
    if (
      event.kind !== "woke" ||
      this.run.status !== "waiting_signal" ||
      step?.type !== "wait" ||
      !step.signal
    ) {
      return event;
    }
    const key = renderTemplate(step.signal.key, {
      def: this.host.def,
      state: this.run.state,
      brand: {},
    }).trim();
    const came = key ? await this.host.signals.watch(step.id, step.signal.name, key) : null;
    return came ? { kind: "signal", stepId: step.id, id: came.id, data: came.data } : event;
  }

  /** Does what the move says. The next event, or null: the run waits, ended, or was stopped. */
  private async carry(
    event: FlowEvent,
    result: FlowResult,
    from: FlowRun,
  ): Promise<FlowEvent | null> {
    const { host } = this;
    const { command } = result;
    if (command.kind === "stay") {
      // Nothing changed: the time goes back.
      await host.clock.wakeAt(from.wakeAt);
      return null;
    }
    if ((event.kind === "woke" || event.kind === "signal") && this.costsNext(result.run)) {
      // A woken run holds credits again before it goes on: it gave its hold back while it waited.
      const held = await host.credits.hold();
      if (held === "unsure") {
        await host.clock.wakeAt(from.wakeAt ?? host.clock.now());
        return null;
      }
      if (held === "refused") {
        // The wait is over either way: the top-up goes on from the next step.
        return this.outOfCredits({ ...result.run, cursor: result.run.cursor ?? from.cursor });
      }
    }
    if (event.kind === "stepFailed" && this.failing) {
      await this.failureLines(event.stepId, result);
    }
    const stand = event.kind === "resume" || this.standNext;
    this.standNext = false;
    if (!stand && arrives(result.run)) {
      // The move is written at once; the run stands there with `resume`, where that step's own
      // work comes first.
      await this.write(result, { ...result.run, status: "running", wakeAt: null }, null);
      return { kind: "resume" };
    }
    switch (command.kind) {
      case "run":
        await this.write(result);
        return this.runStep(command.step);
      case "decide":
        await this.write(result);
        return this.decide(command.stepId);
      case "ask":
        return this.ask(result, command);
      case "waitSignal":
        return this.waitSignal(result, command);
      case "sleep":
        return this.sleep(result, command);
      default:
        await this.write(result);
        return null;
    }
  }

  /** The step the run goes on to costs something: anything but the result. */
  private costsNext(run: FlowRun): boolean {
    const next = this.stepOf(run.cursor);
    return Boolean(next) && next?.type !== "result";
  }

  // --- the commands ------------------------------------------------------------------------------

  /**
   * Runs an automatic step; its output, or its failure, is the next event. A service that works on
   * a whole step for long (a film, a video) answers `pending`: the run sleeps until it is done.
   */
  private async runStep(step: Step): Promise<FlowEvent | null> {
    const { host } = this;
    // A service works on this step already: the run woke to ask it again, and the step goes on.
    const onJob = this.run.state.job?.stepId === step.id;
    if (this.run.state.holdLater) {
      // An answer moved the run on without holding again: it holds before it spends. Whoever holds
      // credits out of reach stops no run: `canSpend` still guards the step.
      const { holdLater: _, ...state } = this.run.state;
      if ((await host.credits.hold()) === "refused") {
        return this.outOfCredits({ ...this.run, state });
      }
      await this.save({ ...this.run, state });
    }
    if (!(await host.credits.canSpend())) {
      return this.outOfCredits(this.run);
    }
    if (!onJob) {
      await host.event(
        step.id,
        "step_started",
        ("working" in step ? step.working : undefined) ?? step.title,
      );
    }
    const state = structuredClone(this.run.state);
    // What lets a call repeated after a restart find its row is on the run before the step acts.
    // An agent step's turn is on the run before its first model call: the step writes it.
    const changed = host.switches.effects && enterVisit(step, state);
    if (changed) {
      await this.save({ ...this.run, state: structuredClone(state) });
    }
    let pending: Pending;
    try {
      const made = await host.within(step.type, async (signal) => {
        const ctx = await host.context(step, state, signal);
        await host.guard?.before(ctx);
        const made = await runAutomaticStep(step, ctx);
        if (!(signal.aborted || isPending(made))) {
          await host.guard?.after(ctx, made);
        }
        return made;
      });
      if (host.signal.aborted) {
        return null;
      }
      if (isPending(made)) {
        pending = made;
      } else {
        await host.spent?.(step.id, "step");
        this.run = { ...this.run, state };
        this.finished = step;
        return { kind: "stepDone", stepId: step.id, output: made };
      }
    } catch (err) {
      return host.signal.aborted ? null : this.failed(step.id, err, state);
    }
    await this.sleepOnJob(step, state, pending);
    return null;
  }

  /**
   * A service works on the step: the run sleeps with the job until the service wakes it, or until
   * the job's own time to look again. Nothing is said: the step is at work, as it was.
   */
  private async sleepOnJob(step: Step, state: RunState, pending: Pending) {
    state.job = { stepId: step.id, id: pending.id };
    if (pending.wakeAt === null) {
      await this.host.clock.wakeAt(null);
    }
    const run: FlowRun = {
      ...this.run,
      cursor: step.id,
      status: "sleeping",
      wakeAt: pending.wakeAt,
      state,
    };
    await this.write({ run, command: { kind: "sleep" } });
  }

  /** A model picks which of the step's `ask` rules holds. */
  private async decide(stepId: string): Promise<FlowEvent | null> {
    const { host } = this;
    const step = this.stepOf(stepId) as Step;
    const state = structuredClone(this.run.state);
    let rule: number | null;
    try {
      rule = await host.within("decision", (signal) => decideBranch(host, step, state, signal));
    } catch (err) {
      return host.signal.aborted ? null : this.failed(stepId, err, state);
    }
    if (host.signal.aborted) {
      return null;
    }
    await host.spent?.(stepId, "decision");
    this.run = { ...this.run, state };
    return { kind: "decided", stepId, rule };
  }

  /** A person's step: a start's answers fill the page or pass the review, or it stands there. */
  private async ask(
    result: FlowResult,
    command: Extract<FlowCommand, { kind: "ask" }>,
  ): Promise<FlowEvent | null> {
    const { host } = this;
    const { step } = command;
    // What the team is asked waits for the team, also on a started run.
    const start = await host.start();
    if (start && !(whoOf(step) === "team" && host.switches.durable)) {
      const passed = await this.pass(step, result.run.state, start);
      if (passed) {
        this.run = result.run;
        return passed;
      }
    }
    const run = result.run;
    delete run.state.answered;
    await this.write(result, run);
    if (host.switches.durable && (step.timeout || step.remind) && run.wakeAt !== null) {
      await host.event(step.id, "wait", note("runWaitsAnswerUntil", { until: at(run.wakeAt) }));
    }
    await host.ask(step, command.who, command.remindAt);
    return null;
  }

  /** A decision picks the decided fields of the page the run is at, once, as it reaches it. */
  private async pickFields(step: FormStep): Promise<FlowEvent | null | "flow"> {
    const { host } = this;
    const state = structuredClone(this.run.state);
    let shown: string[];
    try {
      shown = await host.within("decision", (signal) => decideFields(host, step, state, signal));
    } catch (err) {
      return host.signal.aborted ? null : this.failed(step.id, err, state);
    }
    if (host.signal.aborted) {
      return null;
    }
    await host.spent?.(step.id, "decision");
    state.pages = { ...state.pages, [step.id]: { shown } };
    delete state.retries;
    await this.save({ ...this.run, state });
    return "flow";
  }

  /**
   * Nobody is there: the start's answers fill the page when every required field has one, its
   * setting passes the review. Null: the owner has to come.
   */
  private async pass(
    step: FormStep | ReviewStep,
    state: RunState,
    start: RunStart,
  ): Promise<FlowEvent | null> {
    if (step.type === "review") {
      // An approval is a person's: no setting gives it.
      return start.passReviews && !step.approve
        ? { kind: "reviewed", stepId: step.id, approved: true }
        : null;
    }
    const shown = state.pages?.[step.id]?.shown;
    const fill = state.fill ?? {};
    const input = Object.fromEntries(
      step.fields
        .filter((f) => (!shown || shown.includes(f.id)) && f.id in fill)
        .map((f) => [f.id, fill[f.id]]),
    );
    const context = await formContextOf(this.host.def, this.host.services.data, step, state);
    const { values, errors } = readFormInput(step, input, context);
    return errors.length ? null : { kind: "answered", stepId: step.id, values };
  }

  /** The wait is registered first, then the run looks: a signal that came before ends it now. */
  private async waitSignal(
    result: FlowResult,
    command: Extract<FlowCommand, { kind: "waitSignal" }>,
  ): Promise<FlowEvent | null> {
    const { host } = this;
    const step = this.stepOf(result.run.cursor) as WaitStep;
    this.watching = true;
    const came = await host.signals.watch(step.id, command.name, command.key);
    if (came) {
      this.run = result.run;
      this.standNext = true;
      return { kind: "signal", stepId: step.id, id: came.id, data: came.data };
    }
    await host.event(step.id, "step_started", step.title);
    await this.write(result);
    const { wakeAt } = result.run;
    await host.event(
      step.id,
      "wait",
      wakeAt === null ? note("runWaitsSignal") : note("runWaitsSignalUntil", { until: at(wakeAt) }),
    );
    return null;
  }

  /** Nothing runs until the wake: a wait, a retry, or a person who has to act first. */
  private async sleep(
    result: FlowResult,
    command: Extract<FlowCommand, { kind: "sleep" }>,
  ): Promise<null> {
    const { host } = this;
    const step = this.stepOf(result.run.cursor);
    if (command.tell) {
      await this.tell(step?.id ?? "", command.tell);
    }
    const waits = step?.type === "wait" && !result.run.state.pause;
    if (waits) {
      await host.event(step.id, "step_started", step.title);
    }
    await this.write(result);
    if (waits && result.run.wakeAt !== null) {
      await host.event(step.id, "wait", note("runWaitsUntil", { until: at(result.run.wakeAt) }));
    }
    return null;
  }

  /** Someone has to act before the run goes on: the log says so, and a notice tells them. */
  private async tell(stepId: string, pause: Exclude<RunPause, { kind: "retry" }>) {
    const { host } = this;
    const said =
      pause.kind === "sign_in"
        ? note("stepWaitsSignIn", { service: pause.service })
        : note("stepWaitsCredits");
    await host.event(stepId, "error", said);
    try {
      await host.services.people.tell({
        kind: "needs_you",
        stepId,
        waitKey: `pause:${pause.kind}`,
        detail: saidText(said, textLang(wizardLang(host.def))),
      });
    } catch (err) {
      // A notice never breaks a run.
      console.error(`[notices] run ${host.runId}:`, err);
    }
  }

  // --- failures ----------------------------------------------------------------------------------

  /**
   * A step failed: the next event says how, from the run as stored. What the step did to its copy
   * is not to stay; what was written while it worked (a visit, a turn) is. `working`: the step's
   * copy, kept where its turn stopped to ask the person.
   */
  private async failed(stepId: string, err: unknown, working: RunState): Promise<FlowEvent | null> {
    const { host } = this;
    this.load(await host.store.load());
    if (this.run.state.job?.stepId === stepId) {
      // The service's job failed, or the step around it: a new try starts a new one.
      const { job: _, ...state } = this.run.state;
      this.run = { ...this.run, state };
    }
    // A turn starts over after a failure: the state knows what an earlier try of it did.
    const sorted = await host.failure(err, stepId, Boolean(turnOf(this.run.state, stepId)?.acted));
    if (sorted.kind === "asked") {
      // The turn stopped for a person: its conversation is stored and nothing is held.
      await this.save({ ...this.run, state: working, status: "waiting_input" });
      await host.event(
        stepId,
        "info",
        note("turnAsked", { question: sorted.question.slice(0, 200) }),
      );
      return null;
    }
    this.failing = { said: sorted.said, err };
    return { kind: "stepFailed", stepId, failure: sorted.failure, acted: sorted.acted };
  }

  /** Out of credits before the step `run` stands at: the run waits for a person. */
  private outOfCredits(run: FlowRun): FlowEvent {
    this.run = { ...run, status: "running", wakeAt: null };
    this.failing = { said: note("wizardRunOutCredits") };
    return { kind: "stepFailed", stepId: run.cursor ?? "", failure: { class: "credits" } };
  }

  /** What a failure's move says in the log: a retry, or the step's `onFail`. */
  private async failureLines(stepId: string, result: FlowResult) {
    const { host } = this;
    const { command, run } = result;
    if (command.kind === "sleep" && run.state.pause?.kind === "retry") {
      const now = host.clock.now();
      const minutes = Math.round(((run.wakeAt ?? now) - now) / 60_000);
      await host.event(stepId, "info", note("stepRetries", { minutes }));
    } else if (command.kind !== "sleep" && command.kind !== "fail") {
      await host.event(stepId, "error", this.failing?.said ?? "");
      await host.event(
        stepId,
        "info",
        note("stepFailedGoesOn", { step: this.stepOf(run.cursor)?.title ?? "" }),
      );
    }
  }

  // --- writes ------------------------------------------------------------------------------------

  /** Writes a change of the state where the run stands. */
  private async save(run: FlowRun) {
    await this.write({ run, command: { kind: "stay" } }, run, null);
  }

  /** Writes a move, with what the log says about it. */
  private async write(
    result: FlowResult,
    run: FlowRun = result.run,
    command: FlowCommand | null = result.command,
  ) {
    const { host } = this;
    const before = this.stored;
    if (result.error) {
      await host.event(result.error.stepId, "error", result.error.said);
      if (command?.kind !== "fail") {
        await host.event(
          result.error.stepId,
          "info",
          note("stepFailedGoesOn", { step: this.stepOf(run.cursor)?.title ?? "" }),
        );
      }
    }
    let failed: Move["failed"];
    if (run.status === "failed") {
      failed = {
        said: result.error?.said ?? this.failing?.said ?? "",
        ...(this.failing?.err === undefined ? {} : { err: this.failing.err }),
      };
      if (!result.error) {
        await host.event(run.cursor, "error", failed.said);
      }
    }
    if (run.status !== "waiting_signal" && (this.watching || before.status === "waiting_signal")) {
      await host.signals.drop();
      this.watching = false;
      if (before.status === "waiting_signal") {
        await host.clock.wakeAt(null);
      }
    }
    // The wake first: a stop after it gives a wake that finds the run as it was.
    if (run.wakeAt !== null) {
      await host.clock.wakeAt(run.wakeAt);
    }
    this.rev = await host.store.save({ run, command, ...(failed ? { failed } : {}) }, this.rev);
    this.run = run;
    this.stored = run;
    this.failing = null;
    if (this.finished) {
      // The output is saved: the step's turns are done with.
      await host.turns.drop(this.finished.id);
      await host.event(this.finished.id, "step_done", this.finished.title);
      this.finished = null;
    }
    await this.leftLines(before, run);
  }

  /** The waits and the timed-out person's steps this write left behind: what the log says. */
  private async leftLines(before: FlowRun, after: FlowRun) {
    const { host } = this;
    for (const step of host.def.steps) {
      if (!passed(before.state, after.state, step.id)) {
        continue;
      }
      if (step.type === "wait") {
        const stood =
          before.cursor === step.id &&
          (before.status === "sleeping" || before.status === "waiting_signal");
        if (!stood) {
          await host.event(step.id, "step_started", step.title);
        }
        if (step.signal) {
          const came = (after.state.outputs[step.id]?.json as { came?: boolean } | undefined)?.came;
          await host.event(step.id, "info", note(came ? "signalCame" : "signalTimedOut"));
        } else if (stood && this.event.kind === "woke") {
          await host.event(step.id, "woken", note("runWaitOver"));
        }
        await host.event(step.id, "step_done", step.title);
      } else if (
        (step.type === "form" || step.type === "review") &&
        before.status === "waiting_input" &&
        before.cursor === step.id &&
        (after.state.outputs[step.id]?.json as { timedOut?: boolean } | undefined)?.timedOut
      ) {
        await host.event(step.id, "woken", note("stepTimedOut"));
        await host.event(step.id, "step_done", step.title);
      }
    }
  }

  private stepOf(id: string | null): Step | undefined {
    return id === null ? undefined : this.host.def.steps.find((s) => s.id === id);
  }
}

/** The move stands the run at a wait, a person's step or the result. */
function arrives(run: FlowRun): boolean {
  return (
    run.status === "waiting_input" ||
    run.status === "waiting_signal" ||
    (run.status === "sleeping" && !run.state.pause) ||
    (run.status === "done" && run.cursor !== null)
  );
}

const isPersonStep = (step: Step): step is FormStep | ReviewStep =>
  step.type === "form" || step.type === "review";

/** Whether the move wrote `stepId`'s output anew. */
function passed(before: RunState, after: RunState, stepId: string): boolean {
  const output = after.outputs[stepId];
  return output !== undefined && output.at !== before.outputs[stepId]?.at;
}

/** A visit of a step that acts through a connection, counted on the run before it acts. */
function enterVisit(step: Step, state: RunState): boolean {
  if (step.type !== "tool" || !step.call || !("connection" in step.call)) {
    return false;
  }
  if (state.visiting === step.id) {
    return false;
  }
  state.visiting = step.id;
  state.visits = { ...state.visits, [step.id]: (state.visits?.[step.id] ?? 0) + 1 };
  return true;
}

const at = (ms: number) => ({ at: new Date(ms).toISOString() });
