/**
 * A host for one run in a Node process (docs/plans/runs-on-their-own.md, "Where a run can live",
 * `wizards run`). The engine (`advance`) takes the run from event to event; this host keeps what
 * the engine asks of it:
 *
 * - the run's state, its agent turns and its log in a folder (`run-folder.ts`);
 * - the clock: a timer for `wakeAt` while the process lives, and on `start()` a run whose wake is
 *   past is woken at once, so a process started again picks up where the last one stopped;
 * - everything outside the run through the run's services over HTTP (`httpServices`), with the
 *   run's token: models, tools, files, data, context, notices. Whoever spends books it there;
 *   this host books nothing;
 * - a copy of the run for its tenant (`run.report`) as each step starts, at each person's step,
 *   at each wait and at the end: the tenant's services build a step's context from it, and the
 *   tenant tells people, releases credits and lists the run from it;
 * - the three host calls (`state`, `changes`, `events`, as `@engenty/wizards-engine/host-api`
 *   has them) on a loopback port, for doors in other processes (`loopback.ts`).
 *
 * One host per run and folder. Every advance of the run goes through one queue, so two events
 * never move the run at the same time.
 */
import { advance } from "@engenty/wizards-engine/advance";
import { formContextOf } from "@engenty/wizards-engine/decisions";
import { NOTE_CLASS } from "@engenty/wizards-engine/failures";
import { type RunHost, RunMoved, type RunStart } from "@engenty/wizards-engine/host";
import type { HostActor, HostChange, HostRun, HostState } from "@engenty/wizards-engine/host-api";
import { httpServices } from "@engenty/wizards-engine/http-services";
import { fieldErrorsIn, readFormInput } from "@engenty/wizards-engine/input";
import { surfaceData } from "@engenty/wizards-engine/surface";
import { scopeLists } from "@engenty/wizards-engine/template";
import { type StepContext, StepError, TurnAsks } from "@engenty/wizards-engine/types";
import type { Step, WizardDefinition } from "@engenty/wizards-shared/definition";
import { note, type Said, saidText } from "@engenty/wizards-shared/run";
import { ServiceError } from "@engenty/wizards-shared/run-services";
import {
  type FlowEvent,
  type FlowFailure,
  FlowRefused,
  type FlowRun,
} from "@engenty/wizards-shared/transition";
import type { WorkspaceFile } from "@engenty/wizards-shared/workspace";
import { HostRefusal } from "./host-refusal.js";
import { type Loopback, serveLoopback } from "./loopback.js";
import { RunFolder, type StoredRun } from "./run-folder.js";

export { HostRefusal };

export interface NodeHostOptions {
  /** The run's folder; made if it is not there. A folder the run was in before goes on from where it is. */
  dir: string;
  /** The run's services: the runtime's origin and the run's token (`httpServices`). */
  services: { url: string; token: string; fetch?: typeof fetch };
  def: WizardDefinition;
  /** The workspace the run started with; the services read the files by path. */
  files: WorkspaceFile[];
  run: {
    /** The run's id at its tenant, the one its token names. */
    id: string;
    /** The language the person reads the wizard in; null or left out: its own. */
    lang?: string | null;
    /**
     * The revision the run's record at its tenant holds when the host takes the run: the host's
     * writes go on from it, so the tenant keeps each copy. Left out: the run starts at 1.
     */
    rev?: number;
  };
  /** The start the run came from with nobody there; left out: a person runs it. */
  start?: RunStart | null;
  /** The loopback port of the three host calls; left out or 0: one the system picks. */
  port?: number;
  /** Left out: `Date.now`. */
  now?: () => number;
  /** Durable runs (deadlines on a person's step, retries, `onFail`); left out: on. */
  durable?: boolean;
  /** Acting calls go with their effect ids; left out: on. */
  effects?: boolean;
  /** How often a run that waits for a person looks whether they acted; left out: 5 minutes. */
  lookAgainMs?: number;
  /**
   * Each write of the run's state, once it is in the folder and before its copy goes to the
   * tenant: whoever started the host can still use the run's token here, e.g. to fetch a result's
   * files before the run ends. Awaited before the run goes on.
   */
  onWrite?(run: HostRun): void | Promise<void>;
  /**
   * Copies of the run to its tenant (`run.report`); left out: on. Off only where something else
   * copies the run (a test that writes the record itself).
   */
  reports?: boolean;
}

export interface NodeHost {
  readonly runId: string;
  /** Where the three host calls are served: `http://127.0.0.1:<port>`. */
  readonly url: string;
  /**
   * What a caller of the three calls sends as `Authorization: Bearer`. Made when the host starts
   * and known only to whoever started it.
   */
  readonly secret: string;
  /** The host as the engine sees it. */
  readonly host: RunHost;
  /**
   * Starts the run, or goes on with it where its folder left it: a run at work goes on, a wake
   * that is past wakes it, one to come is set. Resolves when the run rests.
   */
  start(): Promise<void>;
  /** Where the run stands, and the newest line of its log. */
  state(): Promise<HostState>;
  /**
   * An event from a door (`POST events`): a page's answer, a review, back, cancel, try again, the
   * clock, a signal. Resolves with the run's revision after the event's first write, while the run
   * goes on; throws `HostRefusal` for an event the host does not take.
   */
  send(event: FlowEvent, by?: HostActor): Promise<{ rev: number }>;
  /** Each change as it is written: the run's revision, and a new line of its log. */
  watch(listener: (change: HostChange) => void): () => void;
  /** Resolves when nothing moves the run any more. */
  idle(): Promise<void>;
  /** Stops the run's work and the three calls; nothing more is written. The folder stays. */
  close(): Promise<void>;
}

/** Events the engine makes itself while it drives: nobody sends them from outside. */
const MADE_INSIDE = new Set<FlowEvent["kind"]>(["start", "stepDone", "stepFailed", "decided"]);

/** Statuses a time can end. */
const WAITS = new Set<FlowRun["status"]>(["sleeping", "waiting_signal", "waiting_input"]);

/** setTimeout's longest delay; a later wake is set again when the timer fires. */
const LONGEST_TIMER_MS = 2 ** 31 - 1;

/** A woken run that did not move looks again after this long, not at once. */
const LOOK_AGAIN_MS = 60_000;

/** A copy the tenant did not take for a passing reason is sent this often in all. */
const REPORT_TRIES = 3;

const blank = (): FlowRun => ({
  cursor: null,
  status: "running",
  state: { values: {}, outputs: {}, history: [], notes: {} },
  wakeAt: null,
});

export async function nodeHost(options: NodeHostOptions): Promise<NodeHost> {
  const { def, files } = options;
  const runId = options.run.id;
  const lang = options.run.lang ?? null;
  const now = options.now ?? Date.now;
  const folder = await RunFolder.open(options.dir);
  const abort = new AbortController();
  const services = httpServices(options.services);
  const listeners = new Set<(change: HostChange) => void>();

  let rev = (await folder.load())?.rev ?? 0;
  /** A person answered and the move it makes is not written yet: when. */
  let answeredAt: number | null = null;
  /** Told the revision of the next write: a door's event waits for it. */
  let firstWrite: ((rev: number) => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let queue: Promise<void> = Promise.resolve();

  const closed = () => abort.signal.aborted;
  const stopIfClosed = () => {
    if (closed()) {
      throw abort.signal.reason ?? new Error("The run's host is closed.");
    }
  };
  const tell = (change: HostChange) => {
    for (const listener of listeners) {
      try {
        listener(change);
      } catch (err) {
        console.error(`[run ${runId}] a listener failed:`, err);
      }
    }
  };

  const stored = async (): Promise<StoredRun> => {
    const s = await folder.load();
    if (!s) {
      throw new Error(`The run ${runId} has not started in ${options.dir}.`);
    }
    if (s.runId !== runId) {
      throw new Error(`${options.dir} holds the run ${s.runId}, not ${runId}.`);
    }
    return s;
  };

  /**
   * The run's copy at its tenant. Each copy is the whole run, so one that does not arrive is made
   * good by the next; a passing failure is tried again, and one that stays is said on stderr.
   */
  const report = async (s: StoredRun, error: Said | null) => {
    if (options.reports === false) {
      return;
    }
    const copy = {
      status: s.run.status,
      cursor: s.run.cursor,
      state: s.run.state,
      wakeAt: s.run.wakeAt,
      rev: s.rev,
      // The record keeps at most 2000 characters of words.
      ...(error === null
        ? {}
        : { error: typeof error === "string" ? error.slice(0, 2000) : error }),
    };
    for (let tries = 1; ; tries++) {
      try {
        await services.run.report(copy, abort.signal);
        return;
      } catch (err) {
        const passing = err instanceof ServiceError && err.failure.class === "retry";
        if (passing && tries < REPORT_TRIES && !closed()) {
          await new Promise((r) => setTimeout(r, 500 * tries));
          continue;
        }
        console.error(
          `[run ${runId}] The run's copy didn't reach its organization: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
    }
  };

  /**
   * Writes the run whole; everyone who follows it hears of it. `copy`: the write moves the run
   * (another step, another status), so its tenant gets a copy, with the failure's words if any.
   */
  const write = async (s: StoredRun, copy?: { error: Said | null }) => {
    stopIfClosed();
    await folder.save(s);
    const moved = s.rev !== rev;
    rev = s.rev;
    await options.onWrite?.({ ...s.run, rev: s.rev });
    if (copy) {
      await report(s, copy.error);
    }
    if (moved) {
      tell({ rev, events: [] });
      firstWrite?.(rev);
      firstWrite = null;
    }
  };

  const event = async (
    stepId: string | null,
    type: Parameters<RunHost["event"]>[1],
    said: Said,
    asset?: string,
  ) => {
    if (closed()) {
      return;
    }
    const line = await folder.append(
      stepId,
      type,
      saidText(said, "en"),
      typeof said === "string" ? null : said,
      asset ?? null,
    );
    tell({ rev, events: [line] });
  };

  /** One thing at a time moves the run: each job waits for the one before. */
  const enqueue = <T>(job: () => Promise<T>): Promise<T> => {
    const done = queue.then(() => {
      stopIfClosed();
      return job();
    });
    queue = done.then(
      () => undefined,
      (err) => {
        if (!closed()) {
          console.error(`[run ${runId}]`, err);
        }
      },
    );
    return done;
  };

  /** The timer for the run's wake; null: none. */
  const arm = (at: number | null) => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (at === null || closed()) {
      return;
    }
    const delay = Math.min(Math.max(0, at - now()), LONGEST_TIMER_MS);
    timer = setTimeout(() => {
      timer = null;
      void enqueue(wakeIfDue).catch(() => undefined);
    }, delay);
    // The timer keeps no process alive by itself: the loopback server does while the host is open.
    timer.unref();
  };

  /** The clock: a run whose wake is due goes on; one whose wake is later is set again. */
  async function wakeIfDue() {
    const s = await stored();
    const at = s.run.wakeAt;
    if (!(WAITS.has(s.run.status) && at !== null)) {
      return;
    }
    if (at > now()) {
      arm(at);
      return;
    }
    await advance(host, { kind: "woke" });
    const after = await stored();
    if (after.rev === s.rev && after.run.wakeAt !== null && after.run.wakeAt <= now()) {
      // The wake moved nothing: not again at once.
      arm(now() + LOOK_AGAIN_MS);
    }
  }

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
      async save(move, held) {
        const s = await stored();
        if (s.rev !== held) {
          throw new RunMoved();
        }
        const { run: to, command } = move;
        // The door's part of an answer's move: when it came and where it led. A person's step it
        // led to straight away takes it off again (`advance`'s ask), so it is not written there.
        if (answeredAt !== null && command) {
          if (command.kind !== "ask") {
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
        const moves = s.run.status !== to.status || s.run.cursor !== to.cursor;
        await write(
          { runId, rev: held + 1, run: structuredClone(to) },
          moves
            ? { error: to.status === "failed" ? (move.failed?.said ?? null) : null }
            : undefined,
        );
        return held + 1;
      },
    },
    turns: {
      load: (id) => folder.turn(id),
      async save(turn) {
        stopIfClosed();
        await folder.saveTurn(turn);
      },
      async drop(stepId) {
        stopIfClosed();
        await folder.dropTurns(stepId);
      },
    },
    clock: {
      now,
      wakeAt: async (at) => arm(at),
    },
    event: (stepId, type, said) => event(stepId, type, said),
    // Who is told that the run waits for them is the tenant's: the doors follow `changes`.
    ask: async () => {},
    signals: {
      async watch(stepId) {
        const kept = await folder.takeSignal(stepId);
        return kept ? { id: kept.id, data: kept.data } : null;
      },
      drop: async () => {},
    },
    // Whoever spends books and refuses: a service out of credits fails its call with the class
    // `credits`, and the run waits for a top-up as after any step that failed so.
    credits: { hold: async () => "held", canSpend: async () => true },
    start: async () => options.start ?? null,
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
        lang,
        files,
        state,
        scope: { def, state, brand: {}, ...(lists ? { lists } : {}) },
        signal,
        emit: (type, message, asset) => event(step.id, type, message, asset),
        // Nobody answers in the middle of a step here.
        ask: async () => null,
        // The state as the step has it, kept where the run stands: the revision stays.
        async saveState() {
          const s = await stored();
          await write({ ...s, run: { ...s.run, state: structuredClone(state) } });
        },
        turns: host.turns,
        durable: host.switches.durable,
        services,
      };
    },
    async failure(err, _stepId, acted) {
      if (err instanceof RunMoved) {
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
      stopIfClosed();
      return work(abort.signal);
    },
    signal: abort.signal,
    services,
    switches: {
      durable: options.durable ?? true,
      effects: options.effects ?? true,
      lookAgainMs: options.lookAgainMs ?? 5 * 60_000,
    },
  };

  /** What a door does before the event moves the run. The event as it goes on; null: kept, nothing moves. */
  async function door(e: FlowEvent, by: HostActor | undefined, s: StoredRun) {
    const { run } = s;
    const at = (stepId: string) => run.status === "waiting_input" && run.cursor === stepId;
    switch (e.kind) {
      case "answered": {
        const step = def.steps.find((x) => x.id === e.stepId);
        if (!(step?.type === "form" && at(step.id))) {
          throw new HostRefusal(409, `The run does not wait at the page ${e.stepId}.`);
        }
        const context = await formContextOf(def, services.data, step, run.state);
        const read = readFormInput(step, e.values, context);
        if (read.errors.length) {
          throw new HostRefusal(
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
          throw new HostRefusal(409, `The run does not wait at the review ${e.stepId}.`);
        }
        if (e.kind === "reviewed") {
          await doorLine(step);
        }
        return e;
      }
      case "resume":
        if (!(run.status === "failed" || run.status === "running")) {
          throw new HostRefusal(409, "The run is neither at work nor failed.");
        }
        return e;
      case "woke": {
        if (!(WAITS.has(run.status) && run.wakeAt !== null)) {
          throw new HostRefusal(409, "Nothing in the run waits for a time.");
        }
        if (run.wakeAt > now()) {
          if (!by?.name) {
            throw new HostRefusal(400, "A wake before its time says who asked for it (by.name).");
          }
          // "Continue now": the wait's time is now.
          await write({ ...s, rev: s.rev + 1, run: { ...run, wakeAt: now() } });
          await event(run.cursor, "woken", note("runWokenBy", { name: by.name }));
        }
        return e;
      }
      case "signal":
        if (!(run.status === "waiting_signal" && run.cursor === e.stepId)) {
          // Before its wait: kept until the wait takes it.
          await folder.keepSignal({ stepId: e.stepId, id: e.id, data: e.data });
          return null;
        }
        return e;
      default:
        return e;
    }
  }

  /** The line a door writes for a person's step it takes the answer of, and when it came. */
  async function doorLine(step: Step) {
    await event(step.id, "step_done", step.title);
    answeredAt = now();
  }

  const loopback: Loopback = await serveLoopback({
    runId,
    port: options.port ?? 0,
    state: () => state(),
    send: (e, by) => send(e, by),
    changes: (since, after) => ({ rev, events: folder.eventsAfter(after), moved: rev !== since }),
    lastEvent: () => folder.lastEvent,
    watch: (listener) => watch(listener),
  });

  async function state(): Promise<HostState> {
    const s = await stored();
    // Nothing here asks the person while a step works (`ctx.ask` is null). A failure's words are
    // the log's last `error` line.
    const error =
      s.run.status === "failed"
        ? (folder.eventsAfter(0).findLast((e) => e.type === "error")?.message ?? null)
        : null;
    return { run: { ...s.run, rev: s.rev }, event: folder.lastEvent, error, ask: null };
  }

  function watch(listener: (change: HostChange) => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function send(e: FlowEvent, by?: HostActor): Promise<{ rev: number }> {
    if (MADE_INSIDE.has(e.kind)) {
      return Promise.reject(
        new HostRefusal(400, `The run's host does not take "${e.kind}" from outside.`),
      );
    }
    let written: (rev: number) => void = () => {};
    const first = new Promise<number>((resolve) => {
      written = resolve;
    });
    const job = enqueue(async () => {
      const s = await stored();
      const taken = await door(e, by, s);
      if (!taken) {
        return rev;
      }
      firstWrite = written;
      try {
        await advance(host, taken);
      } catch (err) {
        if (err instanceof FlowRefused) {
          throw new HostRefusal(409, `The run does not take this now (${err.code}).`);
        }
        throw err;
      } finally {
        firstWrite = null;
        answeredAt = null;
      }
      return rev;
    });
    return Promise.race([first, job]).then((r) => ({ rev: r }));
  }

  return {
    runId,
    url: loopback.url,
    secret: loopback.secret,
    host,
    start: () =>
      enqueue(async () => {
        const s = await folder.load();
        if (!s) {
          // The revision the tenant's record has: the start's move is the first one past it.
          await write({ runId, rev: options.run.rev ?? 1, run: blank() });
          await event(null, "run_started", note("runStarted"));
          await advance(host, { kind: "start" });
          return;
        }
        if (s.runId !== runId) {
          throw new Error(`${options.dir} holds the run ${s.runId}, not ${runId}.`);
        }
        rev = s.rev;
        if (s.run.status === "running") {
          // The process before stopped while the run was at work: it goes on from its last write.
          await advance(host, { kind: "resume" });
        } else if (WAITS.has(s.run.status) && s.run.wakeAt !== null) {
          if (s.run.wakeAt <= now()) {
            await wakeIfDue();
          } else {
            arm(s.run.wakeAt);
          }
        }
      }),
    state,
    send,
    watch,
    async idle() {
      let seen: Promise<void> | null = null;
      while (seen !== queue) {
        seen = queue;
        await seen;
      }
    },
    async close() {
      abort.abort(new Error("The run's host closed."));
      arm(null);
      listeners.clear();
      await loopback.close();
    },
  };
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
