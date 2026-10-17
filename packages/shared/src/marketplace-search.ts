import {
  type CatalogFieldWeights,
  scoreCatalogEntry,
  tokenizeCatalogText,
} from "./engenty/search-index/catalog-lexical.js";
import {
  type Capability,
  type Industry,
  type ItemFormat,
  type MarketGroup,
  type MarketplaceFacets,
  type MarketplaceFilters,
  type MarketplacePage,
  type MarketplacePlan,
  type MarketplaceSummary,
  marketLabels,
  type UseCase,
} from "./marketplace.js";

/**
 * Searching the marketplace by words: BM25 with prefixes and inflections, the scoring engenty's
 * catalogs use. The marketplace answers every search with it; an app that cannot reach the
 * marketplace searches what it keeps the same way.
 */

const WEIGHTS: CatalogFieldWeights = [
  ["title", 10],
  ["summary", 6],
  ["category", 5],
  ["tags", 3],
];
/** One search term of an entry, scored on its own. */
const TERM_WEIGHT: CatalogFieldWeights = [["term", 7]];

/**
 * Words a sentence is full of and no entry is found by — in the form the search reads words in,
 * so "für" is left out as "fur".
 */
const STOP = new Set(
  tokenizeCatalogText(
    `aber als also am an auch auf aus bei bin bitte brauche brauchen braucht das dass dem den der
    des die dies diese dieser doch du ein eine einem einen einer eines er es etwas fuer für gerne
    habe haben hat ich ihr im in ist kann können koennen mache machen mag mein meine meinem meinen
    meiner mich mir mit möchte moechte nach nicht noch nur oder sich sie sind soll suche suchen
    sucht um und uns unser unsere vom von vor was wie will wir wird wo wollen zu zum zur
    a about an and are as at be can do for from have how i in is it like looking me my need of on
    or our that the this to want we what which who with would you your`,
  ),
);

const fold = (text: string) => text.replace(/ß/g, "ss");

/** What a query is looked up by: its words, without the ones that say nothing. */
export function searchTerms(query: string): string[] {
  const words = tokenizeCatalogText(fold(query));
  const kept = words.filter((w) => !STOP.has(w));
  return kept.length ? kept : words;
}

/** From this many words on a query is a sentence: it shares some word with nearly every entry. */
export const SENTENCE_WORDS = 3;
/** Of a sentence's finds by words, those with at least this share of the best score are kept. */
const SENTENCE_SHARE = 0.4;
export const isSentence = (query: string) =>
  query.trim().split(/\s+/).filter(Boolean).length >= SENTENCE_WORDS;

const labels = (group: MarketGroup, ids: string[]) => ids.flatMap((id) => marketLabels(group, id));

/** How well an entry answers the query by its words; 0 when it does not at all. */
export function scoreEntry(entry: MarketplaceSummary, query: string): number {
  const terms = searchTerms(query);
  if (!terms.length) {
    return 0;
  }
  const record = {
    title: fold(entry.title),
    summary: fold(entry.pitch),
    category: labels("useCase", entry.useCases),
    tags: [
      ...labels("industry", entry.industries),
      ...labels("format", entry.formats),
      ...labels("capability", entry.capabilities),
    ].map(fold),
  };
  let score = scoreCatalogEntry(record, terms.join(" "), WEIGHTS);
  // An entry's own search terms: each word of the query counts once, by the term it fits best.
  // Scored as one long text they would count for less the more of them an entry has.
  const own = entry.terms.map((term) => ({ term: fold(term) }));
  for (const word of terms) {
    score += Math.max(0, ...own.map((t) => scoreCatalogEntry(t, word, TERM_WEIGHT)));
  }
  // German writes words together: "anzeige" is found inside "Videoanzeige" as well.
  const text = tokenizeCatalogText(`${record.title} ${record.summary}`).join(" ");
  const inside = terms.filter((term) => term.length >= 4 && text.includes(term)).length;
  return score + inside * 2;
}

/** The entries a query finds by its words, best first. An empty query keeps the list as it is. */
export function rankEntries<T extends MarketplaceSummary>(
  entries: readonly T[],
  query: string,
): T[] {
  if (!query.trim()) {
    return [...entries];
  }
  const rows = entries
    .map((entry) => ({ entry, score: scoreEntry(entry, query) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score);
  // A sentence shares some word with nearly every entry: only what comes close to the best counts.
  const least = isSentence(query) ? (rows[0]?.score ?? 0) * SENTENCE_SHARE : 0;
  return rows.filter((row) => row.score >= least).map((row) => row.entry);
}

/** Whether an entry passes the filters. An entry made for any industry passes every industry. */
export function matchesFilters(e: MarketplaceSummary, f: MarketplaceFilters): boolean {
  return (
    (!f.useCase || e.useCases.includes(f.useCase)) &&
    (!f.industry ||
      e.industries.includes(f.industry) ||
      (f.industry !== "any" && e.industries.includes("any"))) &&
    (!f.format || e.formats.includes(f.format)) &&
    (!f.capability || e.capabilities.includes(f.capability)) &&
    (!f.plan || (e.plan ?? "free") === f.plan)
  );
}

const FACETS = {
  useCase: (e: MarketplaceSummary) => e.useCases as string[],
  industry: (e: MarketplaceSummary) => e.industries as string[],
  format: (e: MarketplaceSummary) => e.formats as string[],
  capability: (e: MarketplaceSummary) => e.capabilities as string[],
  plan: (e: MarketplaceSummary) => [e.plan ?? "free"],
} satisfies Record<keyof MarketplaceFacets, (e: MarketplaceSummary) => string[]>;

/**
 * Per option of each filter, the found entries it would leave with the other filters as they
 * are. An option no entry has at all is left out.
 */
function facetsOf(
  all: readonly MarketplaceSummary[],
  found: readonly MarketplaceSummary[],
  filters: MarketplaceFilters,
): MarketplaceFacets {
  const facets: Required<MarketplaceFacets> = {
    useCase: {},
    industry: {},
    format: {},
    capability: {},
    plan: {},
  };
  for (const key of Object.keys(FACETS) as (keyof MarketplaceFacets)[]) {
    const options = new Set(all.flatMap(FACETS[key]));
    const counts = facets[key] as Record<string, number>;
    for (const option of options) {
      counts[option] = found.filter((e) =>
        matchesFilters(e, {
          ...filters,
          [key]: option as UseCase & Industry & ItemFormat & Capability & MarketplacePlan,
        }),
      ).length;
    }
  }
  return facets;
}

/**
 * A search as the marketplace answers it: the entries the words find, best first (an empty
 * query keeps the order given), narrowed by the filters, one page of them, and the counts.
 */
export function searchEntries<T extends MarketplaceSummary>(
  entries: readonly T[],
  query: string,
  filters: MarketplaceFilters = {},
  page: { limit?: number; offset?: number } = {},
): MarketplacePage<T> {
  const found = rankEntries(entries, query);
  const shown = found.filter((e) => matchesFilters(e, filters));
  const offset = Math.max(0, page.offset ?? 0);
  return {
    entries: shown.slice(offset, offset + Math.max(1, page.limit ?? 60)),
    total: shown.length,
    all: entries.length,
    facets: facetsOf(entries, found, filters),
  };
}
