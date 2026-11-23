import { parse } from "tldts";

// Where a saved login may be used. A login is kept for one origin (protocol, host and port) and
// works there and on the matching root or `www` host, the rules of n8n's Nod Vault: a login
// for https://example.com also works on https://www.example.com, never on
// https://login.example.com, http://example.com or https://example.com:8443.

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export class OriginRefused extends Error {}

/** Whether a host is this computer: there a login may use plain http. */
export const loopbackHost = (hostname: string): boolean => LOOPBACK.has(hostname);

/**
 * The origin a login is kept for, from what the person typed: a domain or a full address.
 * Without a protocol it is https. The path, query and fragment are dropped; a user name or a
 * password in the address is refused.
 */
export function siteOrigin(value: string): string {
  const text = value.trim();
  if (!text) throw new OriginRefused("Enter the website, such as example.com.");
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw new OriginRefused("This is not a website address. Enter one such as example.com.");
  }
  if (url.username || url.password)
    throw new OriginRefused(
      "Remove the user name and password from the address. Enter them in the login fields.",
    );
  if (url.protocol === "http:" && !loopbackHost(url.hostname))
    throw new OriginRefused("Use the https address of the website.");
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new OriginRefused("Use the https address of the website.");
  if (!loopbackHost(url.hostname) && !/[^.]\.[^.]/.test(url.hostname))
    throw new OriginRefused(
      "The domain is incomplete. Enter the full domain, such as example.com.",
    );
  return url.origin;
}

/**
 * The origins a login kept for `origin` works on: the origin itself and, for a registrable
 * domain with a known public or private suffix, its `www` or root twin. Anything else (an IP,
 * a local name, a further subdomain) keeps exact matching.
 */
export function originsOf(origin: string): string[] {
  const url = new URL(origin);
  const host = url.hostname.replace(/^www\./, "");
  const domain = parse(host, { allowPrivateDomains: true });
  if (host.startsWith("www.") || domain.domain !== host || !(domain.isIcann || domain.isPrivate))
    return [origin];
  const twin = new URL(origin);
  twin.hostname = url.hostname === host ? `www.${host}` : host;
  return [origin, twin.origin];
}

/** Whether a login kept for `saved` may be entered on a page of `page` (an origin or a URL). */
export function fits(saved: string, page: string): boolean {
  let pageOrigin: string;
  try {
    pageOrigin = new URL(page).origin;
  } catch {
    return false;
  }
  return originsOf(saved).includes(pageOrigin);
}
