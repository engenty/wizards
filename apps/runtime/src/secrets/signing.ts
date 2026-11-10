import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
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

/** `runViewTicket` for a mail about a run's end: it lasts as long as the run is kept. */
export function runViewTicketUntil(runId: string, until: Date): string {
  const exp = String(Math.floor(until.getTime() / 1000));
  return `${exp}.${sign(`run-view:${runId}|${exp}`)}`;
}

/**
 * What a run's token says (docs/plans/runs-on-their-own.md, "Record, state, token"): the run, its
 * tenant and where it reads and writes. The grant is not in it: it stays on the run.
 */
export const runClaimsSchema = z
  .object({
    /** The token's id, kept on the run (`run.token_id`). */
    jti: z.string().min(1),
    tenant: z.string().min(1),
    run: z.string().min(1),
    wizard: z.string().min(1),
    /** The wizard's space. */
    space: z.string().min(1),
    /** Where the run's data is: the client space it was started in, else `space`. */
    dataSpace: z.string().min(1),
    mode: z.enum(["test", "live"]),
    /** Whose the run is, as the store names them (`holderOf`): `u:`, `v:` or `r:` and an id. */
    holder: z.string().min(1),
    /** The kind of host the run lives on. */
    host: z.enum(["runtime"]),
    /** Seconds since the epoch. */
    exp: z.number().int(),
  })
  .strict();

export type RunClaims = z.infer<typeof runClaimsSchema>;

const runTokenData = (body: string) => `run-token:${body}`;

/**
 * A run's token: its claims, readable, and their signature. The same claims sign the same token,
 * so the runtime signs it again from the run instead of keeping it (broker/token.ts).
 */
export function runToken(claims: RunClaims): string {
  const body = Buffer.from(JSON.stringify(runClaimsSchema.parse(claims))).toString("base64url");
  return `${body}.${sign(runTokenData(body))}`;
}

/** Why a token is refused before its run is read. */
export type RunTokenFault = "malformed" | "signature" | "expired";

/**
 * The claims of a token this runtime signed and that has not expired, else why not. It reads no
 * run: `readRunToken` (broker/token.ts) does that as well.
 */
export function runTokenClaims(token: string): { claims: RunClaims } | { refused: RunTokenFault } {
  const [body, sig, ...rest] = token.split(".");
  if (!body || !sig || rest.length) {
    return { refused: "malformed" };
  }
  if (!sameSignature(runTokenData(body), sig)) {
    return { refused: "signature" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { refused: "malformed" };
  }
  const claims = runClaimsSchema.safeParse(parsed);
  if (!claims.success) {
    return { refused: "malformed" };
  }
  if (claims.data.exp * 1000 < Date.now()) {
    return { refused: "expired" };
  }
  return { claims: claims.data };
}
