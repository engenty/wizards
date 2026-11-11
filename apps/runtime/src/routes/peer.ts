import {
  HAND_OVER,
  type HostActor,
  type HostChange,
  type HostSendable,
  type HostState,
  handOverSchema,
  hostEventSchema,
  type PageSent,
  TENANT_HEADER,
} from "@engenty/wizards-engine/host-api";
import { fieldErrorsIn } from "@engenty/wizards-engine/input";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { readRunToken } from "../broker/token.js";
import { withTenant } from "../db/client.js";
import { localChanges, NotTaken, runHostsOn, takeEvent } from "../engine/run-host-client.js";
import { runStore } from "../engine/run-store.js";
import { flowRun, kick, loadRun, RunConflict, RunInputError, takeNow } from "../engine/runner.js";
import { env } from "../env.js";
import { feature } from "../features.js";
import { errorText } from "../model-errors.js";
import { peerTicketValid } from "../secrets/signing.js";
import { notFoundAnswer, requestLang } from "./lang.js";

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
 * The run's changes past revision `since` and log line `after`, one JSON line each (`HostChange`),
 * as `localChanges` finds them. Called in the run's tenant: the stream is read there.
 */
function changesOf(runId: string, since: number, after: number, signal: AbortSignal): Response {
  const encoder = new TextEncoder();
  const abort = new AbortController();
  const stop = () => abort.abort();
  signal.addEventListener("abort", stop, { once: true });
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  const body = new ReadableStream<Uint8Array>({
    // Called at once, inside the tenant: every look after it runs there too.
    start(controller) {
      const write = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          stop();
        }
      };
      keepAlive = setInterval(() => write("\n"), KEEP_ALIVE_MS);
      keepAlive.unref?.();
      void (async () => {
        try {
          for await (const change of localChanges(runId, since, after, abort.signal)) {
            write(`${JSON.stringify(change satisfies HostChange)}\n`);
          }
        } catch (err) {
          console.error(`[run ${runId}] changes:`, err);
        } finally {
          clearInterval(keepAlive);
          signal.removeEventListener("abort", stop);
          try {
            controller.close();
          } catch {
            // The caller went away.
          }
        }
      })();
    },
    cancel() {
      clearInterval(keepAlive);
      stop();
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

/** A wait whose time can come now: the clock's when it is due, "Continue now" before. */
const WAKES = new Set(["sleeping", "waiting_signal", "waiting_input"]);

/**
 * Takes an event as the doors take it (`takeEvent`), with what only a caller from outside asks:
 * "try again" on a run at work puts it in line, and a wake that is due, or that names nobody, is
 * the clock's (the tenant's clock, engine/run-host-client.ts `wakeElsewhere`): the run looks, and
 * one whose time has not come puts it back, as for a wake of the clock here.
 */
async function take(runId: string, event: HostSendable, by?: HostActor, page?: PageSent) {
  if (event.kind === "resume") {
    const run = await loadRun(runId);
    if (run?.status === "running") {
      kick(runId);
      return false;
    }
  }
  if (event.kind === "woke") {
    const run = await loadRun(runId);
    if (!(run && WAKES.has(run.status) && run.wakeAt)) {
      throw new RunConflict({ code: "runMovedOn" });
    }
    if (!by?.name || run.wakeAt.getTime() <= Date.now()) {
      kick(runId);
      return false;
    }
  }
  return takeEvent(runId, event, by, page);
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
        return c.json(notFoundAnswer(c), 404);
      }
      const event = (await runStore.lastChange(runId))?.event ?? 0;
      return c.json({
        run: { ...flowRun(run), rev: run.rev },
        event,
        error: run.error,
        ask: run.ask,
      } satisfies HostState);
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
      const { event, by, page } = parsed.data;
      const lang = requestLang(c);
      let already: boolean;
      try {
        already = await take(runId, event, by, page);
      } catch (err) {
        if (err instanceof NotTaken) {
          return c.json({ error: err.message }, 400);
        }
        // The text in the request's language, and what it says before words, for a door that
        // puts it in its own.
        if (err instanceof RunInputError) {
          return c.json(
            {
              error: errorText(err, lang),
              fields: fieldErrorsIn(err.errors, lang),
              errors: err.errors,
            },
            422,
          );
        }
        if (err instanceof RunConflict) {
          return c.json(
            { error: errorText(err, lang), said: err.note ?? err.line ?? err.message },
            409,
          );
        }
        throw err;
      }
      const rev = (await runStore.pick(runId, "rev"))?.rev ?? 0;
      return c.json({ rev, ...(already ? { already } : {}) });
    }),
  );
