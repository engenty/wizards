import type { MarketplaceEntry } from "@engenty/wizards-shared/marketplace";
import { matchSectors, sectorOf } from "@engenty/wizards-shared/sectors";
import { readSetting, writeSetting } from "../settings.js";

/**
 * What the studio's first visit learned about an organization, for the new-wizard page to put
 * the templates that fit it first: its sector, its kind and size, and words of its wishes.
 */
export interface OrganizationContext {
  /** A catalog sector's id (sectors.ts); null where none fits. */
  sector: string | null;
  kind: "personal" | "club" | "small" | "corp" | null;
  size: string | null;
  /** Its wishes, questions and what it says it does, as words to match. */
  words: string;
}

const key = (tenantId: string) => `organization:context:${tenantId}`;

export function organizationContext(tenantId: string): Promise<OrganizationContext | null> {
  return readSetting<OrganizationContext>(key(tenantId));
}

/** Keeps it; a sector given as free text becomes the catalog sector it points to. */
export async function setOrganizationContext(
  tenantId: string,
  context: Omit<OrganizationContext, "sector"> & { sector: string | null },
): Promise<void> {
  const sector = sectorOf(context.sector)
    ? context.sector
    : (matchSectors(`${context.sector ?? ""} ${context.words}`, 1)[0] ?? null);
  await writeSetting(key(tenantId), { ...context, sector, words: context.words.slice(0, 2000) });
}

const wordsOf = (text: string) =>
  new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 4),
  );

/**
 * The entries in the order that fits the organization: its sector's first, then those of its
 * sector's industry, then those that share words with its wishes, each with why it stands there;
 * the rest keep their order.
 */
export function byFit(
  entries: MarketplaceEntry[],
  context: OrganizationContext,
): MarketplaceEntry[] {
  const sector = sectorOf(context.sector);
  const wishes = wordsOf(context.words);
  const scored = entries.map((e, i) => {
    const text = wordsOf([e.title, e.pitch, ...(e.terms ?? [])].join(" "));
    const shared = [...wishes].filter((w) => text.has(w)).length;
    const fit: MarketplaceEntry["fit"] =
      sector && e.sectors?.includes(sector.id)
        ? "sector"
        : sector && sector.industry !== "any" && e.industries.includes(sector.industry)
          ? "industry"
          : shared
            ? "wish"
            : undefined;
    const score = (fit === "sector" ? 100 : fit === "industry" ? 50 : 0) + Math.min(shared, 5) * 5;
    return { e: fit ? { ...e, fit } : e, score, i };
  });
  return scored.sort((a, b) => b.score - a.score || a.i - b.i).map((x) => x.e);
}
