import { STUDIO, STUDIO_PAGES } from "./base";
import type { Me } from "./session";

/** Where a studio address leads, given who is signed in. */
export type Place =
  | { kind: "here"; root: string }
  | { kind: "move"; root: string; to: string }
  | { kind: "switch"; slug: string }
  | { kind: "foreign"; address: string; home: string; me: Me };

/** A sign-in naming an organization came back without it: it is not one of the person's. */
const HINT_KEY = "wizards.organizationHint";
const HINT_SECONDS = 30;

function hintedJustNow(slug: string): boolean {
  try {
    const kept = JSON.parse(sessionStorage.getItem(HINT_KEY) ?? "null") as {
      slug: string;
      at: number;
    } | null;
    return kept?.slug === slug && Date.now() - kept.at < HINT_SECONDS * 1000;
  } catch {
    return false;
  }
}

export function keepHint(slug: string) {
  try {
    sessionStorage.setItem(HINT_KEY, JSON.stringify({ slug, at: Date.now() }));
  } catch {
    // Without session storage a refused hint ends on the address's page one sign-in later.
  }
}

/**
 * In the cloud every studio address names its organization, `/studio/<address>/…`: the address
 * says where someone is, and a link opens the same organization for whoever follows it. A local
 * install has one organization and keeps `/studio/`.
 */
export function placeOf(path: string, me: Me | null | undefined): Place {
  const rest = path.slice(STUDIO.length);
  const first = rest.split("/")[1] ?? "";
  if (!me) {
    // Not signed in: an address stays as it is, and the sign-in names its organization.
    return { kind: "here", root: STUDIO_PAGES.has(first) ? STUDIO : `${STUDIO}/${first}` };
  }
  const slug = me.mode === "managed" ? me.tenant.slug : null;
  if (!slug) {
    return { kind: "here", root: STUDIO };
  }
  const root = `${STUDIO}/${slug}`;
  if (first === slug) {
    return { kind: "here", root };
  }
  // Another of the person's organizations: a sign-in naming it, answered without a page.
  if (me.organizations.some((o) => o.slug === first) && !hintedJustNow(first)) {
    return { kind: "switch", slug: first };
  }
  // A studio page without an organization (an older link): the one the person is in.
  if (STUDIO_PAGES.has(first)) {
    return { kind: "move", root, to: `${root}${rest || "/"}` };
  }
  return {
    kind: "foreign",
    address: first,
    home: `${root}${rest.slice(first.length + 1) || "/"}`,
    me,
  };
}
