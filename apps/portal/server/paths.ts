/**
 * The portal's addresses, in one place for the server and the SPA (docs/plans/client-portal.md,
 * "Addresses"): no client space's name or id is ever in one. `/portal` is the client's home in
 * the client space the tab is on, the chat with the firm's AI; Wizards and Results have a word
 * each; a deep link names one item by its random id, and the contract finds the item's client
 * space.
 */

export const PORTAL = "/portal";

/** The parts of the current client space. */
export const PARTS = ["wizards", "results"] as const;
export type PartName = (typeof PARTS)[number];

/** One item by its id: a run or result, a chat, a file, a wizard to start. */
export const ITEMS = { run: "r", chat: "chat", file: "f", wizard: "w" } as const;
export type ItemKind = keyof typeof ITEMS;

/** What the portal's server answers itself under `/portal`: never a page. */
export const OWN = ["api", "auth", "assets"] as const;

export type Place =
  | { kind: "home" }
  | { kind: "part"; part: PartName }
  | { kind: ItemKind; id: string }
  | { kind: "unknown" };

/** Where an address below `/portal` points. */
export function placeOf(pathname: string): Place {
  if (!(pathname === PORTAL || pathname.startsWith(`${PORTAL}/`))) {
    return { kind: "unknown" };
  }
  const [first = "", id = "", ...rest] = pathname
    .slice(PORTAL.length)
    .split("/")
    .filter(Boolean)
    .map((s) => decodeURIComponent(s));
  if (!first) {
    return { kind: "home" };
  }
  if ((PARTS as readonly string[]).includes(first) && !id) {
    return { kind: "part", part: first as PartName };
  }
  const item = (Object.keys(ITEMS) as ItemKind[]).find((k) => ITEMS[k] === first);
  if (item && id && !rest.length) {
    return { kind: item, id };
  }
  return { kind: "unknown" };
}

/** The address of a place. */
export const pathOf = {
  home: () => PORTAL,
  part: (part: PartName) => `${PORTAL}/${part}`,
  item: (kind: ItemKind, id: string) => `${PORTAL}/${ITEMS[kind]}/${encodeURIComponent(id)}`,
};
