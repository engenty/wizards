import {
  type Format,
  LANGS,
  type Lang,
  pluginToolOf,
  type WizardDefinition,
} from "./definition.js";
import { type Gap, type Line, type Texts, textOf } from "./texts.js";

/**
 * The marketplace: wizards anyone can start from. What an entry is sorted by — formats, industry,
 * use case — and what follows from its definition: the AI capabilities it needs, how much a
 * person has to fill in, and how expensive a run is.
 */

export const MARKETPLACE_LANGS = ["de", "en"] as const;
export type MarketplaceLang = (typeof MARKETPLACE_LANGS)[number];

/** What comes out of a run. */
export const ITEM_FORMAT_IDS = [
  "text",
  "document",
  "table",
  "image",
  "video",
  "audio",
  "dashboard",
] as const;
export type ItemFormat = (typeof ITEM_FORMAT_IDS)[number];

export const INDUSTRY_IDS = [
  "any",
  "trades",
  "gastronomy",
  "hospitality",
  "realEstate",
  "retail",
  "health",
  "professional",
  "agency",
  "events",
  "publicSector",
] as const;
export type Industry = (typeof INDUSTRY_IDS)[number];

export const USE_CASE_IDS = [
  "marketing",
  "sales",
  "accounting",
  "service",
  "research",
  "hr",
  "operations",
  "website",
  "visuals",
  "inquiries",
  "advice",
] as const;
export type UseCase = (typeof USE_CASE_IDS)[number];

/**
 * What the models and tools behind a wizard must be able to do. `film`: a film the installed
 * client makes, only on a computer with Claude Code, on its subscription.
 */
export const CAPABILITY_IDS = [
  "text",
  "web",
  "browser",
  "documents",
  "image",
  "video",
  "speech",
  "listening",
  "code",
  "connectors",
  "film",
] as const;
export type Capability = (typeof CAPABILITY_IDS)[number];

export const COST_TIER_IDS = ["low", "medium", "high"] as const;
export type CostTier = (typeof COST_TIER_IDS)[number];

/**
 * The plan a wizard needs. Free runs on what every runtime has; Pro needs plugins, which come
 * with the Pro and Team plans of engenty.ai.
 */
export const MARKETPLACE_PLAN_IDS = ["free", "pro"] as const;
export type MarketplacePlan = (typeof MARKETPLACE_PLAN_IDS)[number];

/** What a marketplace label belongs to: a facet, a cost tier, a plan. */
export type MarketGroup =
  | "format"
  | "industry"
  | "useCase"
  | "capability"
  | "cost"
  | "plan"
  | "outline";

const MARKET_EN = {
  "format.text": "Text",
  "format.document": "Document (PDF, Word)",
  "format.table": "Table",
  "format.image": "Image",
  "format.video": "Video",
  "format.audio": "Audio",
  "format.dashboard": "Dashboard",
  "industry.any": "Any industry",
  "industry.trades": "Trades",
  "industry.gastronomy": "Food service",
  "industry.hospitality": "Hotels & tourism",
  "industry.realEstate": "Real estate",
  "industry.retail": "Retail",
  "industry.health": "Health",
  "industry.professional": "Professional services",
  "industry.agency": "Agency & marketing",
  "industry.events": "Events",
  "industry.publicSector": "Associations & public sector",
  "useCase.marketing": "Marketing & social media",
  "useCase.sales": "Offers & sales",
  "useCase.accounting": "Accounting & receipts",
  "useCase.service": "Customer service",
  "useCase.research": "Research & analysis",
  "useCase.hr": "HR & applications",
  "useCase.operations": "Planning & operations",
  "useCase.website": "Website helpers",
  "useCase.visuals": "Images & video",
  "useCase.inquiries": "Inquiries & bookings",
  "useCase.advice": "Advice & pricing",
  "capability.text": "Writes text",
  "capability.web": "Web search",
  "capability.browser": "Drives a browser",
  "capability.documents": "Reads documents & photos",
  "capability.image": "Makes images",
  "capability.video": "Makes video",
  "capability.speech": "Speech output",
  "capability.listening": "Understands voice notes",
  "capability.code": "Runs code",
  "capability.connectors": "Connected accounts & systems",
  "capability.film": "Films with Claude Code (on your subscription)",
  "cost.low": "low cost",
  "cost.medium": "medium cost",
  "cost.high": "high cost",
  "plan.free": "Free",
  "plan.pro": "Pro",
  "outline.otherwise": "otherwise",
  "outline.and": "{first} and {second}",
  "outline.with": "with {name}",
  "outline.without": "without {name}",
  "outline.contains": "{name} contains {value}",
} as const satisfies Record<string, Line>;
type MarketKey = keyof typeof MARKET_EN;

const MARKET_DE: Partial<Record<MarketKey, Line>> = {
  "format.text": "Text",
  "format.document": "Dokument (PDF, Word)",
  "format.table": "Tabelle",
  "format.image": "Bild",
  "format.video": "Video",
  "format.audio": "Audio",
  "format.dashboard": "Dashboard",
  "industry.any": "Jede Branche",
  "industry.trades": "Handwerk",
  "industry.gastronomy": "Gastronomie",
  "industry.hospitality": "Hotel & Tourismus",
  "industry.realEstate": "Immobilien",
  "industry.retail": "Handel",
  "industry.health": "Gesundheit",
  "industry.professional": "Kanzlei & Beratung",
  "industry.agency": "Agentur & Marketing",
  "industry.events": "Veranstaltungen",
  "industry.publicSector": "Vereine & Öffentliches",
  "useCase.marketing": "Marketing & Social Media",
  "useCase.sales": "Angebote & Verkauf",
  "useCase.accounting": "Buchhaltung & Belege",
  "useCase.service": "Kundenservice",
  "useCase.research": "Recherche & Analyse",
  "useCase.hr": "Personal & Bewerbungen",
  "useCase.operations": "Planung & Abläufe",
  "useCase.website": "Helfer für die Website",
  "useCase.visuals": "Bilder & Video",
  "useCase.inquiries": "Anfragen & Termine",
  "useCase.advice": "Beratung & Preise",
  "capability.text": "Text schreiben",
  "capability.web": "Websuche",
  "capability.browser": "Browser bedienen",
  "capability.documents": "Dokumente & Fotos lesen",
  "capability.image": "Bilder erzeugen",
  "capability.video": "Videos erzeugen",
  "capability.speech": "Sprachausgabe",
  "capability.listening": "Sprachnotizen verstehen",
  "capability.code": "Code ausführen",
  "capability.connectors": "Verbundene Konten & Systeme",
  "capability.film": "Filme mit Claude Code (auf deinem Abo)",
  "cost.low": "günstig",
  "cost.medium": "mittel",
  "cost.high": "teuer",
  "plan.free": "Kostenlos",
  "plan.pro": "Pro",
  "outline.otherwise": "sonst",
  "outline.and": "{first} und {second}",
  "outline.with": "mit {name}",
  "outline.without": "ohne {name}",
  "outline.contains": "{name} enthält {value}",
};

export const MARKET_TEXTS: Texts<MarketKey> = { en: MARKET_EN, de: MARKET_DE };

/** The label of a facet value, a cost tier or a plan in a language; its id where it has none. */
export function marketLabel(
  group: MarketGroup,
  id: string,
  lang: Lang,
  params?: Record<string, Gap | undefined>,
): string {
  const key = `${group}.${id}`;
  return key in MARKET_EN ? textOf(MARKET_TEXTS, key as MarketKey, lang, params) : id;
}

/** A label in every language, for search: a person may type either. */
export const marketLabels = (group: MarketGroup, id: string): string[] =>
  LANGS.map((lang) => marketLabel(group, id, lang));

const FORMAT_OF: Partial<Record<Format, ItemFormat>> = {
  pdf: "document",
  docx: "document",
  xlsx: "table",
  csv: "table",
  png: "image",
  mp4: "video",
  mp3: "audio",
  md: "text",
  txt: "text",
};

/** The formats a run hands over, read from what the result step offers. */
export function formatsOf(def: WizardDefinition): ItemFormat[] {
  const found = new Set<ItemFormat>();
  for (const step of def.steps) {
    if (step.type === "generate" && step.asset === "dashboard") {
      found.add("dashboard");
    }
    if (step.type === "result") {
      for (const d of step.deliverables) {
        const from = def.steps.find((s) => s.id === d.from);
        for (const f of d.formats) {
          const format = FORMAT_OF[f];
          // A dashboard's PNG or PDF is still the dashboard.
          if (format && !(from?.type === "generate" && from.asset === "dashboard")) {
            found.add(format);
          }
        }
      }
    }
  }
  if (!found.size) {
    found.add("text");
  }
  return ITEM_FORMAT_IDS.filter((f) => found.has(f));
}

/** The capabilities a definition needs, read from its steps. */
export function capabilitiesOf(def: WizardDefinition): Capability[] {
  const found = new Set<Capability>();
  for (const step of def.steps) {
    if (step.type === "page") {
      for (const field of step.fields) {
        if (field.kind === "image" || field.kind === "file") {
          found.add("documents");
        }
        if (field.kind === "audio") {
          found.add("listening");
        }
      }
    } else if (step.type === "agent") {
      // A call runs no model: it needs nothing but its plugin.
      if (step.call) {
        continue;
      }
      found.add("text");
      for (const tool of step.tools) {
        if (tool === "web_search" || tool === "web_fetch") {
          found.add("web");
        } else if (tool === "browser") {
          found.add("browser");
        } else if (tool === "sandbox") {
          found.add("code");
        } else if (tool === "image") {
          found.add("image");
        } else if (tool === "http") {
          found.add("connectors");
        }
      }
      if (step.mcp?.length || step.connections?.length) {
        found.add("connectors");
      }
    } else if (step.type === "generate") {
      if (step.asset === "image") {
        found.add("image");
      } else if (step.asset === "video") {
        found.add("video");
      } else if (step.asset === "voice") {
        found.add("speech");
      } else {
        found.add("text");
      }
    } else if (step.type === "film") {
      found.add("film");
    }
  }
  if (def.connections?.length) {
    found.add("connectors");
  }
  return CAPABILITY_IDS.filter((c) => found.has(c));
}

/** The plugins a definition's steps use, by id: a runtime without one of them cannot run it. */
export function pluginsOf(def: WizardDefinition): string[] {
  const found = new Set<string>();
  for (const step of def.steps) {
    if (step.type === "agent") {
      for (const tool of step.call ? [...step.tools, step.call.tool] : step.tools) {
        const of = pluginToolOf(tool);
        if (of) {
          found.add(of.plugin);
        }
      }
    }
  }
  return [...found].sort();
}

/** The plan a wizard needs: Pro as soon as it uses a plugin. */
export const planOf = (plugins: readonly string[]): MarketplacePlan =>
  plugins.length ? "pro" : "free";

/** What a person does in a run, and about how long the whole run takes. */
export interface Effort {
  /** Fields to fill in, the required ones of them. */
  fields: number;
  required: number;
  /** Stops where the person looks at a result before it goes on. */
  reviews: number;
  /** Minutes from start to result: filling in, plus the time the steps work. */
  minutes: number;
}

const WORK_SECONDS = { agent: 25, tools: 70, browser: 150, image: 30, video: 120, voice: 20 };

export function effortOf(def: WizardDefinition): Effort {
  let fields = 0;
  let required = 0;
  let reviews = 0;
  let seconds = 0;
  for (const step of def.steps) {
    if (step.type === "page") {
      fields += step.fields.length;
      required += step.fields.filter((f) => f.required).length;
      seconds += step.fields.length * 15;
    } else if (step.type === "review") {
      reviews += 1;
      seconds += 30;
    } else if (step.type === "agent" && step.call) {
      seconds += 1;
    } else if (step.type === "agent") {
      seconds += step.tools.includes("browser")
        ? WORK_SECONDS.browser
        : step.tools.length || step.mcp?.length || step.connections?.length
          ? WORK_SECONDS.tools
          : WORK_SECONDS.agent;
    } else if (step.type === "generate") {
      // "each" makes one result per entry; three stands in for a number nobody knows yet.
      const times = step.each ? 3 : 1;
      seconds +=
        times *
        (step.asset === "image"
          ? WORK_SECONDS.image
          : step.asset === "video"
            ? WORK_SECONDS.video
            : step.asset === "voice"
              ? WORK_SECONDS.voice
              : WORK_SECONDS.agent);
    } else if (step.type === "widget" && step.video) {
      seconds += 60;
    } else if (step.type === "film") {
      // A client writing a film from a style kit: ten minutes to half an hour (2026-10 tests).
      seconds += 25 * 60;
    }
  }
  return { fields, required, reviews, minutes: Math.max(1, Math.round(seconds / 60)) };
}

/** How expensive a run is, where no price in credits is known: by what it makes and uses. */
export function costTierOf(capabilities: Capability[]): CostTier {
  if (capabilities.includes("video")) {
    return "high";
  }
  return capabilities.some((c) => c === "image" || c === "browser" || c === "speech")
    ? "medium"
    : "low";
}

// --- what the marketplace answers (docs/marketplace-contract.md) -----------------------------

/** One entry as the marketplace lists it, in a language. */
export interface MarketplaceSummary {
  id: string;
  /** Goes up whenever the entry changes. */
  revision: number;
  /** Of everything the entry is made of, every language and file: changes with any of it. */
  hash: string;
  /** When the entry last changed, ISO 8601. */
  updatedAt: string;
  /** One of the entries an app keeps for offline use without being asked. */
  starter: boolean;
  /** The language of `title` and `pitch`; the entry's own where it is not translated. */
  language: MarketplaceLang;
  title: string;
  pitch: string;
  /** What people ask for when they mean this entry: searched, never shown. */
  terms: string[];
  avatar: string;
  formats: ItemFormat[];
  industries: Industry[];
  useCases: UseCase[];
  capabilities: Capability[];
  effort: Effort;
  costTier: CostTier;
  steps: number;
  /** The definition version the entry's wizard is written in (`DEFINITION_VERSION`). */
  version: number;
  /**
   * The plugins its wizard uses, by id (`pluginsOf`). A marketplace older than this field leaves
   * it out: read it as none.
   */
  plugins?: string[];
  /** The plan it needs (`planOf`); left out by an older marketplace: free. */
  plan?: MarketplacePlan;
  /**
   * The plugin's own starter this entry shows in the catalog, `<plugin id>.<starter id>`: a
   * runtime with that plugin lists the plugin's starter instead.
   */
  pluginStarter?: string;
}

/** What a search narrows by, besides its words. */
export interface MarketplaceFilters {
  useCase?: UseCase;
  industry?: Industry;
  format?: ItemFormat;
  capability?: Capability;
  plan?: MarketplacePlan;
}

/** Per option of a filter: the entries it would leave, with the other filters as they are. */
export interface MarketplaceFacets {
  useCase: Partial<Record<UseCase, number>>;
  industry: Partial<Record<Industry, number>>;
  format: Partial<Record<ItemFormat, number>>;
  /** Optional: a marketplace older than this filter leaves it out. */
  capability?: Partial<Record<Capability, number>>;
  /** Optional: a marketplace older than this filter leaves it out. */
  plan?: Partial<Record<MarketplacePlan, number>>;
}

/** A page of a search: the entries, best first, how many there are, and the filters' counts. */
export interface MarketplacePage<T extends MarketplaceSummary = MarketplaceSummary> {
  entries: T[];
  total: number;
  /** Every published entry, before words and filters. */
  all: number;
  facets: MarketplaceFacets;
}

/** One entry with its wizard in a language: what an app starts a wizard from. */
export interface MarketplaceItem extends MarketplaceSummary {
  /** The wizard as written; an app reads it with its own schema. */
  definition: unknown;
  /** The workspace it starts with: path → base64. */
  files: Record<string, string>;
}

/** Everything of an entry, every language: what an app keeps for offline use. */
export interface MarketplaceExport extends MarketplaceSummary {
  texts: {
    language: MarketplaceLang;
    title: string;
    pitch: string;
    definition: unknown;
    /** Written by a model, not by a person. */
    machine: boolean;
  }[];
  /** path → base64 */
  files: Record<string, string>;
}

/** What an app compares with what it keeps: an entry changed where its hash differs. */
export interface MarketplaceSyncItem {
  id: string;
  hash: string;
  updatedAt: string;
}

/** One entry as the app shows it: the summary, read against this app. */
export interface MarketplaceEntry extends MarketplaceSummary {
  /** A run's price in credits and what it rarely exceeds; null where it is not worked out. */
  credits: { credits: number; high: number } | null;
  /** False: this app is older than the entry and would read its wizard wrongly. */
  usable: boolean;
  /** The person keeps it for offline use. */
  starred: boolean;
  /** What it needs that this runtime has no model for: a wizard made from it would not start. */
  missing: Capability[];
  /** What only some of its paths need and this runtime has no model for: it runs the other ways. */
  optional: Capability[];
  /** It comes with a plugin of this app, not from the marketplace: the plugin's id and name. */
  plugin?: { id: string; name: string };
  /** The plugins it needs that this app does not have: a wizard made from it would not run. */
  needs?: string[];
}
