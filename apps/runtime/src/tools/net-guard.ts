import type { LookupAddress, LookupOptions } from "node:dns";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { Agent } from "undici";

const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE_FETCH === "1";

/** Ranges that are not the public internet: this server, its networks, and special purposes. */
const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, the cloud metadata service
  ["172.16.0.0", 12], // also the Docker networks, the browser's DevTools among them
  ["192.0.0.0", 24], // protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relays
  ["192.168.0.0", 16],
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, and the broadcast address
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["64:ff9b:1::", 48], // NAT64 for local use
  ["100::", 64], // discard
  ["2001::", 32], // Teredo: a tunnel to an IPv4 address
  ["2001:db8::", 32], // documentation
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local
  ["ff00::", 8], // multicast
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

/** The eight 16-bit words of an IPv6 address (the caller has checked it is one). */
function words(ip: string): number[] {
  let s = ip.split("%")[0].toLowerCase();
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    s = `${s.slice(0, v4.index)}${(a * 256 + b).toString(16)}:${(c * 256 + d).toString(16)}`;
  }
  const [head, tail] = s.split("::");
  const part = (x: string | undefined) =>
    x ? x.split(":").map((w) => Number.parseInt(w, 16)) : [];
  const h = part(head);
  const t = part(tail);
  return tail === undefined ? h : [...h, ...new Array(8 - h.length - t.length).fill(0), ...t];
}

const dotted = (hi: number, lo: number) =>
  [Math.floor(hi / 256), hi % 256, Math.floor(lo / 256), lo % 256].join(".");

/**
 * The IPv4 address an IPv6 address stands for: mapped (::ffff:a.b.c.d, also written
 * ::ffff:a9fe:a9fe), translated, compatible (::a.b.c.d), NAT64 (64:ff9b::/96) and 6to4 (2002::/16).
 * Connecting to any of them can reach that IPv4 address.
 */
function embeddedV4(w: number[]): string | null {
  const zero = (from: number, to: number) => w.slice(from, to).every((x) => x === 0);
  if (zero(0, 5) && w[5] === 0xffff) {
    return dotted(w[6], w[7]);
  }
  if (zero(0, 4) && w[4] === 0xffff && w[5] === 0) {
    return dotted(w[6], w[7]);
  }
  if (zero(0, 6)) {
    return dotted(w[6], w[7]);
  }
  if (w[0] === 0x64 && w[1] === 0xff9b && zero(2, 6)) {
    return dotted(w[6], w[7]);
  }
  if (w[0] === 0x2002) {
    return dotted(w[1], w[2]);
  }
  return null;
}

/** Whether an IP address is on the public internet. Anything that is not an IP address is not. */
export function isPublicAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, "");
  const family = isIP(bare);
  if (family === 4) {
    return !blocked.check(bare, "ipv4");
  }
  if (family !== 6) {
    return false;
  }
  const w = words(bare);
  const v4 = embeddedV4(w);
  if (v4) {
    return isPublicAddress(v4);
  }
  return !blocked.check(w.map((x) => x.toString(16)).join(":"), "ipv6");
}

const PRIVATE = "Private addresses are not reachable from a wizard.";

/** The host's addresses, each of them public; throws if any one is not. */
async function publicAddresses(host: string): Promise<LookupAddress[]> {
  const family = isIP(host);
  const addresses = family ? [{ address: host, family }] : await lookup(host, { all: true });
  if (!ALLOW_PRIVATE && (!addresses.length || addresses.some((a) => !isPublicAddress(a.address)))) {
    throw new Error(PRIVATE);
  }
  return addresses;
}

/** Agents may reach the public internet, never this server's own network. */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Not a valid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http and https URLs are allowed.");
  }
  if (ALLOW_PRIVATE) {
    return url;
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new Error(PRIVATE);
  }
  await publicAddresses(host);
  return url;
}

/**
 * Connects only to addresses that passed the check: the name is resolved and checked again at
 * connect time, and the socket gets exactly those addresses, so a DNS answer that changes between
 * the check and the connect (rebinding) cannot point it into the private network. TLS still
 * verifies, and the Host header still names, the host of the URL.
 */
const pinned = new Agent({
  connect: {
    lookup(host: string, options: LookupOptions, callback: (...args: any[]) => void) {
      publicAddresses(host).then((addresses) => {
        const usable = options.family
          ? addresses.filter((a) => a.family === options.family)
          : addresses;
        if (!usable.length) {
          callback(Object.assign(new Error(`No address for ${host}`), { code: "ENOTFOUND" }));
        } else if (options.all) {
          callback(null, usable);
        } else {
          callback(null, usable[0].address, usable[0].family);
        }
      }, callback);
    },
  },
});

/** fetch that re-checks every redirect hop, so a public URL cannot bounce into the private network. */
export async function safeFetch(raw: string, init: RequestInit = {}): Promise<Response> {
  let url = await assertPublicUrl(raw);
  for (let hop = 0; hop < 6; hop++) {
    const res = await fetch(url, {
      ...init,
      redirect: "manual",
      dispatcher: pinned,
    } as RequestInit);
    const location = res.headers.get("location");
    if (res.status < 300 || res.status >= 400 || !location) {
      return res;
    }
    url = await assertPublicUrl(new URL(location, url).toString());
  }
  throw new Error("Too many redirects.");
}
