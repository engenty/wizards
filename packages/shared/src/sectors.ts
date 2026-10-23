import type { Industry } from "./marketplace.js";

/**
 * The sectors the template catalogs are built for: “Wizards für Bäckereien”, “Wizards für
 * Kanzleien”. The studio's first visit picks one for the organization, and the new-wizard page
 * puts the templates of its sector first. Each belongs to one of the catalog's broad industries.
 */
export interface Sector {
  id: string;
  industry: Industry;
  /** The plural, as a catalog names its people: “Bäckereien”, “Bakeries”. */
  name: { de: string; en: string };
  /** Words that point to it, lower case, in both languages: a site's text, the answers. */
  words: string[];
}

export const SECTORS: Sector[] = [
  {
    id: "bakeries",
    industry: "gastronomy",
    name: { de: "Bäckereien", en: "Bakeries" },
    words: [
      "bäckerei",
      "bäcker",
      "backstube",
      "brot",
      "gebäck",
      "konditorei",
      "bakery",
      "bread",
      "pastry",
    ],
  },
  {
    id: "cafes",
    industry: "gastronomy",
    name: { de: "Cafés", en: "Cafés" },
    words: ["café", "cafe", "kaffeehaus", "kaffee", "coffee", "espresso"],
  },
  {
    id: "restaurants",
    industry: "gastronomy",
    name: { de: "Restaurants", en: "Restaurants" },
    words: [
      "restaurant",
      "gasthaus",
      "gasthof",
      "wirtshaus",
      "pizzeria",
      "küche",
      "speisekarte",
      "menu",
      "bistro",
    ],
  },
  {
    id: "hotels",
    industry: "hospitality",
    name: { de: "Hotels und Pensionen", en: "Hotels and guesthouses" },
    words: [
      "hotel",
      "pension",
      "zimmer",
      "übernachtung",
      "ferienwohnung",
      "guesthouse",
      "booking",
      "rooms",
    ],
  },
  {
    id: "architects",
    industry: "professional",
    name: { de: "Architekturbüros", en: "Architects" },
    words: ["architekt", "architektur", "planung", "entwurf", "architect", "architecture"],
  },
  {
    id: "lawFirms",
    industry: "professional",
    name: { de: "Kanzleien", en: "Law firms" },
    words: [
      "rechtsanwalt",
      "anwalt",
      "kanzlei",
      "recht",
      "notar",
      "law firm",
      "lawyer",
      "attorney",
      "legal",
    ],
  },
  {
    id: "taxAdvisors",
    industry: "professional",
    name: { de: "Steuerberatung", en: "Tax advisors" },
    words: [
      "steuerberatung",
      "steuerberater",
      "steuer",
      "buchhaltung",
      "lohnverrechnung",
      "bilanz",
      "tax",
      "accounting",
      "bookkeeping",
    ],
  },
  {
    id: "consultants",
    industry: "professional",
    name: { de: "Beratung", en: "Consultants" },
    words: ["beratung", "berater", "consulting", "coaching", "consultant"],
  },
  {
    id: "physiotherapy",
    industry: "health",
    name: { de: "Physiotherapie", en: "Physiotherapy" },
    words: ["physiotherapie", "physio", "massage", "therapie", "physiotherapy"],
  },
  {
    id: "practices",
    industry: "health",
    name: { de: "Arztpraxen", en: "Doctors’ practices" },
    words: ["arzt", "ärztin", "praxis", "ordination", "zahnarzt", "doctor", "clinic", "dentist"],
  },
  {
    id: "hairdressers",
    industry: "retail",
    name: { de: "Friseur und Kosmetik", en: "Hair and beauty" },
    words: ["friseur", "frisör", "kosmetik", "nagelstudio", "beauty", "hairdresser", "salon"],
  },
  {
    id: "joiners",
    industry: "trades",
    name: { de: "Tischlereien", en: "Joiners" },
    words: [
      "tischlerei",
      "tischler",
      "schreiner",
      "möbel",
      "holz",
      "joinery",
      "carpenter",
      "furniture",
    ],
  },
  {
    id: "electricians",
    industry: "trades",
    name: { de: "Elektrotechnik", en: "Electricians" },
    words: ["elektriker", "elektro", "elektrotechnik", "photovoltaik", "electrician", "electrical"],
  },
  {
    id: "plumbing",
    industry: "trades",
    name: { de: "Installateure", en: "Plumbing and heating" },
    words: ["installateur", "sanitär", "heizung", "klima", "plumber", "plumbing", "heating"],
  },
  {
    id: "windows",
    industry: "trades",
    name: { de: "Fensterbau", en: "Window makers" },
    words: ["fenster", "türen", "fensterbau", "sonnenschutz", "windows", "doors"],
  },
  {
    id: "construction",
    industry: "trades",
    name: { de: "Bau und Handwerk", en: "Building and trades" },
    words: [
      "bau",
      "baumeister",
      "maler",
      "dachdecker",
      "handwerk",
      "construction",
      "builder",
      "painter",
      "roofer",
    ],
  },
  {
    id: "realEstate",
    industry: "realEstate",
    name: { de: "Immobilien", en: "Real estate" },
    words: [
      "immobilien",
      "makler",
      "wohnung",
      "miete",
      "hausverwaltung",
      "real estate",
      "property",
      "estate agent",
    ],
  },
  {
    id: "onlineShops",
    industry: "retail",
    name: { de: "Online-Shops", en: "Online shops" },
    words: [
      "online-shop",
      "onlineshop",
      "shop",
      "versand",
      "e-commerce",
      "webshop",
      "online store",
    ],
  },
  {
    id: "retail",
    industry: "retail",
    name: { de: "Handel", en: "Retail" },
    words: ["geschäft", "handel", "laden", "boutique", "retail", "store"],
  },
  {
    id: "agencies",
    industry: "agency",
    name: { de: "Agenturen", en: "Agencies" },
    words: [
      "agentur",
      "werbung",
      "marketing",
      "design",
      "kommunikation",
      "agency",
      "advertising",
      "branding",
    ],
  },
  {
    id: "photographers",
    industry: "agency",
    name: { de: "Fotografie", en: "Photographers" },
    words: ["fotograf", "fotografie", "foto", "photographer", "photography"],
  },
  {
    id: "events",
    industry: "events",
    name: { de: "Veranstaltungen", en: "Events" },
    words: ["event", "veranstaltung", "hochzeit", "catering", "konferenz", "wedding", "conference"],
  },
  {
    id: "itServices",
    industry: "professional",
    name: { de: "IT-Dienstleister", en: "IT services" },
    words: [
      "it-dienstleister",
      "it-service",
      "software",
      "webentwicklung",
      "hosting",
      "netzwerk",
      "development",
      "web design",
    ],
  },
  {
    id: "cleaning",
    industry: "trades",
    name: { de: "Reinigung", en: "Cleaning" },
    words: ["reinigung", "gebäudereinigung", "putz", "cleaning", "janitorial"],
  },
  {
    id: "footballClubs",
    industry: "any",
    name: { de: "Fußballvereine", en: "Football clubs" },
    words: ["fußball", "fussball", "fc", "sv", "kicker", "football", "soccer"],
  },
  {
    id: "sportsClubs",
    industry: "any",
    name: { de: "Sportvereine", en: "Sports clubs" },
    words: ["sportverein", "verein", "turnen", "tennis", "laufen", "sport", "club"],
  },
  {
    id: "musicClubs",
    industry: "events",
    name: { de: "Musikvereine und Chöre", en: "Music clubs and choirs" },
    words: ["musikverein", "blasmusik", "chor", "kapelle", "orchester", "band", "choir", "music"],
  },
  {
    id: "fireBrigades",
    industry: "publicSector",
    name: { de: "Feuerwehren", en: "Fire brigades" },
    words: ["feuerwehr", "rettung", "rotes kreuz", "fire brigade", "rescue"],
  },
  {
    id: "schools",
    industry: "publicSector",
    name: { de: "Schulen und Bildung", en: "Schools and education" },
    words: [
      "schule",
      "kurs",
      "weiterbildung",
      "akademie",
      "nachhilfe",
      "school",
      "course",
      "training",
    ],
  },
  {
    id: "municipalities",
    industry: "publicSector",
    name: { de: "Gemeinden", en: "Municipalities" },
    words: ["gemeinde", "stadt", "bürgerservice", "amt", "municipality", "council", "town"],
  },
  {
    id: "associations",
    industry: "any",
    name: { de: "Vereine und Initiativen", en: "Associations" },
    words: ["verein", "initiative", "ehrenamt", "verband", "association", "nonprofit", "charity"],
  },
];

export const sectorOf = (id: string | null | undefined): Sector | null =>
  SECTORS.find((s) => s.id === id) ?? null;

/**
 * The sectors a text points to, the best first: each word of a sector found in the text counts,
 * a longer word more. Nothing where no word is found.
 */
export function matchSectors(text: string, most = 3): string[] {
  const hay = ` ${text
    .toLowerCase()
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}-]+/gu, " ")} `;
  return SECTORS.map((s) => ({
    id: s.id,
    score: s.words.reduce(
      (sum, w) => sum + (hay.includes(` ${w}`) ? Math.min(3, w.length / 4) : 0),
      0,
    ),
  }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, most)
    .map((x) => x.id);
}
