/** Stand-in for `@engenty/web-ingest`: its host guard, and this product's HTML to Markdown. */
import { BlockList, isIP } from "node:net";
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

/** This computer and the networks of a home or an office: loopback, the private ranges, a tailnet. */
const local = new BlockList();
for (const [net, prefix] of [
  ["127.0.0.0", 8],
  ["10.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["100.64.0.0", 10],
] as const) {
  local.addSubnet(net, prefix, "ipv4");
}
local.addAddress("::1", "ipv6");
local.addSubnet("fc00::", 7, "ipv6");

/** Whether an address is this computer or one of its private networks. Link-local is neither. */
export function isLocalAddress(ip: string): boolean {
  const family = isIP(ip);
  return family !== 0 && local.check(ip, family === 6 ? "ipv6" : "ipv4");
}

/**
 * The guard for the one caller that may reach this computer and its private networks: a connector
 * from a pasted address on a runtime that is a computer of one's own (`connectors/external.ts`).
 * Public addresses pass as everywhere; loopback and private ones pass too. Link-local addresses
 * (the cloud metadata service), multicast and the reserved ranges stay refused, and so does
 * anything that is not http or https.
 */
export async function assertLocalOrPublicHttpHost(
  urlString: string,
  lookupImpl?: LookupFn,
): Promise<{ url: URL; addresses: string[] }> {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    throw new Error(`Invalid URL: ${urlString}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http and https URLs are allowed");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) {
    return { url, addresses: ["127.0.0.1"] };
  }
  const allowed = (ip: string) => isLocalAddress(ip) || isPublicAddress(ip);
  let addresses: string[];
  if (isIP(host) !== 0) {
    addresses = [host];
  } else {
    const lookup = lookupImpl ?? ((await import("node:dns/promises")).lookup as unknown as LookupFn);
    try {
      addresses = (await lookup(host, { all: true, verbatim: true })).map((e) => e.address);
    } catch (err) {
      throw new Error(
        `DNS resolution failed for ${host}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!addresses.length) {
      throw new Error(`No DNS records found for ${host}`);
    }
  }
  const bad = addresses.find((a) => !allowed(a));
  if (bad) {
    throw new Error(`URL host is not allowed for fetch: ${host} (${bad})`);
  }
  return { url, addresses };
}
