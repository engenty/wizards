/** Stand-in for `@engenty/web-ingest`: its host guard, and this product's HTML to Markdown. */
import { isPublicAddress } from "../../tools/net-guard.js";
import {
  assertPublicHttpHost as assertHost,
  isBlockedIp as blockedIp,
  type LookupFn,
} from "../web-ingest/ssrf.js";

export { htmlToMarkdown } from "../../render/convert.js";
export type { LookupFn };

/**
 * The copied guard misses IPv6 forms of private IPv4 addresses (NAT64, 6to4, ::a.b.c.d) and some
 * special ranges; every address it lets through is checked again with the runtime's own range check.
 */
export function isBlockedIp(ip: string): boolean {
  return blockedIp(ip) || !isPublicAddress(ip);
}

export async function assertPublicHttpHost(
  urlString: string,
  lookupImpl?: LookupFn,
): Promise<{ url: URL; addresses: string[] }> {
  const result = await assertHost(urlString, lookupImpl);
  const bad = result.addresses.find((a) => !isPublicAddress(a));
  if (bad) {
    throw new Error(`URL host is not allowed for fetch: ${result.url.hostname} (${bad})`);
  }
  return result;
}
