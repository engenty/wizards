import {
  type HostActor,
  HostApiError,
  type HostChange,
  type HostSendable,
  type HostSent,
  type HostState,
  hostApi,
  type PageSent,
} from "@engenty/wizards-engine/host-api";
import type { InputError } from "@engenty/wizards-engine/input";
import type { RunHostKind, RunHostRef, StepOutput } from "@engenty/wizards-shared/run";
import { feature, remoteFeatures } from "../features.js";
import { peerTicket } from "../secrets/signing.js";
import { currentTenant } from "../tenants/tenant.js";
import { answerAsk } from "./asks.js";
import { eventsAfter, type RunSignal, signalChanged, watchChanges, watchRun } from "./events.js";
import { runStore } from "./run-store.js";
import {
  answerTurn,
  cancel,
  editOutput,
  flowRun,
  goBack,
  loadRun,
  type ReviewAction,
  RunConflict,
  RunInputError,
  retry,
  reviewStep,
  stopRun,
  submitPage,
  wakeNow,
  writeRunState,
} from "./runner.js";
import type { RunRow } from "./types.js";

/*
 * A run as its doors reach it (docs/plans/runs-on-their-own.md, phase 4): where the record says
 * it lives. A run of this runtime (`host` null) is reached through the runner's functions in this
 * process, exactly as the doors called them before other hosts; a run on another runtime process
 * through that host's three calls (`hostApi`, routes/peer.ts) with a fresh peer ticket each.
 *
 * What stays at the tenant stays at the door: who may see and answer (`openedRun`, `mayAct`), the
 * run's own lines a door writes (a withdrawn run), a share that stops on "back", the typed
 * answers kept apart (`keepUnsent`).
 */

/** Whether a run may live on a host other than this runtime, for the tenant at hand. */
export async function runHostsOn(): Promise<boolean> {
  return feature("runHosts", await remoteFeatures().catch(() => null));
}

/** A run's host as its doors use it. */
export interface RunHostClient {
  readonly runId: string;
  /** Where the run lives: null for this runtime. */
  readonly host: RunHostRef | null;
  /** Where the run stands, with what a view shows besides the flow's fields. */
  state(signal?: AbortSignal): Promise<HostState>;
  /**
   * The run's changes past revision `since` and log line `after` (the newest line already read;
   * left out: from the log's newest line), until `signal` aborts.
   */
  changes(since: number, after: number | undefined, signal: AbortSignal): AsyncIterable<HostChange>;
  /** An event for the run, taken as its doors take it; refusals throw `RunConflict` or `RunInputError`. */
  send(event: HostSendable, by?: HostActor, page?: PageSent): Promise<HostSent>;
  /**
   * Tells of every change, as `watchRun` does for a run of this process. `since`: the revision
   * the caller read, for a run on another host. Returns the unsubscribe.
   */
  watch(listener: (signal: RunSignal) => void, since?: number): () => void;
}

/** A host the doors cannot reach yet: what it hands out to authenticate comes with its kind. */
export class HostUnreachable extends Error {
  constructor(readonly kind: RunHostKind) {
    super(`The run's host (${kind}) is not reachable yet.`);
    this.name = "HostUnreachable";
  }
}

/**
 * How a door reaches a run on a host of each kind. `runtime`: another process of this runtime,
 * with a peer ticket (the secret they share). `node` (`wizards run`, phase 5) and `edge` (phase 6)
 * authenticate differently, with what their hand-over gives them: until then they are not reached.
 */
const REACH: Record<RunHostKind, (host: RunHostRef, runId: string) => RunHostClient> = {
  runtime: (host, runId) => remoteClient(host, runId),
  node: (host) => {
    throw new HostUnreachable(host.kind);
  },
  edge: (host) => {
    throw new HostUnreachable(host.kind);
  },
};

/**
 * The host of `run` as its doors reach it: this runtime's own functions for a run of this
 * runtime, and for every run while other hosts are off; the host's calls for a run whose record
 * names another host. Call it in the run's tenant.
 */
export async function hostClientOf(run: Pick<RunRow, "id" | "host">): Promise<RunHostClient> {
  if (!run.host || !(await runHostsOn())) {
    return localClient(run.id);
  }
  return REACH[run.host.kind](run.host, run.id);
}

/**
 * The run as its doors see it: the record, with what its host keeps (where it stands, its state,
 * its failure, what it asks) read from the host when that is another one. A run of this runtime
 * is the record as it is.
 */
export async function hostedRun<R extends RunRow>(row: R): Promise<R> {
  const client = await hostClientOf(row);
  if (!client.host) {
    return row;
  }
  return withHostState(row, await client.state());
}

/** The record with the host's fields over it. */
export function withHostState<R extends RunRow>(row: R, { run, error, ask }: HostState): R {
  return {
    ...row,
    cursor: run.cursor,
    status: run.status,
    state: run.state,
    wakeAt: run.wakeAt === null ? null : new Date(run.wakeAt),
    rev: run.rev,
    error,
    ask,
  };
}

// --- this runtime ------------------------------------------------------------

function localClient(runId: string): RunHostClient {
  return {
    runId,
    host: null,
    async state() {
      const run = await runStore.pick(
        runId,
        "cursor",
        "status",
        "state",
        "wakeAt",
        "rev",
        "error",
        "ask",
      );
      if (!run) {
        throw new RunConflict("Run not found");
      }
      const event = (await runStore.lastChange(runId))?.event ?? 0;
      return { run: { ...flowRun(run), rev: run.rev }, event, error: run.error, ask: run.ask };
    },
    changes: (since, after, signal) => localChanges(runId, since, after, signal),
    async send(event, by, page) {
      const already = await takeEvent(runId, event, by, page);
      const rev = (await runStore.pick(runId, "rev"))?.rev ?? 0;
      return { rev, ...(already ? { already } : {}) };
    },
    watch: (listener) => watchRun(runId, listener),
  };
}

/**
 * The changes of a run of this runtime, as `GET changes` sends them: each look reads the row's
 * revision and the log's lines since the last one told; `watchRun` says when to look, also for
 * what another process wrote. Called in the run's tenant; ends when `signal` aborts or the run is
 * gone.
 */
export async function* localChanges(
  runId: string,
  since: number,
  after: number | undefined,
  signal: AbortSignal,
): AsyncGenerator<HostChange> {
  let rev = since;
  let told = after ?? (await runStore.lastChange(runId))?.event ?? 0;
  let pending = true;
  let wake: (() => void) | null = null;
  const poke = () => {
    pending = true;
    wake?.();
  };
  const unsubscribe = watchRun(runId, poke);
  signal.addEventListener("abort", poke, { once: true });
  try {
    while (!signal.aborted) {
      await new Promise<void>((resolve) => {
        wake = resolve;
        if (pending) {
          resolve();
        }
      });
      wake = null;
      if (signal.aborted) {
        return;
      }
      pending = false;
      let change: HostChange | null = null;
      try {
        const row = await runStore.pick(runId, "rev");
        if (!row) {
          return;
        }
        const events = [];
        for (let page = await eventsAfter(runId, told); page.length; ) {
          events.push(...page);
          told = page[page.length - 1].id;
          page = page.length < 200 ? [] : await eventsAfter(runId, told);
        }
        if (row.rev !== rev || events.length) {
          rev = row.rev;
          change = { rev, events };
        }
      } catch (err) {
        // The next look tells.
        console.error(`[run ${runId}] changes:`, err);
      }
      if (change) {
        yield change;
      }
    }
  } finally {
    signal.removeEventListener("abort", poke);
    unsubscribe();
  }
}

/** A review's answer as the doors give it, from the event: an edited output goes as its text or its data. */
function reviewOf(event: Extract<HostSendable, { kind: "reviewed" }>): ReviewAction {
  if (!event.approved) {
    return { type: "decline", ...(event.note ? { note: event.note } : {}) };
  }
  const edits: Record<string, string | Record<string, unknown>> = {};
  for (const [target, output] of Object.entries(event.edited ?? {})) {
    edits[target] = editOf(target, output);
  }
  return {
    type: "accept",
    ...(Object.keys(edits).length ? { edits } : {}),
    ...(event.note ? { note: event.note } : {}),
  };
}

function editOf(target: string, output: StepOutput): string | Record<string, unknown> {
  const { json, text } = output;
  if (json && typeof json === "object" && !Array.isArray(json)) {
    return json as Record<string, unknown>;
  }
  if (typeof text === "string") {
    return text;
  }
  throw new NotTaken(`An edit of ${target} carries neither a text nor data.`);
}

/** The event of a door's review: an accept or a decline, or a target made again. */
export function reviewEvent(stepId: string, action: ReviewAction): HostSendable {
  switch (action.type) {
    case "accept": {
      const edited: Record<string, StepOutput> = {};
      for (const [target, edit] of Object.entries(action.edits ?? {})) {
        // Only what the door gives counts: the host rebuilds the output from it.
        edited[target] = (typeof edit === "string" ? { text: edit } : { json: edit }) as StepOutput;
      }
      return {
        kind: "reviewed",
        stepId,
        approved: true,
        ...(action.note ? { note: action.note } : {}),
        ...(Object.keys(edited).length ? { edited } : {}),
      };
    }
    case "decline":
      return {
        kind: "reviewed",
        stepId,
        approved: false,
        ...(action.note ? { note: action.note } : {}),
      };
    case "regenerate":
      return {
        kind: "regenerate",
        stepId,
        target: action.target,
        note: action.note,
        ...(action.items?.length ? { items: action.items } : {}),
      };
  }
}

/** A refusal of an event the host does not take from outside, or not with what it carries. */
export class NotTaken extends Error {}

/**
 * Takes an event the way the doors take it, through the runner's own functions: a page's answer
 * (true: its number had come before), a review, back, try again, "Continue now", cancel, "Stop",
 * the answer to what a step asks, and what a door keeps in the run's state (a view's state, an
 * edited output, a translated result). What the host makes itself while it drives (`start`,
 * `stepDone`, `stepFailed`, `decided`) and a signal (stored at the tenant first, then taken by the
 * wait) are not taken here.
 */
export async function takeEvent(
  runId: string,
  event: HostSendable,
  by?: HostActor,
  page?: PageSent,
): Promise<boolean> {
  const actor = by && { userId: by.userId, visitorId: by.visitorId };
  switch (event.kind) {
    case "answered":
      return submitPage(runId, event.stepId, event.values, actor, page);
    case "reviewed":
      await reviewStep(runId, event.stepId, reviewOf(event), actor);
      return false;
    case "regenerate":
      await reviewStep(
        runId,
        event.stepId,
        {
          type: "regenerate",
          target: event.target,
          note: event.note,
          ...(event.items?.length ? { items: event.items } : {}),
        },
        actor,
      );
      return false;
    case "back":
      await goBack(runId, actor);
      return false;
    case "resume":
      await retry(runId);
      return false;
    case "cancel":
      await cancel(runId);
      return false;
    case "woke":
      if (!by?.name) {
        throw new NotTaken("A wake before its time says who asked for it (by.name).");
      }
      await wakeNow(runId, by.name);
      return false;
    case "stop":
      if (!by?.name) {
        throw new NotTaken("A stop says who asked for it (by.name).");
      }
      await stopRun(runId, by.name);
      return false;
    case "askAnswered":
      if (!(await answerAsk(runId, event.askId, event.answer))) {
        throw new RunConflict({ code: "askClosed" });
      }
      return false;
    case "turnAnswered":
      await answerTurn(runId, event.answer);
      return false;
    case "viewKept": {
      // Only while the run waits or is done, and on the state the door read: a running step
      // owns the state then.
      const run = await loadRun(runId);
      const output = run?.state.outputs[event.stepId];
      if (!(run && output)) {
        throw new RunConflict("Unknown step");
      }
      if (run.status !== "waiting_input" && run.status !== "done") {
        throw new RunConflict({ code: "runBusy" });
      }
      const kept = await writeRunState(
        { id: runId, rev: event.rev },
        {
          ...run.state,
          outputs: { ...run.state.outputs, [event.stepId]: { ...output, view: event.view } },
        },
      );
      if (!kept) {
        throw new RunConflict({ code: "runBusy" });
      }
      return false;
    }
    case "outputEdited":
      await editOutput(runId, event.stepId, event.json);
      return false;
    case "resultTranslated": {
      const run = await loadRun(runId);
      if (!run) {
        throw new RunConflict("Run not found");
      }
      const state = run.state;
      state.translated = {
        ...state.translated,
        [event.lang]: { ...state.translated?.[event.lang], [event.stepId]: event.text },
      };
      if (!(await writeRunState(run, state))) {
        throw new RunConflict({ code: "runBusy" });
      }
      signalChanged(runId);
      return false;
    }
    default:
      throw new NotTaken(`The run's host does not take "${event.kind}" from outside.`);
  }
}

// --- another runtime process -------------------------------------------------

function remoteClient(host: RunHostRef, runId: string): RunHostClient {
  const tenant = currentTenant();
  const api = hostApi({
    url: host.url,
    runId,
    tenant,
    ticket: () => peerTicket(runId, tenant),
  });
  const client: RunHostClient = {
    runId,
    host,
    state: (signal) => api.state(signal),
    changes: (since, after, signal) => api.changes(since, signal, after),
    async send(event, by, page) {
      try {
        return await api.send(event, by, page);
      } catch (err) {
        throw refusalOf(err);
      }
    },
    watch: (listener, since) => watchChanges(runId, client, listener, since),
  };
  return client;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The host's refusal as the runner's own: a conflict with what it says, the fields a page did
 * not take. A door puts both in its own words, as for a run of this process.
 */
function refusalOf(err: unknown): unknown {
  if (!(err instanceof HostApiError) || !isRecord(err.body)) {
    return err;
  }
  const { said, errors } = err.body;
  if (err.status === 409) {
    return new RunConflict(
      typeof said === "string" || isRecord(said)
        ? (said as ConstructorParameters<typeof RunConflict>[0])
        : err.message,
    );
  }
  if (err.status === 422 && Array.isArray(errors)) {
    return new RunInputError(errors as InputError[]);
  }
  return err;
}
