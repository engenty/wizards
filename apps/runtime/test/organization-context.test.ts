import { matchSectors } from "@engenty/wizards-shared/sectors";
import type { MarketplaceEntry } from "@engenty/wizards-shared/marketplace";
import { describe, expect, it } from "vitest";
import { byFit } from "../src/services/organization-context";

const entry = (id: string, more: Partial<MarketplaceEntry> = {}) =>
  ({ id, title: id, pitch: "", terms: [], industries: ["any"], ...more }) as MarketplaceEntry;

describe("an organization's sector", () => {
  it("is found in what its site says, in either language", () => {
    expect(matchSectors("Bäckerei Huber – Brot und Gebäck aus Linz")[0]).toBe("bakeries");
    expect(matchSectors("Kanzlei Dr. Fuchs, Rechtsanwalt in Graz")[0]).toBe("lawFirms");
    expect(matchSectors("Family-run bakery with a café")).toEqual(
      expect.arrayContaining(["bakeries", "cafes"]),
    );
    expect(matchSectors("Wir lieben, was wir tun")).toEqual([]);
  });
});

describe("the templates in the order that fits", () => {
  it("puts the sector's first, then its industry's, then the wishes', and says why", () => {
    const entries = [
      entry("quiz"),
      entry("menu", { industries: ["gastronomy"] }),
      entry("cakes", { sectors: ["bakeries"] }),
      entry("replies", { pitch: "Answer enquiries from the website" }),
    ];
    const ordered = byFit(entries, {
      sector: "bakeries",
      kind: "small",
      size: "2-9",
      words: "enquiries from the website",
    });
    expect(ordered.map((e) => [e.id, e.fit])).toEqual([
      ["cakes", "sector"],
      ["menu", "industry"],
      ["replies", "wish"],
      ["quiz", undefined],
    ]);
  });
});
