import { createHmac, timingSafeEqual } from "node:crypto";
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
