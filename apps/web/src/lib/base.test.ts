import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { STUDIO_PAGES } from "./base";

/**
 * The studio's pages by their first part. A page the list misses is read as an organization's
 * address: signed out, the studio starts below it (`/studio/capabilities/capabilities/skills`),
 * and in the cloud an older link to it names nobody. So the list is checked against the routes.
 */
describe("the studio's own pages", () => {
  it("name the first part of every route of the studio", () => {
    const app = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
    const studio = app.slice(app.indexOf("export function StudioApp"));
    const firsts = [...studio.matchAll(/path="\/([^"/:*]*)/g)].map((m) => m[1]);
    expect(firsts).toContain("capabilities");
    expect(firsts.filter((first) => !STUDIO_PAGES.has(first))).toEqual([]);
  });
});
