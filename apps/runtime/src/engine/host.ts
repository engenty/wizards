/**
 * The runtime as the host of a run: what `advance` (packages/engine) asks of it, in the runner's
 * drive. The row through `writeMove` and its guards, the control copy of the wake, the log, asks,
 * credits, signals, the in-process step context and its services. The line, the claim and the
 * heartbeat stay with the runner.
 */
import { createHash } from "node:crypto";
import type { Failure } from "@engenty/wizards-engine/failures";
import type { Move, RunHost, StepFailure } from "@engenty/wizards-engine/host";
import { answersAsText } from "@engenty/wizards-engine/template";
import type { StepServices } from "@engenty/wizards-engine/types";
import { isNoteTime, note, type RunEventType, type Said } from "@engenty/wizards-shared/run";
import type { FlowFailure, FlowRun } from "@engenty/wizards-shared/transition";
import { effectsOn } from "../broker/effect.js";
import { runHolder, subjectsOf } from "../broker/rwx.js";
import { addLocalCost, canSpend, syncRunCost } from "../credits/credits.js";
import { db } from "../db/client.js";
import { decide } from "../decide.js";
import { env } from "../env.js";
import { NotedError } from "../model-errors.js";
import { noteFreeTierRefusal, takeMasked } from "../models.js";
import type { SpaceRow } from "../run-services/in-process.js";
import { checkGuestInput, checkGuestText, guestChecksOn, guestRun } from "../safety.js";
import { listRows, scopeOf } from "../store/index.js";
import { setWake } from "../tenants/control.js";
import { TurnAsks } from "./durable-turn.js";
import { emitEvent, saidInVisit, visitLeftOpen } from "./events.js";
import { classifyFailure } from "./failures.js";
import { withMailText } from "./mail-watch.js";
import { noticeFor, noticeWrites } from "./notices.js";
import { pushRun } from "./push.js";
import { maskedNote } from "./requirements.js";
import { liveResources, resourcesFor } from "./resources.js";
import { runStore } from "./run-store.js";
import {
  durableRunsOn,
  failSaid,
  failureContext,
  flowRun,
  holdAgain,
  LostClaim,
  loadRun,
  loadSpace,
  lookAgainMs,
  makeContext,
  spaceIdOf,
  writeMove,
} from "./runner.js";
import { dropWait, findSignal, registerWait } from "./signals.js";
import { startOf } from "./starts.js";
import type { RunRow } from "./types.js";
import { SignInNeeded } from "./types.js";

/** A step past its deadline (`env.runner.stepDeadlines`): it fails, and its slot comes free. */
export class StepDeadline extends NotedError {
  constructor() {
    super(note("stepTookTooLong"));
  }
}

/**
 * Does a step's work under its deadline. Past it the work hears `deadline` on the signal it was
 * given, and the answer is a StepDeadline even if the work never ends: a hung step gives its slot
 * back. A stop of the run itself passes through to the work.
 */
export async function withDeadline<T>(
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
        return { class: "sign_in", service: err.service };
      }
      return acted ? { class: "final" } : { class: "sign_in", service: "" };
    default:
      return { class: "final" };
  }
}

/** The wizard's lists with the rows the run's holder may read. */
async function listsOf(run: RunRow) {
  const scope = scopeOf(run);
  const who = subjectsOf({ holder: await runHolder(run), store: scope });
  const out: Record<string, Awaited<ReturnType<StepServices["data"]["rows"]>>> = {};
  for (const def of run.definition.lists ?? []) {
    out[def.id] = { def, rows: await listRows(scope, def, who) };
  }
  return out;
}

/**
 * What the engine asks of the run's services outside a step: a decision, the stored lists, a
 * notice. A step gets all of them through its context.
 */
function hostServices(run: RunRow): StepServices {
  const services: {
    models: Pick<StepServices["models"], "decide">;
    data: Pick<StepServices["data"], "rows" | "counts">;
    people: StepServices["people"];
  } = {
    models: {
      decide: (request, signal) =>
        decide({
          state: request.state,
          questions: request.questions,
          call: { runId: run.id, stepId: request.stepId },
          signal,
          deadlineMs: request.deadlineMs,
          charge: (usd) => addLocalCost(run.id, request.stepId, usd),
        }),
    },
    data: {
      async rows(listId) {
        const list = (await listsOf(run))[listId];
        if (!list) {
          throw new Error(`No list ${listId} in this wizard.`);
        }
        return list;
      },
      async counts() {
        return Object.fromEntries(
          Object.entries(await listsOf(run)).map(([id, list]) => [id, list.rows.length]),
        );
      },
    },
    people: {
      async tell(notice) {
        const made = await noticeFor(run, notice.kind, {
          waitKey: notice.waitKey,
          detail: notice.detail,
        });
        if (made) {
          await db.batch(noticeWrites(made, runStore.where(run.id)) as never);
        }
      },
    },
  };
  return services as unknown as StepServices;
}

/** The runtime's host of a run, with whether its drive went on after an interruption. */
export type RuntimeHost = RunHost & { interrupted: boolean };

/**
 * The host of the run `row` in this drive. `interrupted`: another drive had the run at work and
 * never reached a rest; the step it broke off stays one visit in the log.
 */
export async function runtimeHost(
  row: RunRow,
  signal: AbortSignal,
  interrupted: boolean,
): Promise<RuntimeHost> {
  const runId = row.id;
  let current = row;
  /** The row as last read or written: its status and revision guard the next write. */
  let stored = { status: row.status, rev: row.rev, fresh: true };
  let space: SpaceRow | null = null;
  /** The step whose context was made last: what the run's resources say it did is its. */
  let working: string | null = null;
  /** A wait's time the log said before an interruption: the wait keeps it. */
  let said: { stepId: string; until: number } | null = null;
  const until = (run: FlowRun) =>
    said && run.cursor === said.stepId && run.wakeAt !== null ? said.until : run.wakeAt;

  const host: RuntimeHost = {
    runId,
    def: row.definition,
    files: row.files,
    interrupted,
    store: {
      async load() {
        const run = await loadRun(runId);
        if (!run) {
          throw new LostClaim();
        }
        current = run;
        stored = { status: run.status, rev: run.rev, fresh: true };
        return { run: flowRun(run), rev: run.rev };
      },
      async save(move: Move, rev: number) {
        const run = { ...move.run, wakeAt: until(move.run) };
        // A wake's write holds on the run as it was read: an answer that came meanwhile wins, a
        // write of the state does not lose a timeout. Every other write holds on the status the
        // drive last wrote, beside its claim: a stop that came meanwhile wins.
        const seen =
          stored.fresh && stored.status === "waiting_input"
            ? { rev: stored.rev }
            : { status: stored.status };
        const step = row.definition.steps.find((s) => s.id === run.cursor);
        const { lastBy } = run.state;
        await writeMove(current, run, {
          seen,
          // Reached right from someone's answer: they know, they did it.
          by: move.command?.kind === "ask" && lastBy?.next === step?.id ? lastBy : undefined,
          err: move.failed?.err,
          said: move.failed?.said,
        });
        stored = { status: run.status, rev: stored.rev + 1, fresh: false };
        current = { ...current, cursor: run.cursor, status: run.status, state: run.state };
        if (move.command === null && run.status === "waiting_input") {
          // A turn stopped for a person: a phone in a pocket hears it.
          void pushRun(runId, "asks");
        }
        return rev + 1;
      },
    },
    clock: {
      now: () => Date.now(),
      async wakeAt(at) {
        const time = said && at !== null && current.cursor === said.stepId ? said.until : at;
        await setWake(runId, time === null ? null : new Date(time));
      },
    },
    async event(stepId: string | null, type: RunEventType, words: Said) {
      if (type === "step_started" && host.interrupted && stepId) {
        // Back in a step a crash broke off: it starts over, and stays one visit in the log.
        host.interrupted = false;
        if (await visitLeftOpen(runId, stepId)) {
          // Back at a wait: the time it said before the crash, not a new one from now.
          const line = await saidInVisit(runId, stepId, "wait");
          const at = line?.note?.params?.until;
          if (isNoteTime(at)) {
            said = { stepId, until: Date.parse(at.at) };
          }
          return;
        }
      }
      if (type === "wait" && said?.stepId === stepId) {
        return;
      }
      await emitEvent(runId, stepId, type, words);
    },
    async ask(step) {
      const { answered } = row.state;
      if (answered) {
        // The two times can come from two machines: small numbers on the cloud's split roles are rough.
        console.info(
          `[timing] page run=${runId} ms=${Math.max(0, Date.now() - answered.at)} direct=${answered.next === step.id} role=${env.role} durable=${(await durableRunsOn()) ? "on" : "off"} runner=yes`,
        );
      }
      // The next step is the person's: a phone in a pocket hears it.
      void pushRun(runId, "waiting");
    },
    signals: {
      async watch(stepId, _name, key) {
        const step = row.definition.steps.find((s) => s.id === stepId);
        if (step?.type !== "wait") {
          return null;
        }
        const spaceId = await spaceIdOf(current);
        // The wait is written first, then the run looks: a signal that came before is found here,
        // and one that comes after finds the wait and wakes the run. A run woken at its wait only
        // looks.
        if (current.status !== "waiting_signal") {
          await registerWait(current, spaceId, step, key);
        }
        const found = await findSignal(current, spaceId, step, key);
        return found ? { id: found.id, data: await withMailText(found) } : null;
      },
      drop: () => dropWait(runId),
    },
    credits: {
      async hold() {
        try {
          return (await holdAgain(current)) ? "refused" : "held";
        } catch (err) {
          console.warn(`[run ${runId}] holding credits:`, (err as Error).message);
          return "unsure";
        }
      },
      canSpend: () => canSpend(),
    },
    async start() {
      if (!current.startedBy) {
        return null;
      }
      return { passReviews: Boolean((await startOf(current))?.passReviews) };
    },
    async context(step, state, stepSignal) {
      working = step.id;
      resourcesFor(runId).acted = false;
      space ??= await loadSpace(current);
      return makeContext({ ...current, cursor: step.id, state }, space, state, stepSignal);
    },
    guard: {
      // A guest's answers are checked once before any model works on them, and what a step
      // wrote for a guest before it is kept (docs/plans/guest-content-guards.md).
      async before(ctx) {
        if (!(guestRun(current) && (await guestChecksOn()))) {
          return;
        }
        const answers = [answersAsText(ctx.scope), ...Object.values(ctx.state.notes)].join("\n");
        const hash = createHash("sha256").update(answers).digest("base64url").slice(0, 24);
        if (ctx.state.inputChecked !== hash) {
          await checkGuestInput({
            text: answers,
            call: { runId, stepId: ctx.stepId },
            signal: ctx.signal,
          });
          ctx.state.inputChecked = hash;
        }
      },
      async after(ctx, made) {
        if (!(guestRun(current) && (await guestChecksOn()))) {
          return;
        }
        await checkGuestText({
          text: made.text || (made.json ? JSON.stringify(made.json) : ""),
          call: { runId, stepId: ctx.stepId },
          signal: ctx.signal,
        });
      },
    },
    async failure(err, stepId, turnActed): Promise<StepFailure> {
      if (err instanceof LostClaim) {
        throw err;
      }
      if (err instanceof TurnAsks) {
        // The turn stopped for a person: its conversation is stored and no runner holds anything.
        await syncRunCost(runId);
        return { kind: "asked", question: err.question };
      }
      console.error(`[run ${runId} step ${stepId}]`, err);
      await noteFreeTierRefusal(err);
      const acted = turnActed || (working === stepId && Boolean(liveResources(runId)?.acted));
      const failure = classifyFailure(err, failureContext());
      return {
        kind: "failed",
        failure: flowFailure(err, failure, acted),
        acted,
        said: await failSaid(err),
      };
    },
    within: (kind, work) => withDeadline(kind, signal, work),
    async spent(stepId, kind) {
      await syncRunCost(runId);
      const masked = kind === "step" ? takeMasked(runId, stepId) : null;
      if (masked) {
        await emitEvent(runId, stepId, "info", maskedNote(masked));
      }
    },
    signal,
    services: hostServices(row),
    switches: {
      durable: await durableRunsOn(),
      effects: await effectsOn(),
      lookAgainMs: lookAgainMs(),
    },
  };
  return host;
}
