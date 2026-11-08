import { Hono } from "hono";
import { z } from "zod";
import { takeNow } from "../engine/runner.js";
import { peerTicketValid } from "../secrets/signing.js";

/**
 * Calls between this runtime's own processes, with a ticket signed by the secret they share
 * (`peerTicket`). Nobody else can make one, and nothing here reads or writes a run's content.
 */
export const peerRoutes = new Hono()
  // A process without a runner hands a run on at once, in place of the runner's next look.
  .post("/runs/:id/take", async (c) => {
    const runId = c.req.param("id");
    const { tenant } = z.object({ tenant: z.string().min(1).max(80) }).parse(await c.req.json());
    const ticket = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
    if (!peerTicketValid(runId, tenant, ticket)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    return takeNow(runId, tenant) ? c.json({ ok: true }, 202) : c.json({ error: "no runner" }, 404);
  });
