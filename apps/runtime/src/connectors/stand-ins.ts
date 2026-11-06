import { createGuardedFetch } from "../engenty/connections-external/net/guarded-fetch.js";
import { env } from "../env.js";

/**
 * Stand-ins for the services connectors reach, for tests and a development stack where no
 * account at Google, Slack or GitHub is at hand: an emulator on this computer answers in their
 * place. `CONNECTOR_STAND_INS` holds pairs `address=stand-in`, separated by commas or line breaks:
 *
 *   https://gmail.googleapis.com=http://localhost:4002
 *   https://oauth2.googleapis.com/token=http://localhost:4002/oauth2/token
 *
 * A request whose address starts with the first part goes to the second, with the rest of the
 * address kept; so does the page a person signs in on. Where several first parts fit, the longest
 * counts. The server's owner names the stand-in, so it may be on this computer; every other
 * address keeps the check for the public internet. Unset, nothing changes.
 */

/** Pairs of an address and its stand-in, the longest address first. */
export type StandIns = [from: string, to: string][];

const trimmed = (address: string) => address.replace(/\/+$/, "");

/** The pairs of a `CONNECTOR_STAND_INS` text; what is not a pair of two http addresses is left out. */
export function parseStandIns(text: string | undefined): StandIns {
  const pairs: StandIns = [];
  for (const raw of (text ?? "").split(/[\s,]+/)) {
    const m = /^(https?:\/\/[^=\s]+)=(https?:\/\/\S+)$/.exec(raw);
    if (!m?.[1] || !m[2]) {
      continue;
    }
    try {
      // The address as a request names it: the host in lower case, no port that is the default.
      pairs.push([trimmed(new URL(m[1]).href), trimmed(new URL(m[2]).href)]);
    } catch {
      // Not an address: left out.
    }
  }
  return pairs.sort((a, b) => b[0].length - a[0].length);
}

const configured = parseStandIns(env.connectorStandIns);
if (configured.length) {
  console.log(
    `[connectors] stand-ins: ${configured.map(([from, to]) => `${from} → ${to}`).join(", ")}`,
  );
}

/** The stand-in's address for this one, or null where none is named for it. */
export function standInFor(address: string, pairs: StandIns = configured): string | null {
  if (!pairs.length) {
    return null;
  }
  let href: string;
  try {
    href = new URL(address).href;
  } catch {
    return null;
  }
  for (const [from, to] of pairs) {
    // The first part ends where a part of the address ends: /token is not /tokeninfo.
    if (href === from || (href.startsWith(from) && "/?#".includes(href.charAt(from.length)))) {
      return to + href.slice(from.length);
    }
  }
  return null;
}

/** The page a person signs in on: the stand-in's, where one is named. */
export function standInUrl(address: string, pairs: StandIns = configured): string {
  return standInFor(address, pairs) ?? address;
}

/**
 * A fetch that sends a request to its stand-in where one is named, through a check that lets
 * this computer's addresses pass, and every other request through `guarded` as it is.
 */
export function withStandIns(
  guarded: typeof fetch,
  pairs: StandIns = configured,
  local: typeof fetch = createGuardedFetch({ allowPrivate: true }),
): typeof fetch {
  if (!pairs.length) {
    return guarded;
  }
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const to =
      typeof input === "string" || input instanceof URL ? standInFor(String(input), pairs) : null;
    return to ? local(to, init) : guarded(input, init);
  }) as typeof fetch;
}
