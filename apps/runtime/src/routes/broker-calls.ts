import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { answerRemoteCall, type RemoteCall } from "../broker/remote.js";
import { withTenant } from "../db/client.js";
import { brokerTicketValid } from "../secrets/signing.js";

/*
 * `POST /api/broker/v1/call`: a connection call another process of this runtime hands the broker
 * (broker/remote.ts), where that process opens no connected account. A ticket signed with the
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
