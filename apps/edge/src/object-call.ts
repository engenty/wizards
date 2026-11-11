/**
 * The engine's host for one call of a run's object: an alarm, or a door's event. The engine
 * (`advance`) takes the run from event to event; this keeps what it asks of its host in the
 * object's storage, and reaches everything outside the run through the run's services over HTTP
 * with the run's token (`httpServices`), as `wizards run`'s host does in a folder
 * (packages/run/src/node-host.ts).
 *
 * One model call a call. An alarm call of an object has at most 15 minutes of wall time, so a run
 * does its work in many: before its second model call (a step's next, a decision's, the next
 * entry's) the call stops, and the object's next alarm goes on from what was saved. A door's call
 * makes none: it moves the run as far as it goes without one, and the alarm does the rest.
 *
 * The call stops by aborting its signal: the engine writes nothing more and leaves the run where
 * it was, at work at its step, as after a restart. The step's turn is saved after each model call
 * and each tool call (steps/agent-turn.ts), so going on repeats nothing that was answered.
 * A step that goes on in the next call writes its lines again (its `step_started`, a foreach's
 * entries); a line this visit of the step wrote already is not written twice (`replay`).
 */
import { formContextOf } from "@engenty/wizards-engine/decisions";
import { NOTE_CLASS } from "@engenty/wizards-engine/failures";
import { type RunHost, RunMoved } from "@engenty/wizards-engine/host";
import type { HostActor, HostChange, HostSendable } from "@engenty/wizards-engine/host-api";
import type { HttpServices } from "@engenty/wizards-engine/http-services";
import { fieldErrorsIn, readFormInput } from "@engenty/wizards-engine/input";
import { surfaceData } from "@engenty/wizards-engine/surface";
import { scopeLists } from "@engenty/wizards-engine/template";
import { type StepContext, StepError, TurnAsks } from "@engenty/wizards-engine/types";
import type { Step } from "@engenty/wizards-shared/definition";
import { note, type RunEventType, type Said, saidText } from "@engenty/wizards-shared/run";
import { ServiceError, type TurnPart } from "@engenty/wizards-shared/run-services";
import type { FlowEvent, FlowFailure, FlowRun } from "@engenty/wizards-shared/transition";
import { Refusal } from "./refusal.js";
import type { Held, RunStorage, StoredRun } from "./run-storage.js";

/** The call stopped before a model call: the next goes on. */
export class Yield extends Error {
  constructor() {
    super("The object's call stops before its next model call.");
    this.name = "Yield";
  }
}

/** Statuses a time can end. */
export const WAITS = new Set<FlowRun["status"]>(["sleeping", "waiting_signal", "waiting_input"]);

export interface ObjectCallOptions {
  storage: RunStorage;
  held: Held;
  /** The run's services, with its token. */
  services: HttpServices;
  /** How many model calls this call may make: an alarm one, a door none. */
  models: number;
  now(): number;
  /** Each write and each line, for whoever follows the run. */
  tell(change: HostChange): void;
  /** The call before this one stopped before a model call: going on is no interruption. */
  wentOn: boolean;
}

export interface ObjectCall {
  readonly host: RunHost;
  /** Model calls this call made. */
  readonly made: number;
  /** It stopped before a model call. */
  readonly yielded: boolean;
  /** The run as stored. */
  stored(): Promise<StoredRun>;
  /** The door's part of an event: what goes on to the flow, or null when the door did it all. */
  door(event: HostSendable, by: HostActor | undefined): Promise<FlowEvent | null>;
  /** A line of the run's log. */
  line(stepId: string | null, type: RunEventType, said: Said): Promise<void>;
}

/** The most of an answer to a step's question the run keeps. The door checks a guest's words first. */
const ANSWER_CHARS = 10_000;

export async function objectCall(options: ObjectCallOptions): Promise<ObjectCall> {
  const { storage, held, now } = options;
  const { runId, def, files } = held;
  const abort = new AbortController();
  /** The lines this visit of the run's step wrote, in this call and the ones before. */
  let visit = await storage.replay();
  /** Of those, the ones calls before this one wrote: written once, they are not written again. */
  let replay = [...visit];
  let rev = (await storage.run())?.rev ?? 0;
  let made = 0;
  let yielded = false;
  /** A person answered and the move it makes is not written yet: when. */
  let answeredAt: number | null = null;

  const stopIfAborted = () => {
    if (abort.signal.aborted) {
      throw abort.signal.reason;
    }
  };

  /** Before each model call: the first in an alarm call goes, any other stops the call. */
  const gate = () => {
    stopIfAborted();
    if (made >= options.models) {
      yielded = true;
      abort.abort(new Yield());
      throw abort.signal.reason;
    }
    made += 1;
  };
  const services = gated(options.services, gate);

  const stored = async (): Promise<StoredRun> => {
    const s = await storage.run();
    if (!s) {
      throw new Error(`The object holds no run ${runId}.`);
    }
    return s;
  };

  const line = async (
    stepId: string | null,
    type: RunEventType,
    said: Said,
    asset?: string,
  ): Promise<void> => {
    if (abort.signal.aborted) {
      return;
    }
    const key = JSON.stringify([stepId, type, said]);
    const again = replay.indexOf(key);
    if (again >= 0) {
      replay.splice(again, 1);
      return;
    }
    // A turn that goes on after the call before stopped for it was not interrupted.
    if (options.wentOn && typeof said !== "string" && said.code === "turnWentOn") {
      return;
    }
    visit = [...visit, key];
    const event = await storage.append(
      {
        stepId,
        type,
        message: saidText(said, "en"),
        note: typeof said === "string" ? null : said,
        asset: asset ?? null,
      },
      now(),
      visit,
    );
    options.tell({ rev, events: [event] });
    // A step at work starts: its services read the run at the tenant.
    const step = def.steps.find((x) => x.id === stepId);
    if (type === "step_started" && step && worksItself(step)) {
      const s = await stored();
      if (s.run.status === "running" && s.run.cursor === stepId) {
        await report(s);
      }
    }
  };

  /**
   * Writes the run. `moved`: the flow moved it (or the door ended or woke it): nothing written
   * before is a line this visit writes again. A run that comes to rest elsewhere (a person's
   * step, a wait, its end) is copied to its tenant.
   */
  const write = async (next: StoredRun, moved: boolean, failed?: Said) => {
    stopIfAborted();
    const before = await stored();
    await storage.saveRun(next, moved);
    if (moved) {
      visit = [];
      replay = [];
    }
    if (next.run.status === "failed") {
      await storage.setError(failed ?? (await storage.error()) ?? "");
    } else if (before.run.status === "failed") {
      await storage.setError(null);
    }
    rev = next.rev;
    options.tell({ rev, events: [] });
    const elsewhere =
      next.run.cursor !== before.run.cursor || next.run.status !== before.run.status;
    if (next.run.status !== "running" && elsewhere) {
      await report(next);
    }
  };

  /**
   * A copy of the run at its tenant, whose services read the run's state there and whose doors
   * show it: as each step starts (its `step_started` line), at each person's step and wait, and at
   * the end. One that does not get there is sent again by the object's alarm.
   */
  const report = async (s: StoredRun) => {
    await storage.setUnreported(s.rev);
    try {
      const error = s.run.status === "failed" ? await storage.error() : null;
      await options.services.run.report({
        status: s.run.status,
        cursor: s.run.cursor,
        state: s.run.state,
        wakeAt: s.run.wakeAt,
        rev: s.rev,
        ...(error === null ? {} : { error }),
      });
      if ((await storage.unreported()) === s.rev) {
        await storage.setUnreported(null);
      }
    } catch (err) {
      console.error(`[run ${runId}] the copy at the tenant (rev ${s.rev}):`, messageOf(err));
    }
  };

  const host: RunHost = {
    runId,
    def,
    files,
    store: {
      async load() {
        const s = await stored();
        rev = s.rev;
        return { run: s.run, rev: s.rev };
      },
      async save(move, heldRev) {
        const s = await stored();
        if (s.rev !== heldRev) {
          throw new RunMoved();
        }
        const to = structuredClone(move.run);
        // The door's part of an answer's move: when it came and where it led. A person's step it
        // led to straight away takes it off again (`advance`'s ask), so it is not written there.
        if (answeredAt !== null && move.command) {
          if (move.command.kind !== "ask") {
            to.state.answered = { at: answeredAt, next: to.cursor };
          }
          answeredAt = null;
        }
        // The data the result names, kept with a run that reached it.
        const step = def.steps.find((x) => x.id === to.cursor);
        if (to.status === "done" && step?.type === "result" && step.data) {
          to.state.data = surfaceData(step.data, {
            def,
            state: to.state,
            scope: { def, state: to.state, brand: {} },
          });
        } else if (to.status !== "done") {
          delete to.state.data;
        }
        await write({ rev: heldRev + 1, run: to }, move.command !== null, move.failed?.said);
        return heldRev + 1;
      },
    },
    turns: {
      load: (id) => storage.turn(id),
      async save(turn) {
        stopIfAborted();
        await storage.saveTurn(turn);
      },
      async drop(stepId) {
        stopIfAborted();
        await storage.dropTurns(stepId);
      },
    },
    clock: {
      now,
      // The object sets its one alarm from the run as stored when the call ends; while it works,
      // the alarm is the call's watchdog.
      wakeAt: async () => {},
    },
    event: (stepId, type, said) => line(stepId, type, said),
    // Who is told that the run waits for them, and reminded, is the tenant's: it hears of the
    // person's step from the run's copy (`report`).
    ask: async () => {},
    signals: {
      async watch(stepId) {
        const kept = await storage.takeSignal(stepId);
        return kept ? { id: kept.id, data: kept.data } : null;
      },
      drop: async () => {},
    },
    // Whoever spends books and refuses: a service out of credits fails its call with the class
    // `credits`, and the run waits for a top-up as after any step that failed so.
    credits: { hold: async () => "held", canSpend: async () => true },
    start: async () => null,
    async context(step: Step, state, signal): Promise<StepContext> {
      const lists = def.lists?.length ? await scopeLists(def, services.data) : undefined;
      return {
        runId,
        // The tenant's: its services read the tenant, the holder and the data space from the
        // run's token. Step code reads none of them.
        tenantId: "",
        holder: { kind: "person", id: "", role: "member" },
        dataSpace: { id: "", name: "" },
        test: false,
        stepId: step.id,
        ...(state.turn?.stepId === step.id ? { turn: state.turn.id } : {}),
        def,
        lang: null,
        files,
        state,
        scope: { def, state, brand: {}, ...(lists ? { lists } : {}) },
        signal,
        emit: (type, message, asset) => line(step.id, type, message, asset),
        // Nobody answers in the middle of a step here.
        ask: async () => null,
        // The state as the step has it, kept where the run stands: the revision stays.
        async saveState() {
          const s = await stored();
          await write({ ...s, run: { ...s.run, state: structuredClone(state) } }, false);
        },
        turns: host.turns,
        durable: host.switches.durable,
        services,
      };
    },
    async failure(err, _stepId, acted) {
      if (err instanceof RunMoved || err instanceof Yield) {
        throw err;
      }
      if (err instanceof TurnAsks) {
        return { kind: "asked", question: err.question };
      }
      const said: Said =
        err instanceof StepError && err.note
          ? err.note
          : err instanceof Error
            ? err.message
            : String(err);
      const failure =
        err instanceof ServiceError
          ? err.failure
          : failureOf(err instanceof StepError ? err.note?.code : undefined);
      return { kind: "failed", failure, acted, said };
    },
    async within(_kind, work) {
      stopIfAborted();
      return work(abort.signal);
    },
    signal: abort.signal,
    services,
    switches: { durable: true, effects: true, lookAgainMs: 5 * 60_000 },
  };

  /** The line a door writes for a person's step it takes the answer of, and when it came. */
  const doorLine = async (step: Step) => {
    await line(step.id, "step_done", step.title);
    answeredAt = now();
  };

  async function door(e: HostSendable, by: HostActor | undefined): Promise<FlowEvent | null> {
    const s = await stored();
    const { run } = s;
    const at = (stepId: string) => run.status === "waiting_input" && run.cursor === stepId;
    switch (e.kind) {
      case "answered": {
        const step = def.steps.find((x) => x.id === e.stepId);
        if (!(step?.type === "form" && at(step.id))) {
          throw new Refusal(409, `The run does not wait at the page ${e.stepId}.`);
        }
        const context = await formContextOf(def, services.data, step, run.state);
        const read = readFormInput(step, e.values, context);
        if (read.errors.length) {
          throw new Refusal(
            422,
            "Some answers are missing or not valid.",
            fieldErrorsIn(read.errors, "en"),
          );
        }
        await doorLine(step);
        return { ...e, values: read.values };
      }
      case "reviewed":
      case "regenerate": {
        const step = def.steps.find((x) => x.id === e.stepId);
        if (!(step?.type === "review" && at(step.id))) {
          throw new Refusal(409, `The run does not wait at the review ${e.stepId}.`);
        }
        if (e.kind === "reviewed") {
          await doorLine(step);
        }
        return e;
      }
      case "resume":
        if (run.status === "running") {
          // At work: the object's alarm goes on with it.
          return null;
        }
        if (run.status !== "failed") {
          throw new Refusal(409, "The run is neither at work nor failed.");
        }
        return e;
      case "woke": {
        if (!(WAITS.has(run.status) && run.wakeAt !== null)) {
          throw new Refusal(409, "Nothing in the run waits for a time.");
        }
        if (run.wakeAt > now()) {
          if (!by?.name) {
            throw new Refusal(400, "A wake before its time says who asked for it (by.name).");
          }
          // "Continue now": the wait's time is now.
          await write({ rev: s.rev + 1, run: { ...run, wakeAt: now() } }, false);
          await line(run.cursor, "woken", note("runWokenBy", { name: by.name }));
        }
        return e;
      }
      case "signal":
        if (!(run.status === "waiting_signal" && run.cursor === e.stepId)) {
          // Before its wait: kept until the wait takes it.
          await storage.keepSignal(e.stepId, { id: e.id, data: e.data });
          return null;
        }
        return e;
      case "stop": {
        if (!by?.name) {
          throw new Refusal(400, "A stop says who asked for it (by.name).");
        }
        if (!WAITS.has(run.status)) {
          throw new Refusal(409, "The run does not wait: it moved on.");
        }
        await write({ rev: s.rev + 1, run: { ...run, status: "cancelled", wakeAt: null } }, true);
        await line(run.cursor, "stopped", note("runStoppedBy", { name: by.name }));
        return null;
      }
      case "turnAnswered": {
        const turn = run.state.turn;
        if (!(run.status === "waiting_input" && turn?.question && run.cursor === turn.stepId)) {
          throw new Refusal(409, "The run's step asks nothing now.");
        }
        const state = structuredClone(run.state);
        state.turn = { ...turn, answer: e.answer.trim().slice(0, ANSWER_CHARS) };
        // At work again: the object's alarm goes on with the step's turn.
        await write({ rev: s.rev + 1, run: { ...run, state, status: "running" } }, true);
        await line(turn.stepId, "info", { code: "turnAnswered" });
        return null;
      }
      case "viewKept": {
        // Only while the run waits or is done, and on the state the door read: a running step
        // owns the state then.
        const output = run.state.outputs[e.stepId];
        if (!output) {
          throw new Refusal(409, `The run has no output of ${e.stepId}.`);
        }
        if (!(run.status === "waiting_input" || run.status === "done") || e.rev !== s.rev) {
          throw new Refusal(409, "The run moved on.");
        }
        const state = structuredClone(run.state);
        state.outputs[e.stepId] = { ...output, view: e.view };
        await write({ rev: s.rev + 1, run: { ...run, state } }, false);
        return null;
      }
      case "resultTranslated": {
        const state = structuredClone(run.state);
        state.translated = {
          ...state.translated,
          [e.lang]: { ...state.translated?.[e.lang], [e.stepId]: e.text },
        };
        await write({ rev: s.rev + 1, run: { ...run, state } }, false);
        return null;
      }
      case "askAnswered":
      case "outputEdited":
      case "start":
      case "stepDone":
      case "stepFailed":
      case "decided":
        throw new Refusal(400, `The run's object does not take "${e.kind}" from outside.`);
      default:
        return e;
    }
  }

  return {
    host,
    get made() {
      return made;
    },
    get yielded() {
      return yielded;
    },
    stored,
    door,
    line: (stepId, type, said) => line(stepId, type, said),
  };
}

/** The events the object refuses from a door: the ones the engine makes, and the doors' it has no part for. */
export const NOT_TAKEN = [
  "start",
  "stepDone",
  "stepFailed",
  "decided",
  "askAnswered",
  "outputEdited",
] as const;

/**
 * The run's services, each model call first through `gate`: a model's turn (a step's, an agent's
 * model's), a decision, a whole step at a service and a tool step's call.
 */
function gated(services: HttpServices, gate: () => void): HttpServices {
  const turnOf = (parts: () => AsyncIterable<TurnPart>): AsyncIterable<TurnPart> =>
    (async function* () {
      gate();
      yield* parts();
    })();
  return {
    ...services,
    models: {
      ...services.models,
      turn: (request, signal) => turnOf(() => services.models.turn(request, signal)),
      decide: async (request, signal) => {
        gate();
        return services.models.decide(request, signal);
      },
      async agentModel(request) {
        const model = await services.models.agentModel(request);
        // The same model, which the step's tools are bound to (`httpServices`): its turn gated.
        const turn = model.turn.bind(model);
        model.turn = (r, signal) => turnOf(() => turn(r, signal));
        return model;
      },
    },
    tools: {
      ...services.tools,
      call: async (request, signal) => {
        gate();
        return services.tools.call(request, signal);
      },
    },
    steps: {
      run: async (step, signal, effect) => {
        gate();
        return services.steps.run(step, signal, effect);
      },
    },
  };
}

/** A step the run does itself: not a person's, a wait or the result. */
function worksItself(step: Step): boolean {
  return !["form", "review", "wait", "result"].includes(step.type);
}

/** A failure by its note's class; anything else is final. */
function failureOf(code: string | undefined): FlowFailure {
  switch (NOTE_CLASS[code ?? ""]) {
    case "credits":
      return { class: "credits" };
    case "sign_in":
      return { class: "sign_in", service: "" };
    default:
      return { class: "final" };
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
