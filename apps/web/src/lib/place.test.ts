import { beforeEach, describe, expect, it } from "vitest";
import { keepHint, placeOf } from "./place";
import type { Me } from "./session";

// The tests run in Node: the browser's session storage, as a map.
const kept = new Map<string, string>();
globalThis.sessionStorage = {
  getItem: (k: string) => kept.get(k) ?? null,
  setItem: (k: string, v: string) => void kept.set(k, v),
  removeItem: (k: string) => void kept.delete(k),
  clear: () => kept.clear(),
  key: () => null,
  length: 0,
} as Storage;

const org = (id: string, slug: string) => ({
  id,
  name: id,
  slug,
  role: "owner" as const,
  personal: false,
  plan: null,
});

const me = {
  mode: "managed",
  user: { id: "u", name: "Anna", email: "anna@example.com", image: null },
  tenant: { id: "fuchs", role: "owner", name: "Fuchs Tischlerei", slug: "fuchs", plan: null },
  organizations: [org("fuchs", "fuchs"), org("engrd", "engrd")],
} as unknown as Me;

describe("a studio address in the cloud", () => {
  beforeEach(() => sessionStorage.clear());

  it("stays in the organization it names", () => {
    expect(placeOf("/studio/fuchs/new", me)).toEqual({ kind: "here", root: "/studio/fuchs" });
    expect(placeOf("/studio/fuchs", me)).toEqual({ kind: "here", root: "/studio/fuchs" });
  });

  it("moves a page without an organization into the person's", () => {
    expect(placeOf("/studio/", me)).toEqual({
      kind: "move",
      root: "/studio/fuchs",
      to: "/studio/fuchs/",
    });
    expect(placeOf("/studio", me)).toEqual({
      kind: "move",
      root: "/studio/fuchs",
      to: "/studio/fuchs/",
    });
    expect(placeOf("/studio/edit/w1", me)).toEqual({
      kind: "move",
      root: "/studio/fuchs",
      to: "/studio/fuchs/edit/w1",
    });
  });

  it("signs in again for another of the person's organizations, once", () => {
    expect(placeOf("/studio/engrd/space", me)).toEqual({ kind: "switch", slug: "engrd" });
    keepHint("engrd");
    expect(placeOf("/studio/engrd/space", me)).toMatchObject({ kind: "foreign", address: "engrd" });
  });

  it("names nobody for an address that is none of the person's", () => {
    expect(placeOf("/studio/acme/new", me)).toEqual({
      kind: "foreign",
      address: "acme",
      home: "/studio/fuchs/new",
      me,
    });
  });
});

describe("a studio address elsewhere", () => {
  it("keeps /studio on a local install", () => {
    const local = { ...me, mode: "local", tenant: { ...me.tenant, slug: null } } as Me;
    expect(placeOf("/studio/new", local)).toEqual({ kind: "here", root: "/studio" });
  });

  it("keeps the address for someone not signed in, so the sign-in can name it", () => {
    expect(placeOf("/studio/acme/new", null)).toEqual({ kind: "here", root: "/studio/acme" });
    expect(placeOf("/studio/new", null)).toEqual({ kind: "here", root: "/studio" });
  });
});
