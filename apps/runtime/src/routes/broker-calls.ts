import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { answerRemoteCall, type RemoteCall } from "../broker/remote.js";
import { withTenant } from "../db/client.js";
import { runStore } from "../engine/run-store.js";
import { brokerTicketValid } from "../secrets/signing.js";
import { type HandedShare, workShare } from "../sharing/jobs.js";

/*
 * What another process of this runtime hands the broker, where that process opens no connected
 * account: `POST /api/broker/v1/call`, a connection call (broker/remote.ts), and
 * `POST /api/broker/v1/share`, a share job it stood up (sharing/jobs.ts). A ticket signed with the
 * runtime's secret for the tenant and the body (secrets/signing.ts, `brokerTicket`) lets it in.
 */
export const brokerCallRoutes = new Hono();

brokerCallRoutes.post(
  "/call",
  bodyLimit({
    // A share's files travel in the body, as base64.
    maxSize: 64 * 1024 * 1024,
    onError: (c) => c.json({ error: "The body is too large." }, 413),
  }),
  async (c) => {
    const tenant = c.req.header("x-wizards-tenant") ?? "";
    const body = await c.req.text();
    if (!tenant || !brokerTicketValid(tenant, body, c.req.header("x-wizards-ticket"))) {
      return c.json({ error: "The call has no valid ticket." }, 401);
    }
    const call = JSON.parse(body) as RemoteCall;
    return c.json(await withTenant(tenant, () => answerRemoteCall(call)));
  },
);

brokerCallRoutes.post("/share", bodyLimit({ maxSize: 4 * 1024 }), async (c) => {
  const tenant = c.req.header("x-wizards-tenant") ?? "";
  const body = await c.req.text();
  if (!tenant || !brokerTicketValid(tenant, body, c.req.header("x-wizards-ticket"))) {
    return c.json({ error: "The job has no valid ticket." }, 401);
  }
  const handed = JSON.parse(body) as HandedShare;
  return withTenant(tenant, async () => {
    const run = await runStore.get(handed.runId);
    if (!run) {
      return c.json({ error: "The run isn't there." }, 404);
    }
    await workShare(run, handed.jobId, handed.member);
    return c.json({ ok: true });
  });
});
