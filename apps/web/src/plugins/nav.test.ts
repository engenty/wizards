import { describe, expect, it } from "vitest";
import { navIn } from "./nav";

type Entry = { to: string; mode?: "studio" | "work" };
const studio: Entry = { to: "/a" };
const named: Entry = { to: "/b", mode: "studio" };
const work: Entry = { to: "/c", mode: "work" };
const all = [studio, named, work];

describe("navIn", () => {
  it("keeps an icon in the mode it names, Studio by default", () => {
    expect(navIn(all, "studio", ["studio", "work"])).toEqual([studio, named]);
    expect(navIn(all, "work", ["studio", "work"])).toEqual([work]);
  });

  it("shows no plugin's icon in Shared", () => {
    expect(navIn(all, "shared", ["studio", "work", "shared"])).toEqual([]);
  });

  it("brings an icon for Work to Studio where Work is off", () => {
    expect(navIn(all, "studio", ["studio"])).toEqual(all);
  });

  it("doesn't bring a Studio icon to someone who only has Work", () => {
    expect(navIn(all, "work", ["work", "shared"])).toEqual([work]);
  });
});
