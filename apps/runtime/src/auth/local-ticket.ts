import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * A second way through the one-time link: a ticket signed with the data folder's secret, good
 * for a minute. Who can read that secret can already make the studio's cookie, so a ticket opens
 * nothing new — it lets the command line and the desktop app enter a runtime that already runs.
 */
const TTL_MS = 60_000;

/**
 * `local-enter` lets a browser in once; `local-mcp` is what `wizards mcp` signs each
 * request to the MCP endpoint with, so that no AI client's config has to hold a key;
 * `local-debug` is what `wizards report` and `wizards logs` sign theirs with; `local-run` is
 * what `wizards run` starts its runs with, the one signature that may take a run elsewhere.
 */
export type Purpose = "local-enter" | "local-mcp" | "local-debug" | "local-run";

/** The header `wizards mcp` signs its requests with, and the one naming its client. */
export const LOCAL_MCP_HEADER = "x-engenty-local";
export const LOCAL_CLIENT_HEADER = "x-engenty-client";

const sign = (secret: string, expires: number, purpose: Purpose) =>
  createHmac("sha256", secret).update(`${purpose}.${expires}`).digest("hex");

export function mintLocalTicket(
  secret: string,
  now = Date.now(),
  purpose: Purpose = "local-enter",
): string {
  const expires = now + TTL_MS;
  return `${expires}.${sign(secret, expires, purpose)}`;
}

/** When a ticket runs out, or null when it is not one of ours or already ran out. */
export function localTicketExpiry(
  secret: string,
  ticket: string,
  now = Date.now(),
  purpose: Purpose = "local-enter",
): number | null {
  const [head, signature] = ticket.split(".");
  const expires = Number(head);
  if (!signature || !Number.isSafeInteger(expires) || expires <= now || expires > now + TTL_MS) {
    return null;
  }
  const given = Buffer.from(signature);
  const expected = Buffer.from(sign(secret, expires, purpose));
  return given.length === expected.length && timingSafeEqual(given, expected) ? expires : null;
}
