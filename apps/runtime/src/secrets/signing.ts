import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../env.js";

/** The query the signature covers: everything but exp/sig, sorted, so parameter order never matters. */
function payload(url: URL, exp: string): string {
  const params = [...url.searchParams.entries()]
    .filter(([k]) => k !== "exp" && k !== "sig")
    .sort(([a], [b]) => a.localeCompare(b));
  return `${url.pathname}?${new URLSearchParams(params)}|${exp}`;
}

function sign(data: string): string {
  return createHmac("sha256", env.authSecret).update(data).digest("base64url");
}

/**
 * A link that opens one GET path without a session — for clients that have no studio cookie,
 * such as an MCP client handing a download to the admin.
 */
export function signedUrl(path: string, ttlSeconds = 3600): string {
  const url = new URL(path, env.appUrl);
  const exp = String(Math.floor(Date.now() / 1000) + ttlSeconds);
  url.searchParams.set("exp", exp);
  url.searchParams.set("sig", sign(payload(url, exp)));
  return url.toString();
}

function sameSignature(data: string, sig: string): boolean {
  const expected = Buffer.from(sign(data));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function verifySignedUrl(href: string): boolean {
  const url = new URL(href, env.appUrl);
  const exp = url.searchParams.get("exp");
  const sig = url.searchParams.get("sig");
  if (!exp || !sig || Number(exp) * 1000 < Date.now()) {
    return false;
  }
  return sameSignature(payload(url, exp), sig);
}

/**
 * One of this runtime's processes asks a runner to take a run now (`kick` in a process without a
 * runner). Good for a minute; the processes share `authSecret`, nobody else has it.
 */
export function peerTicket(runId: string, tenant: string): string {
  const exp = String(Math.floor(Date.now() / 1000) + 60);
  return `${exp}.${sign(`take:${tenant}:${runId}|${exp}`)}`;
}

export function peerTicketValid(
  runId: string,
  tenant: string,
  ticket: string | undefined,
): boolean {
  const [exp, sig] = (ticket ?? "").split(".");
  if (!exp || !sig || Number(exp) * 1000 < Date.now()) {
    return false;
  }
  return sameSignature(`take:${tenant}:${runId}|${exp}`, sig);
}

/**
 * A ticket to one run's routes without a session: the widget an AI app shows runs on the host's
 * origin and reaches the run with it. Sent as `?rt=`, since an EventSource sends no headers.
 */
export function runTicket(runId: string, ttlSeconds = 12 * 3600): string {
  const exp = String(Math.floor(Date.now() / 1000) + ttlSeconds);
  return `${exp}.${sign(`run:${runId}|${exp}`)}`;
}

export function runTicketValid(runId: string, ticket: string | undefined): boolean {
  const [exp, sig] = (ticket ?? "").split(".");
  if (!exp || !sig || Number(exp) * 1000 < Date.now()) {
    return false;
  }
  return sameSignature(`run:${runId}|${exp}`, sig);
}

/**
 * A ticket that only reads one run: its view, its stream, its downloads. A client of the
 * organization gets one for a run the firm shared with them (docs/plans/client-portal.md): they
 * see it, they do not steer it.
 */
export function runViewTicket(runId: string, ttlSeconds = 12 * 3600): string {
  const exp = String(Math.floor(Date.now() / 1000) + ttlSeconds);
  return `${exp}.${sign(`run-view:${runId}|${exp}`)}`;
}

export function runViewTicketValid(runId: string, ticket: string | undefined): boolean {
  const [exp, sig] = (ticket ?? "").split(".");
  if (!exp || !sig || Number(exp) * 1000 < Date.now()) {
    return false;
  }
  return sameSignature(`run-view:${runId}|${exp}`, sig);
}

/**
 * The ticket in a visitor's mail while their run waits: it reads the run and answers it, and
 * nothing else (`accessibleRun`'s `waiting`). It lasts as long as the wait can, so it opens less
 * than `runTicket`. `until` comes from the run, so the same mail signs the same link again.
 */
export function runWaitTicket(runId: string, until: Date): string {
  const exp = String(Math.floor(until.getTime() / 1000));
  return `${exp}.${sign(`run-wait:${runId}|${exp}`)}`;
}

export function runWaitTicketValid(runId: string, ticket: string | undefined): boolean {
  const [exp, sig] = (ticket ?? "").split(".");
  if (!exp || !sig || Number(exp) * 1000 < Date.now()) {
    return false;
  }
  return sameSignature(`run-wait:${runId}|${exp}`, sig);
}

/**
 * The key of one tenant's runner for the broker (docs/plans/kernel.md, item 24): what it signs
 * with, for that tenant alone. The broker makes it again from its secret to check a ticket.
 */
export function brokerKeyOf(tenant: string, secret = env.broker.secret): string {
  return createHmac("sha256", secret).update(`broker:${tenant}`).digest("hex");
}

export type BrokerPurpose = "call" | "connected" | "gateway";

/** What a broker ticket covers: what it is for, the tenant, the body where it has one. */
function brokerPayload(purpose: BrokerPurpose, tenant: string, body: string | null, exp: string) {
  const hash = body === null ? "-" : createHash("sha256").update(body).digest("base64url");
  return `${purpose}:${tenant}:${hash}|${exp}`;
}

/**
 * A tenant runner's ticket to the broker: a call with its body, or the model gateway with none (a
 * stream). Good for a minute; the gateway's for an hour, which a model call may stream that long.
 */
export function brokerTicket(purpose: BrokerPurpose, tenant: string, body: string | null): string {
  const exp = String(Math.floor(Date.now() / 1000) + (purpose === "gateway" ? 3600 : 60));
  const sig = createHmac("sha256", env.broker.key)
    .update(brokerPayload(purpose, tenant, body, exp))
    .digest("base64url");
  return `${exp}.${sig}`;
}

/** Whether a broker ticket is one the runner of `tenant` signed. Without the secret, none is. */
export function brokerTicketValid(
  purpose: BrokerPurpose,
  tenant: string,
  body: string | null,
  ticket: string | undefined,
): boolean {
  const [exp, sig] = (ticket ?? "").split(".");
  if (!env.broker.secret || !exp || !sig || Number(exp) * 1000 < Date.now()) {
    return false;
  }
  const expected = Buffer.from(
    createHmac("sha256", brokerKeyOf(tenant))
      .update(brokerPayload(purpose, tenant, body, exp))
      .digest("base64url"),
  );
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** `runViewTicket` for a mail about a run's end: it lasts as long as the run is kept. */
export function runViewTicketUntil(runId: string, until: Date): string {
  const exp = String(Math.floor(until.getTime() / 1000));
  return `${exp}.${sign(`run-view:${runId}|${exp}`)}`;
}
