import { type Context, Hono } from "hono";
import type { Who } from "../broker/call.js";
import {
  answerCall,
  answerConnected,
  type ConnectionRef,
  type RemoteCall,
} from "../broker/remote.js";
import { withTenant } from "../db/client.js";
import { env } from "../env.js";
import { type BrokerPurpose, brokerTicketValid } from "../secrets/signing.js";

/*
 * The broker's peer routes (RUNTIME_ROLE=broker, docs/plans/kernel.md item 24): what a runner of
 * one tenant asks of the process that holds the keys. Each request carries a ticket signed with
 * that tenant's key, and is answered in that tenant alone: a runner's ticket opens no other
 * tenant's database, account or credits.
 */

const TENANT = /^[A-Za-z0-9_-]{1,64}$/;

/** The tenant a request's ticket was signed for; null where it was not. */
function signedTenant(c: Context, purpose: BrokerPurpose, body: string | null): string | null {
  const tenant = c.req.header("x-wizards-tenant") ?? "";
  const ticket = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
  return TENANT.test(tenant) && brokerTicketValid(purpose, tenant, body, ticket) ? tenant : null;
}

/** Headers a hop sets for itself, and the two the broker sets in place of the runner's. */
const NOT_PASSED = [
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "authorization",
  "x-wizards-tenant",
];

export const brokerPeerRoutes = new Hono()
  // A connector call: decided, run and logged here, with the account only this process reads.
  .post("/broker/call", async (c) => {
    const body = await c.req.text();
    const tenant = signedTenant(c, "call", body);
    if (!tenant) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const call = JSON.parse(body) as RemoteCall;
    return c.json(await withTenant(tenant, () => answerCall(call)));
  })
  // Whether a connection holds an account, and as whom: never its secret.
  .post("/broker/connected", async (c) => {
    const body = await c.req.text();
    const tenant = signedTenant(c, "connected", body);
    if (!tenant) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const payload = JSON.parse(body) as { who: Who; connection: ConnectionRef };
    return c.json(await withTenant(tenant, () => answerConnected(payload)));
  })
  // The model gateway: the runner's request as it is, with the runtime's key and the tenant the
  // ticket names, so a model call is booked on that tenant and no other.
  .all("/gateway/*", async (c) => {
    const tenant = signedTenant(c, "gateway", null);
    if (!(tenant && env.manage.gatewayUrl)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const url = new URL(c.req.url);
    const rest = url.pathname.slice(url.pathname.indexOf("/gateway/") + "/gateway".length);
    const headers = new Headers(c.req.raw.headers);
    for (const name of NOT_PASSED) {
      headers.delete(name);
    }
    headers.set("authorization", `Bearer ${env.manage.serviceKey}`);
    headers.set("x-wizards-tenant", tenant);
    const method = c.req.method;
    const res = await fetch(`${env.manage.gatewayUrl}${rest}${url.search}`, {
      method,
      headers,
      ...(method === "GET" || method === "HEAD"
        ? {}
        : { body: c.req.raw.body, duplex: "half" as const }),
      signal: c.req.raw.signal,
    });
    const back = new Headers(res.headers);
    // The body comes as fetch read it: already unpacked, of a length it no longer says.
    back.delete("content-encoding");
    back.delete("content-length");
    return new Response(res.body, { status: res.status, headers: back });
  });
