import {
  HAND_OVER,
  type HostChange,
  type HostState,
  handOverSchema,
  hostEventSchema,
  TENANT_HEADER,
} from "@engenty/wizards-engine/host-api";
import { fieldErrorsIn } from "@engenty/wizards-engine/input";
import type { StepOutput } from "@engenty/wizards-shared/run";
import type { FlowEvent } from "@engenty/wizards-shared/transition";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { readRunToken } from "../broker/token.js";
import { withTenant } from "../db/client.js";
import { eventsAfter, watchRun } from "../engine/events.js";
import type { Actor } from "../engine/notices.js";
import { runStore } from "../engine/run-store.js";
import {
  cancel,
  flowRun,
  goBack,
  kick,
  loadRun,
  type ReviewAction,
  RunConflict,
  RunInputError,
  retry,
  reviewStep,
  submitPage,
  takeNow,
  wakeNow,
} from "../engine/runner.js";
import { env } from "../env.js";
import { feature, remoteFeatures } from "../features.js";
import { errorText } from "../model-errors.js";
import { peerTicketValid } from "../secrets/signing.js";
import { notFoundAnswer, requestLang } from "./lang.js";

/** Whether a run may live on a host other than this runtime, for the tenant at hand. */
export async function runHostsOn(): Promise<boolean> {
  return feature("runHosts", await remoteFeatures().catch(() => null));
}

const bearer = (c: Context) => c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
const tenantSchema = z.string().min(1).max(80);

/**
 * A host's call with its ticket checked and the run's tenant open: the tenant comes from the
 * header the ticket signs, nothing else. A ticket that opens nothing is a 401, unless this
 * runtime has no runs on other hosts at all; inside the tenant its own switch decides.
 */
async function asHost(c: Context, work: (runId: string) => Promise<Response>): Promise<Response> {
  const runId = c.req.param("id") ?? "";
  const tenant = tenantSchema.safeParse(c.req.header(TENANT_HEADER));
  if (!(tenant.success && peerTicketValid(runId, tenant.data, bearer(c)))) {
    return feature("runHosts")
      ? c.json({ error: "unauthorized" }, 401)
      : c.json(notFoundAnswer(c), 404);
  }
  return withTenant(tenant.data, async () => {
    if (!(await runHostsOn())) {
      return c.json(notFoundAnswer(c), 404);
    }
    return work(runId);
  });
}

/** How often a held-open stream of changes says something, if only a blank line. */
const KEEP_ALIVE_MS = 15_000;

/**
 * The run's changes past revision `since` and log line `after`, one JSON line each (`HostChange`).
 * Each look reads the row's revision and the lines since the last one sent; `watchRun` says when
 * to look, also for what another process wrote. Called in the run's tenant.
 */
function changesOf(runId: string, since: number, after: number, signal: AbortSignal): Response {
  const encoder = new TextEncoder();
  let rev = since;
  let told = after;
  let closed = false;
  let busy = false;
  let again = false;
  const cleanups: (() => void)[] = [];
  const body = new ReadableStream<Uint8Array>({
    // Called at once, inside the tenant: every look after it runs there too.
    start(controller) {
      const close = () => {
        if (closed) {
          return;
        }
        closed = true;
        for (const cleanup of cleanups) {
          cleanup();
        }
        try {
          controller.close();
        } catch {
          // The caller went away.
        }
      };
      const write = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          close();
        }
      };
      const look = async () => {
        if (closed) {
          return;
        }
        if (busy) {
          again = true;
          return;
        }
        busy = true;
        try {
          do {
            again = false;
            const row = await runStore.pick(runId, "rev");
            if (!row) {
              close();
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
              write(`${JSON.stringify({ rev, events } satisfies HostChange)}\n`);
            }
          } while (again && !closed);
        } catch (err) {
          console.error(`[run ${runId}] changes:`, err);
        } finally {
          busy = false;
        }
      };
      cleanups.push(watchRun(runId, () => void look()));
      const keepAlive = setInterval(() => {
        write("\n");
        void look();
      }, KEEP_ALIVE_MS);
      keepAlive.unref?.();
      cleanups.push(() => clearInterval(keepAlive));
      signal.addEventListener("abort", close, { once: true });
      cleanups.push(() => signal.removeEventListener("abort", close));
      void look();
    },
    cancel() {
      closed = true;
      for (const cleanup of cleanups) {
        cleanup();
      }
    },
  });
  return new Response(body, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
}

/** A refusal of an event the host does not take from outside, or not with what it carries. */
class NotTaken extends Error {}

/** A review's answer as the doors give it: an edited output goes as its text or its data. */
function reviewOf(event: Extract<FlowEvent, { kind: "reviewed" }>): ReviewAction {
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

/** A wait whose time can come now: the clock's when it is due, "Continue now" before. */
const WAKES = new Set(["sleeping", "waiting_signal", "waiting_input"]);

/**
 * Takes an event the way the doors take it, through the runner's own functions: a page's answer,
 * a review, back, try again, the clock, cancel. What the host makes itself while it drives
 * (`start`, `stepDone`, `stepFailed`, `decided`) and a signal (stored at the tenant first, then
 * taken by the wait) are not taken here.
 */
async function take(runId: string, event: FlowEvent, by: Actor | undefined, name?: string) {
  switch (event.kind) {
    case "answered":
      await submitPage(runId, event.stepId, event.values, by);
      return;
    case "reviewed":
      await reviewStep(runId, event.stepId, reviewOf(event), by);
      return;
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
        by,
      );
      return;
    case "back":
      await goBack(runId, by);
      return;
    case "cancel":
      await cancel(runId);
      return;
    case "resume": {
      const run = await loadRun(runId);
      if (run?.status === "failed") {
        await retry(runId);
      } else if (run?.status === "running") {
        kick(runId);
      } else {
        throw new RunConflict({ code: "runMovedOn" });
      }
      return;
    }
    case "woke": {
      const run = await loadRun(runId);
      if (!(run && WAKES.has(run.status) && run.wakeAt)) {
        throw new RunConflict({ code: "runMovedOn" });
      }
      if (run.wakeAt.getTime() <= Date.now()) {
        kick(runId);
      } else if (name) {
        await wakeNow(runId, name);
      } else {
        throw new NotTaken("A wake before its time says who asked for it (by.name).");
      }
      return;
    }
    default:
      throw new NotTaken(`The run's host does not take "${event.kind}" from outside.`);
  }
}

/**
 * Calls between this runtime's own processes, with a ticket signed by the secret they share
 * (`peerTicket`). Nobody else can make one.
 *
 * `/runs/:id/{state,changes,events}`: the run's host, reached by a process that does not hold the
 * run (packages/engine/src/host-api.ts has the wire and the client). Only with `runHosts` on.
 */
export const peerRoutes = new Hono()
  // A process without a runner hands a run on at once, in place of the runner's next look.
  .post("/runs/:id/take", async (c) => {
    const runId = c.req.param("id");
    const { tenant } = z.object({ tenant: tenantSchema }).parse(await c.req.json());
    const ticket = bearer(c);
    if (!peerTicketValid(runId, tenant, ticket)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    return takeNow(runId, tenant) ? c.json({ ok: true }, 202) : c.json({ error: "no runner" }, 404);
  })
  // The tenant's runtime placed a new run on this process (`createRun`, engine/hosts.ts). The
  // run's token is the key: it names the tenant and the run, and the host's kind as the record
  // has it. A process of the same runtime reads the run from the tenant's database, so the state
  // handed over is the record's; it puts the run to work, as `kick` does where it was started.
  .post(`/runs/:id/${HAND_OVER}`, async (c) => {
    const runId = c.req.param("id");
    const token = bearer(c) ?? "";
    const read = await readRunToken(token);
    if ("refused" in read || read.claims.run !== runId || read.claims.host !== "runtime") {
      return feature("runHosts")
        ? c.json({ error: "unauthorized" }, 401)
        : c.json(notFoundAnswer(c), 404);
    }
    return withTenant(read.claims.tenant, async () => {
      if (!(await runHostsOn())) {
        return c.json(notFoundAnswer(c), 404);
      }
      const given = handOverSchema.safeParse(await c.req.json().catch(() => undefined));
      if (!given.success || given.data.runId !== runId || given.data.token !== token) {
        return c.json({ error: "Not a hand-over of this run." }, 400);
      }
      const run = await runStore.pick(runId, "host", "status");
      // A run the record keeps on the tenant's own runtime was not placed anywhere.
      if (run?.host?.kind !== "runtime") {
        return c.json({ error: "The run is not placed on another runtime." }, 409);
      }
      if (!env.serves.runner) {
        return c.json({ error: "no runner" }, 404);
      }
      // A run at a person's step waits for its event; one that runs goes in line here now.
      if (run.status === "running") {
        kick(runId);
      }
      return c.json({ ok: true }, 202);
    });
  })
  .get("/runs/:id/state", (c) =>
    asHost(c, async (runId) => {
      const run = await runStore.pick(runId, "cursor", "status", "state", "wakeAt", "rev");
      if (!run) {
        return c.json(notFoundAnswer(c), 404);
      }
      const event = (await runStore.lastChange(runId))?.event ?? 0;
      return c.json({ run: { ...flowRun(run), rev: run.rev }, event } satisfies HostState);
    }),
  )
  .get("/runs/:id/changes", (c) =>
    asHost(c, async (runId) => {
      const query = z
        .object({
          since: z.coerce.number().int().nonnegative(),
          after: z.coerce.number().int().nonnegative().optional(),
        })
        .safeParse({ since: c.req.query("since"), after: c.req.query("after") });
      if (!query.success) {
        return c.json({ error: "since: a revision; after: a line of the log" }, 400);
      }
      const last = await runStore.lastChange(runId);
      if (!last) {
        return c.json(notFoundAnswer(c), 404);
      }
      return changesOf(
        runId,
        query.data.since,
        query.data.after ?? last.event ?? 0,
        c.req.raw.signal,
      );
    }),
  )
  .post("/runs/:id/events", (c) =>
    asHost(c, async (runId) => {
      const parsed = hostEventSchema.safeParse(await c.req.json().catch(() => undefined));
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return c.json(
          { error: `${issue?.path.join(".") || "body"}: ${issue?.message ?? "not an event"}` },
          400,
        );
      }
      if (!(await runStore.pick(runId, "id"))) {
        return c.json(notFoundAnswer(c), 404);
      }
      const { event, by } = parsed.data;
      const actor: Actor | undefined = by
        ? { userId: by.userId ?? null, visitorId: by.visitorId ?? null }
        : undefined;
      const lang = requestLang(c);
      try {
        await take(runId, event, actor, by?.name);
      } catch (err) {
        if (err instanceof NotTaken) {
          return c.json({ error: err.message }, 400);
        }
        if (err instanceof RunInputError) {
          return c.json(
            { error: errorText(err, lang), fields: fieldErrorsIn(err.errors, lang) },
            422,
          );
        }
        if (err instanceof RunConflict) {
          return c.json({ error: errorText(err, lang) }, 409);
        }
        throw err;
      }
      const rev = (await runStore.pick(runId, "rev"))?.rev ?? 0;
      return c.json({ rev });
    }),
  );
