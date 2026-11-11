/**
 * One run, one object (docs/plans/runs-on-their-own.md, phase 6): a Durable Object that holds a
 * run its tenant handed over, keeps it in its own storage and wakes it with its own alarm. No code
 * per wizard: the definition comes with the run.
 *
 * Calls, under `/api/peer/runs/<run>/` (the Worker sends each to the run's object):
 * - `POST hand-over`: the tenant places the run here (`HandOver`, with the run's token as Bearer).
 *   Answers 202 once the object holds it; the same hand-over again changes nothing.
 * - `GET state`, `GET changes`, `POST events`: a host's three calls in the wire format of
 *   `@engenty/wizards-engine/host-api`, with the run's token as Bearer.
 *
 * The one alarm carries the run's work and its time, the earliest of:
 * - now, while the run is at work: each alarm call makes at most one model call (`object-call.ts`),
 *   so no call comes near the 15 minutes of wall time an alarm call has;
 * - the call's watchdog, `WATCHDOG_MS` ahead and set again while the call works (a model's stream
 *   among it): should the object stop in the middle (a deploy, a restart), the alarm comes back
 *   and the run goes on from its last write;
 * - the run's wake: a wait's end, a retry, a person's step's deadline, the time it looks again;
 * - a copy that did not reach the tenant, sent again.
 *
 * A person's step's reminder is the tenant's: the copy of the run at that step schedules it there.
 */
import { advance } from "@engenty/wizards-engine/advance";
import {
  HAND_OVER,
  type HostChange,
  type HostState,
  handOverSchema,
  hostEventSchema,
  PEER_RUNS_PATH,
} from "@engenty/wizards-engine/host-api";
import { httpServices } from "@engenty/wizards-engine/http-services";
import { note, saidText } from "@engenty/wizards-shared/run";
import { type FlowEvent, FlowRefused } from "@engenty/wizards-shared/transition";
import { NOT_TAKEN, type ObjectCall, objectCall, WAITS } from "./object-call.js";
import { Refusal } from "./refusal.js";
import { RunStorage, type StoredRun } from "./run-storage.js";

export interface EdgeEnv {
  /** The objects, one a run (`idFromName(<run id>)`). */
  RUN: DurableObjectNamespace;
  /** Where the run's services are: the tenant's runtime, its origin. */
  SERVICES_URL: string;
  /** How long a call's watchdog waits, in ms; left out: 30 s. */
  WATCHDOG_MS?: string;
}

/** How a call of the object ended. */
type Ended =
  /** The run rests: at a person, a wait, its end; or it waits for the next alarm at work. */
  | "rest"
  /** It stopped before a model call: the next alarm goes on at once. */
  | "yield"
  /** The clock woke a wait that did not move: it looks again later. */
  | "still"
  /** Something outside the run's steps failed (its services out of reach): tried again later. */
  | "error";

const WATCHDOG_MS = 30_000;
/** A call that failed outside the run's steps is tried again after this long. */
const AGAIN_AFTER_ERROR_MS = 60_000;
/** A copy that did not reach the tenant is sent again after this long. */
const REPORT_AGAIN_MS = 30_000;
/** A woken wait that did not move looks again after this long, not at once. */
const LOOK_AGAIN_MS = 60_000;
/** How often a held-open stream of changes says something, if only a blank line. */
const KEEP_ALIVE_MS = 15_000;
/** An event is a page's answers at most; a hand-over a wizard and its run. */
const BODY_LIMIT = 4 * 1024 * 1024;

const CALL_PATH = new RegExp(`^${PEER_RUNS_PATH}/([^/]+)/([^/]+)$`);

export class RunObject {
  private readonly storage: RunStorage;
  /** One thing at a time moves the run: each job waits for the one before. */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly followers = new Set<() => void>();
  private readonly watchdogMs: number;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: EdgeEnv,
  ) {
    this.storage = new RunStorage(ctx.storage);
    const ms = Number(env.WATCHDOG_MS);
    this.watchdogMs = Number.isFinite(ms) && ms > 0 ? ms : WATCHDOG_MS;
  }

  async fetch(request: Request): Promise<Response> {
    try {
      return await this.answer(request);
    } catch (err) {
      if (err instanceof Refusal) {
        return json(err.status, {
          error: err.message,
          ...(err.fields === undefined ? {} : { fields: err.fields }),
        });
      }
      console.error("[edge] a call of the run's object:", err);
      return json(500, { error: "The run's object failed." });
    }
  }

  /** The run's alarm: its work, its time, its watchdog, a copy sent again. */
  async alarm(): Promise<void> {
    await this.enqueue(async () => {
      const s = await this.storage.run();
      if (!s) {
        await this.ctx.storage.deleteAlarm();
        return;
      }
      await this.reportAgain(s);
      if (s.run.status === "running") {
        await this.drive("alarm", async () => ({ kind: "resume" }));
      } else if (WAITS.has(s.run.status) && s.run.wakeAt !== null && s.run.wakeAt <= Date.now()) {
        await this.drive("alarm", async () => ({ kind: "woke" }));
      } else {
        await this.plan("rest");
      }
    });
  }

  private async answer(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const [, encoded, call] = url.pathname.match(CALL_PATH) ?? [];
    if (!call) {
      throw new Refusal(404, "Not found.");
    }
    const runId = decodeURIComponent(encoded);
    if (call === HAND_OVER && request.method === "POST") {
      return this.handOver(request, runId);
    }
    const held = await this.storage.held();
    if (!held || held.runId !== runId) {
      throw new Refusal(404, "This object holds no such run.");
    }
    if (!sameSecret(bearerOf(request), held.token)) {
      throw new Refusal(401, "unauthorized");
    }
    if (call === "state" && request.method === "GET") {
      return json(200, await this.state());
    }
    if (call === "changes" && request.method === "GET") {
      return this.changes(request, url.searchParams);
    }
    if (call === "events" && request.method === "POST") {
      return this.events(request);
    }
    throw new Refusal(404, "Not found.");
  }

  // --- the hand-over ----------------------------------------------------------------------------

  private async handOver(request: Request, runId: string): Promise<Response> {
    const token = bearerOf(request);
    const parsed = handOverSchema.safeParse(await bodyOf(request));
    if (!parsed.success) {
      throw new Refusal(400, issueOf(parsed.error));
    }
    const given = parsed.data;
    if (given.runId !== runId) {
      throw new Refusal(400, "The hand-over names another run.");
    }
    // Its token is its Bearer: the object cannot check the token's signature, the run's services
    // do on every call.
    if (!token || !sameSecret(token, given.token)) {
      throw new Refusal(401, "unauthorized");
    }
    return this.enqueue(async () => {
      const held = await this.storage.held();
      if (held) {
        // The same hand-over again (its answer was lost): the run is here already.
        if (sameSecret(held.token, given.token)) {
          return json(202, { rev: (await this.storage.run())?.rev ?? given.run.rev });
        }
        throw new Refusal(409, "This object holds the run already, with another token.");
      }
      const { rev, ...run } = given.run;
      await this.storage.hold(
        { runId, token: given.token, def: given.definition, files: given.files },
        { rev, run },
      );
      if (run.cursor === null) {
        // A run that has not started: its start is made here.
        await this.drive("door", async (call) => {
          await call.line(null, "run_started", note("runStarted"));
          return { kind: "start" };
        });
      } else {
        await this.plan("rest");
      }
      return json(202, { rev: (await this.storage.run())?.rev ?? rev });
    });
  }

  // --- the three calls --------------------------------------------------------------------------

  private async state(): Promise<HostState> {
    const s = await this.stored();
    const error = s.run.status === "failed" ? await this.storage.error() : null;
    return {
      run: { ...s.run, rev: s.rev },
      event: await this.storage.lastLine(),
      error: error === null ? null : saidText(error, "en"),
      // Nothing here asks the person while a step works.
      ask: null,
    };
  }

  private async events(request: Request): Promise<Response> {
    const parsed = hostEventSchema.safeParse(await bodyOf(request));
    if (!parsed.success) {
      throw new Refusal(400, issueOf(parsed.error));
    }
    const { event, by } = parsed.data;
    if ((NOT_TAKEN as readonly string[]).includes(event.kind)) {
      throw new Refusal(400, `The run's object does not take "${event.kind}" from outside.`);
    }
    const rev = await this.enqueue(async () => {
      await this.drive("door", (call) => call.door(event, by));
      return (await this.stored()).rev;
    });
    return json(200, { rev });
  }

  private changes(request: Request, query: URLSearchParams): Response {
    const since = count(query.get("since"));
    const after = query.has("after") ? count(query.get("after")) : -1;
    if (since === null || after === null) {
      throw new Refusal(400, "since: a revision; after: a line of the log");
    }
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    let rev = since;
    let told = after;
    let open = true;
    let looking: Promise<void> = Promise.resolve();
    const end = () => {
      if (!open) {
        return;
      }
      open = false;
      this.followers.delete(look);
      clearInterval(keepAlive);
      writer.close().catch(() => undefined);
    };
    /** What changed since the last line it wrote: the revision, the log's new lines. */
    function look(this: void) {
      looking = looking.then(lookNow).catch(end);
    }
    const lookNow = async () => {
      if (told < 0) {
        // Without `after`: from the log's newest line.
        told = await this.storage.lastLine();
      }
      for (;;) {
        if (!open) {
          return;
        }
        const s = await this.stored();
        const events = await this.storage.linesAfter(told);
        if (s.rev === rev && !events.length) {
          return;
        }
        rev = s.rev;
        told = events.at(-1)?.id ?? told;
        const change: HostChange = { rev, events };
        await writer.write(encoder.encode(`${JSON.stringify(change)}\n`));
        if (!events.length) {
          return;
        }
      }
    };
    const keepAlive = setInterval(() => {
      writer.write(encoder.encode("\n")).catch(end);
    }, KEEP_ALIVE_MS);
    this.followers.add(look);
    request.signal?.addEventListener("abort", end);
    look();
    return new Response(readable, {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  // --- the run's work ---------------------------------------------------------------------------

  /**
   * One call of the run: `take` turns what came (the alarm, a door's event) into the event the
   * flow moves the run with, or null when nothing more moves. An alarm call makes at most one
   * model call, a door's none.
   */
  private async drive(
    kind: "alarm" | "door",
    take: (call: ObjectCall) => Promise<FlowEvent | null>,
  ): Promise<Ended> {
    const held = await this.storage.held();
    if (!held) {
      return "rest";
    }
    const started = Date.now();
    const call = await objectCall({
      storage: this.storage,
      held,
      services: httpServices({ url: this.env.SERVICES_URL, token: held.token }),
      models: kind === "alarm" ? 1 : 0,
      now: Date.now,
      tell: () => this.tell(),
      wentOn: kind === "alarm" && (await this.storage.takeYielded()),
    });
    const before = await call.stored();
    // The watchdog: should the object stop in the middle of this call, its alarm finds the run as
    // the call left it.
    await this.ctx.storage.setAlarm(Date.now() + this.watchdogMs);
    const watchdog = setInterval(
      () => {
        this.ctx.storage.setAlarm(Date.now() + this.watchdogMs).catch(() => undefined);
      },
      Math.max(1000, this.watchdogMs / 3),
    );
    let ended: Ended = "rest";
    try {
      const event = await take(call);
      if (event) {
        await advance(call.host, event);
      }
    } catch (err) {
      if (err instanceof Refusal) {
        throw err;
      }
      if (err instanceof FlowRefused) {
        throw new Refusal(409, `The run does not take this now (${err.code}).`);
      }
      if (!call.yielded) {
        ended = "error";
        console.error(`[run ${held.runId}] the ${kind} call failed:`, err);
      }
    } finally {
      clearInterval(watchdog);
      if (call.yielded) {
        ended = "yield";
        await this.storage.setYielded();
      } else if (ended === "rest") {
        const after = await call.stored();
        if (after.rev === before.rev && WAITS.has(after.run.status)) {
          const due = after.run.wakeAt !== null && after.run.wakeAt <= Date.now();
          ended = due ? "still" : "rest";
        } else if (kind === "alarm" && after.rev === before.rev && after.run.status === "running") {
          // At work and nothing moved: not again at once.
          ended = "error";
        }
      }
      console.log(
        `[run ${held.runId}] ${kind} call: ${JSON.stringify({ models: call.made, ms: Date.now() - started, ended })}`,
      );
      await this.plan(ended);
    }
    return ended;
  }

  /** The one alarm, from the run as stored: the earliest of its work, its time and a copy due. */
  private async plan(ended: Ended): Promise<void> {
    const s = await this.storage.run();
    const now = Date.now();
    let at: number | null = null;
    if (s?.run.status === "running") {
      at = ended === "error" ? now + AGAIN_AFTER_ERROR_MS : now;
    } else if (s && WAITS.has(s.run.status) && s.run.wakeAt !== null) {
      at = ended === "still" ? now + LOOK_AGAIN_MS : s.run.wakeAt;
    }
    if ((await this.storage.unreported()) !== null) {
      at = Math.min(at ?? Number.POSITIVE_INFINITY, now + REPORT_AGAIN_MS);
    }
    if (at === null) {
      await this.ctx.storage.deleteAlarm();
    } else {
      await this.ctx.storage.setAlarm(at);
    }
  }

  /** A copy of the run that did not reach the tenant: the run as it is now goes instead. */
  private async reportAgain(s: StoredRun): Promise<void> {
    const unreported = await this.storage.unreported();
    const held = await this.storage.held();
    if (unreported === null || !held) {
      return;
    }
    const error = s.run.status === "failed" ? await this.storage.error() : null;
    try {
      await httpServices({ url: this.env.SERVICES_URL, token: held.token }).run.report({
        status: s.run.status,
        cursor: s.run.cursor,
        state: s.run.state,
        wakeAt: s.run.wakeAt,
        rev: s.rev,
        ...(error === null ? {} : { error }),
      });
      await this.storage.setUnreported(null);
    } catch (err) {
      console.error(`[run ${held.runId}] the copy at the tenant, again:`, err);
    }
  }

  private async stored(): Promise<StoredRun> {
    const s = await this.storage.run();
    if (!s) {
      throw new Refusal(404, "This object holds no run.");
    }
    return s;
  }

  private tell() {
    for (const look of this.followers) {
      look();
    }
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const done = this.queue.then(job);
    this.queue = done.catch(() => undefined);
    return done;
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function bearerOf(request: Request): string {
  return request.headers.get("authorization")?.match(/^Bearer\s+(\S+)\s*$/i)?.[1] ?? "";
}

/** The two secrets are the same, compared in a time that does not tell where they differ. */
function sameSecret(given: string, wanted: string): boolean {
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(wanted);
  let differs = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) {
    differs |= (a[i] ?? 0) ^ b[i];
  }
  return differs === 0 && b.length > 0;
}

async function bodyOf(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.length > BODY_LIMIT) {
    throw new Refusal(400, "The request is too large.");
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function issueOf(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  const issue = error.issues[0];
  return `${issue?.path.map(String).join(".") || "body"}: ${issue?.message ?? "not valid"}`;
}

function count(value: string | null): number | null {
  const n = Number(value);
  return value !== null && value !== "" && Number.isInteger(n) && n >= 0 ? n : null;
}
