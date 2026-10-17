// SPDX-License-Identifier: FSL-1.1-MIT OR MIT
import { z } from "zod";
import { tableColumnsSchema } from "./engenty/data-tables/index.js";
import { readNumber } from "./numbers.js";
import { type ObjectShape, outputShapeSchema, shapeOfFields } from "./shape.js";
import { CONNECTION_KINDS } from "./store.js";
import { type SurfaceComponent, surfaceComponentsSchema, validateSurface } from "./surface.js";

/** The engenty avatars a wizard can wear. Same cast as engenty's ui-core. */
export const ENGENTY_KINDS = [
  "round",
  "drop",
  "dome",
  "flame",
  "oval",
  "bean",
  "pebble",
  "sprout",
  "tower",
  "wedge",
] as const;
export type EngentyKind = (typeof ENGENTY_KINDS)[number];

// --- languages -------------------------------------------------------------------------------

/**
 * The languages engenty speaks: the studio, the runner, the mails, a wizard's own words. A
 * language joins once its strings are written; English is the one every string has, and what a
 * language still lacks is said in English.
 */
export const LANGS = ["en", "de"] as const;
export type Lang = (typeof LANGS)[number];

/** Each language's name, in that language: what a switch or a menu shows. */
export const LANG_NAMES: Record<Lang, string> = { en: "English", de: "Deutsch" };

/** The locale amounts and dates are written in for a language. */
export const LOCALES: Record<Lang, string> = { en: "en-GB", de: "de-DE" };

/** The locale speech is heard and spoken in for a language (recognition, voices). */
export const SPEECH_LOCALES: Record<Lang, string> = { en: "en-US", de: "de-DE" };

export function isLang(value: unknown): value is Lang {
  return typeof value === "string" && (LANGS as readonly string[]).includes(value);
}

/** The language of a tag such as "de-AT", "fr" or "pt_BR", where engenty speaks it. */
export function langOf(tag: string | null | undefined): Lang | null {
  const code = tag?.trim().toLowerCase().split(/[-_]/)[0];
  return isLang(code) ? code : null;
}

/**
 * The main language of each European country. It holds languages engenty does not speak yet:
 * `langOf` passes over them until they join `LANGS`.
 */
const COUNTRY_LANGUAGE: Record<string, string> = {
  AT: "de",
  BE: "nl",
  BG: "bg",
  CH: "de",
  CY: "el",
  CZ: "cs",
  DE: "de",
  DK: "da",
  EE: "et",
  ES: "es",
  FI: "fi",
  FR: "fr",
  GB: "en",
  GR: "el",
  HR: "hr",
  HU: "hu",
  IE: "en",
  IS: "is",
  IT: "it",
  LI: "de",
  LT: "lt",
  LU: "fr",
  LV: "lv",
  MC: "fr",
  MT: "en",
  NL: "nl",
  NO: "nb",
  PL: "pl",
  PT: "pt",
  RO: "ro",
  RS: "sr",
  SE: "sv",
  SI: "sl",
  SK: "sk",
  SM: "it",
  UA: "uk",
  VA: "it",
};

/**
 * The languages a wizard is offered in when its author picks one: English, German and the main
 * languages of Europe. A wizard may name any other real language by its code as well.
 */
export const WIZARD_LANGS: readonly string[] = [
  ...new Set(["en", "de", ...Object.values(COUNTRY_LANGUAGE)]),
];

/** The country of each European time zone (IANA names, as `Intl` gives them). */
const ZONE_COUNTRY: Record<string, string> = {
  "Europe/Amsterdam": "NL",
  "Europe/Athens": "GR",
  "Europe/Belgrade": "RS",
  "Europe/Berlin": "DE",
  "Europe/Bratislava": "SK",
  "Europe/Brussels": "BE",
  "Europe/Bucharest": "RO",
  "Europe/Budapest": "HU",
  "Europe/Busingen": "DE",
  "Europe/Copenhagen": "DK",
  "Europe/Dublin": "IE",
  "Europe/Helsinki": "FI",
  "Europe/Kiev": "UA",
  "Europe/Kyiv": "UA",
  "Europe/Lisbon": "PT",
  "Europe/Ljubljana": "SI",
  "Europe/London": "GB",
  "Europe/Luxembourg": "LU",
  "Europe/Madrid": "ES",
  "Europe/Malta": "MT",
  "Europe/Monaco": "MC",
  "Europe/Oslo": "NO",
  "Europe/Paris": "FR",
  "Europe/Prague": "CZ",
  "Europe/Riga": "LV",
  "Europe/Rome": "IT",
  "Europe/San_Marino": "SM",
  "Europe/Sofia": "BG",
  "Europe/Stockholm": "SE",
  "Europe/Tallinn": "EE",
  "Europe/Vaduz": "LI",
  "Europe/Vatican": "VA",
  "Europe/Vienna": "AT",
  "Europe/Vilnius": "LT",
  "Europe/Warsaw": "PL",
  "Europe/Zagreb": "HR",
  "Europe/Zurich": "CH",
  "Atlantic/Canary": "ES",
  "Atlantic/Madeira": "PT",
  "Atlantic/Reykjavik": "IS",
  "Asia/Nicosia": "CY",
};

/**
 * The person's own language beside English: the first of their languages (the browser's, in
 * its order) that engenty speaks, else the main language of the country their time zone lies
 * in; null where neither names one.
 */
export function localLang(languages: readonly string[], timeZone?: string | null): Lang | null {
  for (const tag of languages) {
    const found = langOf(tag);
    if (found && found !== "en") {
      return found;
    }
  }
  const country = timeZone ? ZONE_COUNTRY[timeZone] : undefined;
  const found = country ? langOf(COUNTRY_LANGUAGE[country]) : null;
  return found === "en" ? null : found;
}

/**
 * A language a wizard can be translated into: any language, by its two- or three-letter code
 * ("fr", "it", "pl"), not only those of `LANGS`.
 */
export const LANG_CODE = /^[a-z]{2,3}$/;

/** The code of a tag such as "fr-CA" or "pt_BR"; null where it names no language. */
export function langCodeOf(tag: string | null | undefined): string | null {
  const code = tag?.trim().toLowerCase().split(/[-_]/)[0] ?? "";
  return LANG_CODE.test(code) ? code : null;
}

/**
 * A real language, as the platform's own language data knows it: "it" and "nb" are, "xx" is
 * not. The schema only checks the shape of a code; this checks that it names a language.
 */
export function isRealLanguage(code: string): boolean {
  if (!LANG_CODE.test(code)) {
    return false;
  }
  try {
    return Boolean(new Intl.DisplayNames(["en"], { type: "language", fallback: "none" }).of(code));
  } catch {
    return false;
  }
}

/** The language engenty's own strings are read in for any language: itself where they are written, else English. */
export function textLang(code: string): Lang {
  return isLang(code) ? code : "en";
}

/**
 * The language the person reads, for a wizard translated on request: the first of their
 * languages (the browser's, in its order), else the main language of the country their time
 * zone lies in. Any language, not only one engenty's own strings are written in.
 */
export function viewerLang(languages: readonly string[], timeZone?: string | null): string | null {
  for (const tag of languages) {
    const code = langCodeOf(tag);
    if (code) {
      return code;
    }
  }
  const country = timeZone ? ZONE_COUNTRY[timeZone] : undefined;
  return country ? langCodeOf(COUNTRY_LANGUAGE[country]) : null;
}

/** A language's name in that language, as a switch shows it: "Italiano", "Polski". */
export function langName(code: string): string {
  if (isLang(code)) {
    return LANG_NAMES[code];
  }
  try {
    const name = new Intl.DisplayNames([code], { type: "language" }).of(code) ?? code;
    return name.charAt(0).toLocaleUpperCase(code) + name.slice(1);
  } catch {
    return code.toUpperCase();
  }
}

/** A language's name in English, for a model told what to write in: "Italian". */
export function langNameEn(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** The locale amounts, dates and plural forms are written in for any language. */
export function localeOf(code: string): string {
  return isLang(code) ? LOCALES[code] : code;
}

/** The locale speech is recognised and read aloud in for any language. */
export function speechLocaleOf(code: string): string {
  return isLang(code) ? SPEECH_LOCALES[code] : code;
}

export const FIELD_KINDS = [
  "text",
  "textarea",
  "number",
  "select",
  "multiselect",
  "date",
  "email",
  "url",
  "toggle",
  "color",
  "image",
  "file",
  "items",
  "connection",
  "list",
  "location",
  "audio",
  "signature",
  "slot",
] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

/**
 * How a field is answered without the page's form: `typed` as text, `tapped` from its choices,
 * `value` as a plain value (a colour, line items, a place), `device` only with the person's
 * device or account (a file, a recording, a signature, a connection, a kept list). The chat
 * types and taps; an AI client over MCP gives every way but `device`.
 */
export type FieldWay = "typed" | "tapped" | "value" | "device";

export const FIELD_WAYS: Record<FieldKind, FieldWay> = {
  text: "typed",
  textarea: "typed",
  number: "typed",
  date: "typed",
  email: "typed",
  url: "typed",
  select: "tapped",
  multiselect: "tapped",
  slot: "tapped",
  toggle: "tapped",
  color: "value",
  items: "value",
  location: "value",
  image: "device",
  file: "device",
  audio: "device",
  signature: "device",
  connection: "device",
  list: "device",
};

/**
 * What a `location` field holds: where the person stands (from the device), a place they typed,
 * or both — the label is then the address of the position.
 */
export interface LocationValue {
  lat?: number;
  lng?: number;
  /** Radius in metres the device vouches for. */
  accuracy?: number;
  label?: string;
}

/** What an `audio` field holds: the recording, and what is said in it once it was listened to. */
export interface AudioValue {
  /** Upload id of the recording. */
  asset: string;
  seconds?: number;
  transcript?: string;
  /** The language the runner was in when the note was taken: what it is most likely spoken in. */
  lang?: Lang;
}

export function isLocationValue(v: unknown): v is LocationValue {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    return false;
  }
  const { lat, lng, label } = v as LocationValue;
  return (
    (typeof lat === "number" && typeof lng === "number") ||
    (typeof label === "string" && label.trim().length > 0)
  );
}

export function isAudioValue(v: unknown): v is AudioValue {
  return Boolean(
    v &&
      typeof v === "object" &&
      typeof (v as AudioValue).asset === "string" &&
      (v as AudioValue).asset,
  );
}

/** A position the way a person reads it: "Hauptplatz 1, Graz (47.07071, 15.43950, ±12 m)". */
export function locationText(v: LocationValue): string {
  const point =
    typeof v.lat === "number" && typeof v.lng === "number"
      ? `${v.lat.toFixed(5)}, ${v.lng.toFixed(5)}${v.accuracy ? `, ±${Math.round(v.accuracy)} m` : ""}`
      : "";
  const label = v.label?.trim() ?? "";
  return label && point ? `${label} (${point})` : label || point;
}

/** A field takes at most this many files. */
export const MAX_FILES = 30;

export const TOOL_IDS = [
  "web_search",
  "web_fetch",
  "browser",
  "sandbox",
  "image",
  "http",
  "pages",
  "code",
] as const;

/**
 * A tool a plugin of the runtime adds: `<plugin id>.<tool name>`. A wizard that names one runs
 * only where that plugin is installed.
 */
export const PLUGIN_ID = /^[a-z][a-z0-9-]{0,39}$/;
export const PLUGIN_TOOL_NAME = /^[a-z][a-z0-9_]{0,39}$/;
export type PluginToolId = `${string}.${string}`;

/** The plugin and the tool a step's tool id names, or null for one of the built-in tools. */
export function pluginToolOf(id: string): { plugin: string; tool: string } | null {
  const [plugin, tool, ...rest] = id.split(".");
  return tool !== undefined &&
    rest.length === 0 &&
    PLUGIN_ID.test(plugin) &&
    PLUGIN_TOOL_NAME.test(tool)
    ? { plugin, tool }
    : null;
}

/**
 * The kinds of model a step can ask for. A step names a class; which model serves it is bound
 * outside the wizard (the model-gateway, or the settings of a runtime that runs alone).
 */
export const TEXT_CLASSES = ["classifier", "standard", "high", "highest"] as const;
export type TextClass = (typeof TEXT_CLASSES)[number];
export const MODEL_CLASSES = [...TEXT_CLASSES, "image", "video", "audio", "speech"] as const;
export type ModelClass = (typeof MODEL_CLASSES)[number];
/** How hard the model should think, where the bound model can be told. */
export const EFFORTS = ["low", "medium", "high"] as const;
export type Effort = (typeof EFFORTS)[number];
export type ToolId = (typeof TOOL_IDS)[number];

export const ASSET_KINDS = ["image", "video", "voice", "document", "dashboard"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export const FORMATS = [
  "png",
  "mp4",
  "mp3",
  "pdf",
  "docx",
  "html",
  "md",
  "txt",
  "csv",
  "xlsx",
  "json",
  "zip",
] as const;
export type Format = (typeof FORMATS)[number];

export const ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:5", "3:2", "2:3"] as const;

/** What a video model renders at: 720p unless the step asks for less. Never more. */
export const VIDEO_RESOLUTIONS = ["720p", "480p"] as const;
export type VideoResolution = (typeof VIDEO_RESOLUTIONS)[number];

const id = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/, "ids are letters, digits and _ and start with a letter");

export const itemColumnSchema = z.object({
  id,
  label: z.string().min(1),
  kind: z.enum(["text", "number", "money"]),
});

export const CONDITION_OPS = [
  "equals",
  "notEquals",
  "in",
  "notEmpty",
  "empty",
  "gt",
  "lt",
  "contains",
] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];

/**
 * One test on what the run knows: an answer by field id, an output of an agent step as
 * "steps.<step>.<field>", or how many rows a stored list has as "lists.<list>.count".
 */
export const conditionSchema = z.object({
  field: z.string(),
  op: z.enum(CONDITION_OPS),
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]).optional(),
});
export type Condition = z.infer<typeof conditionSchema>;

/** One condition, or several that must all hold. */
export const whenSchema = z.union([conditionSchema, z.array(conditionSchema).min(1)]);
export type When = z.infer<typeof whenSchema>;

/** What a card of a choice shows: the columns of the table the choices come from. */
export const cardsSchema = z.object({
  label: z.string().min(1),
  value: z.string().optional(),
  image: z.string().optional(),
  subtitle: z.string().optional(),
  meta: z.string().optional(),
  link: z.string().optional(),
});
export type CardsDef = z.infer<typeof cardsSchema>;

/** A choice drawn as a card, as the runner gets it. */
export interface CardOption {
  value: string;
  label: string;
  image?: string;
  subtitle?: string;
  meta?: string;
  link?: string;
}

export const fieldSchema = z.object({
  id,
  label: z.string().min(1),
  kind: z.enum(FIELD_KINDS),
  required: z.boolean().optional(),
  placeholder: z.string().optional(),
  help: z.string().optional(),
  /**
   * Choices for select / multiselect. slot: the appointment times offered, as ISO 8601 date-times
   * with their offset ("2026-10-12T09:00:00+02:00").
   */
  options: z.array(z.string()).optional(),
  default: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]).optional(),
  /** Line-item columns for `items`. A row's amount is the product of its number and money columns. */
  columns: z.array(itemColumnSchema).optional(),
  /** VAT for `items`: a fixed rate in percent, or the id of a number/select field holding it. */
  vat: z.object({ rate: z.number().optional(), field: z.string().optional() }).optional(),
  currency: z.string().optional(),
  /** image / file: several files; the value is then a list, in the order the person put them. */
  multiple: z.boolean().optional(),
  /** image / file with `multiple`: how many files at least and at most (up to 30). */
  min: z.number().int().min(1).max(MAX_FILES).optional(),
  max: z.number().int().min(1).max(MAX_FILES).optional(),
  /** file: also offer the camera, for documents the person only has on paper. Images always offer it. */
  camera: z.boolean().optional(),
  /** file: the camera also records short video clips. */
  video: z.boolean().optional(),
  /**
   * file: a recording (video or audio) is listened to before the next step runs — what is said,
   * piece by piece between pauses, with exact times. Read as {{field.speech}}.
   */
  listen: z.boolean().optional(),
  /** text: also fill it by scanning a QR code or barcode with the camera. */
  scan: z.boolean().optional(),
  /** connection: id of the wizard connection the person connects here. */
  connection: z.string().optional(),
  /** list: id of the wizard list shown here for the person to check and correct. */
  list: z.string().optional(),
  /**
   * What the field starts with, from an earlier step: "steps.<id>" or "steps.<id>.<key>". An
   * `items` field takes a table whose columns are its column ids; the person corrects it.
   */
  prefill: z.string().optional(),
  /**
   * The field is shown only while this holds. It reads an answer of this page (decided as the
   * person types) or anything known before the page. A hidden field is not asked and not kept.
   */
  when: whenSchema.optional(),
  /**
   * select / multiselect / slot: the choices come from earlier data — a list output
   * ("steps.<id>.<key>"), a column of a table output ("steps.<id>.<key>.<column>") or a column
   * of a stored list ("lists.<id>.<column>"). `options` stand in while that data is empty.
   */
  optionsFrom: z.string().optional(),
  /**
   * select / multiselect with `optionsFrom` naming a table output ("steps.<id>.<key>"): each row
   * is a choice drawn as a card. The columns that hold what the card shows; `value` (default:
   * `label`) is what the answer holds, `link` a page the card opens.
   */
  cards: cardsSchema.optional(),
  /**
   * The field is shown when a decision, made as the run reaches the page, finds this statement
   * true of the run ("The complaint is about a damaged article").
   */
  ask: z.string().min(1).optional(),
  /** The id of one of the page's `groups`: of a group's fields a decision shows one (or none). */
  group: z.string().optional(),
});
export type Field = z.infer<typeof fieldSchema>;

export const fieldGroupSchema = z.object({
  id,
  /** What the decision picks: "How should we reach the person?" */
  instructions: z.string().min(1),
  /** True when showing none of the group's fields is a valid answer. */
  optional: z.boolean().optional(),
});

export const nextRuleSchema = z
  .object({
    /** The rule holds when this holds … */
    when: whenSchema.optional(),
    /**
     * … or, instead, when a decision finds this statement true of the run ("The person wants a
     * refund"). All `ask` rules of a step are decided together, after no `when` rule matched.
     */
    ask: z.string().min(1).optional(),
    /**
     * A step id, or "end". A rule with neither `when` nor `ask` is the step's "otherwise": where
     * the run goes when no other rule holds, in place of the next step in the list.
     */
    goto: z.string(),
    /**
     * How often this rule may send the run on in one run; afterwards it is skipped. Meant for a
     * branch back to an earlier step (a loop), which without it is taken at most ten times.
     */
    max: z.number().int().min(1).max(50).optional(),
  })
  .refine((rule) => rule.when === undefined || rule.ask === undefined, {
    message: 'A branch has "when" or "ask", not both.',
  });
export type NextRule = z.infer<typeof nextRuleSchema>;

const stepBase = {
  id,
  title: z.string().min(1),
  description: z.string().optional(),
  next: z.array(nextRuleSchema).optional(),
};

export const outputFieldSchema = z
  .object({
    id,
    kind: z.enum(["text", "number", "list", "table", "yesno", "choice", "score"]),
    /** What the field holds; for `yesno`, `choice` and `score` the question it answers. */
    description: z.string().optional(),
    /** Table only: the exact column keys every row has — what a widget reads. */
    columns: z.array(z.string().min(1)).optional(),
    /** Choice: the options, one of which is the answer. Score: the levels, lowest first. */
    options: z.array(z.string().min(1)).min(2).max(40).optional(),
  })
  .refine(
    (field) =>
      (field.kind !== "choice" && field.kind !== "score") || Boolean(field.options?.length),
    { message: "A choice or score field lists its options.", path: ["options"] },
  )
  .refine((field) => field.kind !== "score" || (field.options?.length ?? 0) <= 10, {
    message: "A score has at most ten levels.",
    path: ["options"],
  });

export const pageStepSchema = z.object({
  ...stepBase,
  type: z.literal("page"),
  fields: z.array(fieldSchema).min(1),
  /** Fields of which a decision shows one: see `group` on a field. */
  groups: z.array(fieldGroupSchema).max(6).optional(),
  cta: z.string().optional(),
});

/** A plugin's tool as a step names it: `<plugin>.<tool>`. */
const pluginToolIdSchema = z.templateLiteral([
  z.string().regex(PLUGIN_ID),
  ".",
  z.string().regex(PLUGIN_TOOL_NAME),
]);

export const agentStepSchema = z.object({
  ...stepBase,
  type: z.literal("agent"),
  /** What the agent does. A template: {{field}}, {{steps.id}}, {{brand.name}}. Empty with `call`. */
  instructions: z.string().default(""),
  /**
   * One tool of a plugin, called once with these inputs and no model: its answer is the step's
   * json output, as it is. For data a later page shows unchanged (free appointment times), where
   * a model would only copy it. String inputs are templates; a filled-in whole number or
   * true/false is passed as one, an empty one is left out.
   */
  call: z
    .object({
      tool: pluginToolIdSchema,
      input: z.record(z.string(), z.unknown()).default({}),
    })
    .optional(),
  tools: z.array(z.union([z.enum(TOOL_IDS), pluginToolIdSchema])).default([]),
  /** Ids of project MCP servers this step may use. */
  mcp: z.array(z.string()).optional(),
  /** Ids of wizard connections (the person's accounts) this step may use. */
  connections: z.array(z.string()).optional(),
  output: z
    .object({
      format: z.enum(["text", "markdown", "json"]),
      /** The short form: one level of keys. A step has `fields` or `schema`, not both. */
      fields: z.array(outputFieldSchema).optional(),
      /**
       * json only: nested data (lists of entries with lists of their own), in the kinds of
       * `shape.ts`. Objects nest at most four deep, a hundred keys in all.
       */
      schema: outputShapeSchema.optional(),
      /**
       * json only: a view of the result from the surface catalog, bound to the step's own fields;
       * reviews and the result show it instead of a plain table. Components: written once, the
       * same every run, nothing to pay. `true`: a model composes one each run.
       */
      surface: z.union([z.boolean(), surfaceComponentsSchema]).optional(),
    })
    .default({ format: "markdown" }),
  /** The kind of model the step needs; default `high`. The model itself is bound elsewhere. */
  model: z.enum(TEXT_CLASSES).optional(),
  effort: z.enum(EFFORTS).optional(),
  /** Shown to the person while it works. */
  /**
   * One run of the step per entry, at most twenty: the rows of a table output
   * ("steps.<id>.<key>"), the entries of a list output, or the rows of a stored list
   * ("lists.<id>"). The instructions read the entry as {{item.<column>}}, {{index}}, {{count}}.
   * The output is a table: the entry's columns and the step's output fields, one row per entry.
   */
  each: z.string().optional(),
  working: z.string().optional(),
});

export const generateStepSchema = z.object({
  ...stepBase,
  type: z.literal("generate"),
  asset: z.enum(ASSET_KINDS),
  /** For image/video the visual prompt; for document/dashboard the brief. A template. */
  prompt: z.string().min(1),
  options: z
    .object({
      aspectRatio: z.enum(ASPECT_RATIOS).optional(),
      /** Video length in seconds. */
      duration: z.number().optional(),
      /** Video: the height the model renders at; default 720p, the most there is. */
      resolution: z.enum(VIDEO_RESOLUTIONS).optional(),
      style: z.string().optional(),
      /** Document flavour, steers the layout. */
      template: z.enum(["invoice", "offer", "briefing", "letter", "report", "free"]).optional(),
    })
    .optional(),
  /**
   * The image the image/video model starts from: an earlier image field, or an earlier step
   * that made images.
   */
  referenceImage: z.string().optional(),
  /**
   * Image / video: one result per entry instead of one. Names an image field with several
   * uploads, an earlier step that made several images, or a table of an earlier agent step
   * ("steps.<id>.<key>"). The prompt reads the entry as {{item.<column>}}, {{index}}, {{count}};
   * `referenceImage` gives each entry its own image when it holds as many.
   */
  each: z.string().optional(),
  /** For document/dashboard: the kind of model that writes it; default `high`. */
  model: z.enum(TEXT_CLASSES).optional(),
  effort: z.enum(EFFORTS).optional(),
  working: z.string().optional(),
});

export const widgetStepSchema = z.object({
  ...stepBase,
  type: z.literal("widget"),
  /** Workspace path of the widget's HTML. Written once; every run only brings new data. */
  entry: z.string().min(1),
  /** What the widget gets as `wizard.data`: key → a field id, steps.id, steps.id.key, brand.name or today. */
  data: z.record(z.string(), z.string()).default({}),
  /** Workspace path of example data (JSON) for previews before any run. */
  sample: z.string().optional(),
  /**
   * How the run shows it: `fixed` (default) at `size`, scaled to the page; `page` as a part of
   * the page, as wide as it and as tall as its content — a result people scroll and use, not a
   * picture. PNG/PDF/MP4 still render at `size`.
   */
  layout: z.enum(["fixed", "page"]).optional(),
  /** The size the widget is designed for; previews scale it, PNG/PDF/MP4 render at it. */
  size: z
    .object({
      width: z.number().int().min(200).max(3840),
      height: z.number().int().min(200).max(3840),
    })
    .optional(),
  /**
   * The result is a film: the timeline is rendered to an MP4 with sound when the step runs,
   * and that video is what the person sees and downloads.
   */
  video: z.boolean().optional(),
  working: z.string().optional(),
});

/** Formats a film step makes; the composition is drawn for this frame. */
export const FILM_FORMATS = ["16:9", "9:16", "1:1"] as const;
export type FilmFormat = (typeof FILM_FORMATS)[number];

export const FILM_SIZES: Record<FilmFormat, { width: number; height: number }> = {
  "16:9": { width: 1920, height: 1080 },
  "9:16": { width: 1080, height: 1920 },
  "1:1": { width: 1080, height: 1080 },
};

/**
 * A film the AI client installed on this machine makes in a folder of its own: it writes the
 * composition as code (HTML, CSS, JS) with the skills it is given, looks at its frames and fixes
 * them; the runtime renders the MP4. It runs on the person's subscription, never on credits.
 */
export const filmStepSchema = z.object({
  ...stepBase,
  type: z.literal("film"),
  /** What the film is: story, look, what to use. A template. */
  brief: z.string().min(1),
  /**
   * Skill packages the client reads: platform packages ("hyperframes") or a folder of the
   * workspace with a SKILL.md ("skills/<name>").
   */
  skills: z.array(z.string().min(1)).max(12).default(["hyperframes"]),
  /**
   * A style kit in the workspace — a showreel made once with its rules, helpers and stills, as
   * a .zip — unpacked as `showcase/`: the bar every film of this wizard is made to.
   */
  kit: z.string().optional(),
  /**
   * What the film is made from: name → a field id or "steps.<id>". Files (uploads, voice lines,
   * pictures) are copied into `input/<name>/`, text is written to `input/<name>.md`.
   */
  inputs: z.record(z.string(), z.string()).default({}),
  format: z.enum(FILM_FORMATS).default("16:9"),
  /** About how long the film runs, in seconds. */
  seconds: z.number().int().min(3).max(600).optional(),
  /** The kind of model; default `standard` — the kit carries the craft. */
  model: z.enum(TEXT_CLASSES).optional(),
  effort: z.enum(EFFORTS).optional(),
  working: z.string().optional(),
});

/** A piece a decided surface may show: its components (the first has the piece's id) and what it shows. */
export const surfaceCandidateSchema = z.object({
  id,
  /** What this piece shows, for the decision: "A chart of prices per supplier". */
  description: z.string().min(1),
  components: surfaceComponentsSchema,
  /** Pieces of a group exclude each other: the decision shows one (or none, if optional). */
  group: z.string().optional(),
  /** Always shown: a title, the main list. */
  required: z.boolean().optional(),
});

export const surfaceStepSchema = z
  .object({
    ...stepBase,
    type: z.literal("surface"),
    /** A view from the surface catalog, written once like a widget; every run brings new data. */
    components: surfaceComponentsSchema.optional(),
    /**
     * Instead of `components`: pieces a decision picks from per run (no chart when there is
     * nothing to chart), drawn in this order under one column.
     */
    candidates: z.array(surfaceCandidateSchema).max(16).optional(),
    groups: z.array(fieldGroupSchema).max(6).optional(),
    /** What the surface reads as data: key → a field id, steps.id, steps.id.key, lists.id, brand.name or today. */
    data: z.record(z.string(), z.string()).default({}),
    working: z.string().optional(),
  })
  .refine((step) => Boolean(step.components) !== Boolean(step.candidates), {
    message: 'A surface step has either "components" or "candidates".',
  });

/**
 * The components of a decided surface for the pieces kept: one root column holding them in
 * their order. Every piece kept is the same as all of them for the validator.
 */
export function assembleSurface(
  candidates: { id: string; components: SurfaceComponent[] }[],
  kept: Iterable<string>,
): SurfaceComponent[] {
  const keep = new Set(kept);
  const chosen = candidates.filter((c) => keep.has(c.id));
  return [
    { id: "root", component: "Column", children: chosen.map((c) => c.components[0]?.id ?? c.id) },
    ...chosen.flatMap((c) => c.components),
  ];
}

export const reviewStepSchema = z.object({
  ...stepBase,
  type: z.literal("review"),
  /** Step ids whose output is shown. */
  show: z.array(z.string()).min(1),
  edit: z.boolean().optional(),
  regenerate: z.boolean().optional(),
});

export const deliverableSchema = z.object({
  from: z.string(),
  label: z.string().optional(),
  formats: z.array(z.enum(FORMATS)).min(1),
});

export const resultStepSchema = z.object({
  ...stepBase,
  type: z.literal("result"),
  message: z.string().optional(),
  deliverables: z.array(deliverableSchema),
});

export const stepSchema = z.discriminatedUnion("type", [
  pageStepSchema,
  agentStepSchema,
  generateStepSchema,
  widgetStepSchema,
  surfaceStepSchema,
  filmStepSchema,
  reviewStepSchema,
  resultStepSchema,
]);
export type Step = z.infer<typeof stepSchema>;
export type PageStep = z.infer<typeof pageStepSchema>;
export type SurfaceStep = z.infer<typeof surfaceStepSchema>;
export type AgentStep = z.infer<typeof agentStepSchema>;

/**
 * A decision: a step on the classifier class that uses no tools and whose output is only
 * yes/no and choice fields. It is answered in one call, which a model that only decides
 * (no text) can take.
 */
export function isDecisionStep(step: AgentStep): boolean {
  const fields = step.output.fields ?? [];
  return (
    !step.call &&
    !step.output.schema &&
    step.model === "classifier" &&
    step.output.format === "json" &&
    fields.length > 0 &&
    fields.every((f) => f.kind === "yesno" || f.kind === "choice" || f.kind === "score") &&
    !step.each &&
    step.tools.length === 0 &&
    !step.mcp?.length &&
    !step.connections?.length
  );
}

/**
 * What an agent step's json output holds: its schema, or its fields as one. Undefined when it
 * names neither (the model then returns one table).
 */
export function declaredShape(step: AgentStep): ObjectShape | undefined {
  if (step.output.schema) {
    return step.output.schema;
  }
  return step.output.fields?.length ? shapeOfFields(step.output.fields) : undefined;
}

/** What an agent step's json output holds: its declared shape, or else one table. */
export function stepShape(step: AgentStep): ObjectShape {
  return (
    declaredShape(step) ?? {
      kind: "object",
      fields: { data: { kind: "table", description: "The result as a table" } },
    }
  );
}

/** The top-level keys of an agent step's output: what `steps.<id>.<key>` may name. */
export function outputKeys(step: AgentStep): string[] {
  return Object.keys(declaredShape(step)?.fields ?? {});
}
export type GenerateStep = z.infer<typeof generateStepSchema>;
export type WidgetStep = z.infer<typeof widgetStepSchema>;
export type FilmStep = z.infer<typeof filmStepSchema>;
export type ReviewStep = z.infer<typeof reviewStepSchema>;
export type ResultStep = z.infer<typeof resultStepSchema>;
export type StepType = Step["type"];

export const listSchema = z.object({
  id,
  title: z.string().min(1),
  description: z.string().optional(),
  /** engenty data-table columns: `{ id, name, type, format }`. */
  columns: tableColumnsSchema,
  /** Column that identifies a row; saving a row with a known key updates it. */
  key: z.string().optional(),
  /**
   * The person goes through the rows one by one in a review: `file` is the column holding the
   * path of a kept file, shown beside the row; `status` a select column whose options are the
   * answers — the first one means "not looked at yet".
   */
  check: z.object({ file: z.string().optional(), status: z.string().optional() }).optional(),
  /**
   * The list is the wizard's, not one person's: every run reads and writes the same rows, and
   * the studio shows it under Space → Data. It is never shown to the person running the wizard,
   * who would see what others gave.
   */
  shared: z.boolean().optional(),
});

export const connectionSchema = z.object({
  id,
  /** A built-in kind of account … */
  kind: z.enum(CONNECTION_KINDS).optional(),
  /** … or the id of one of the project's imported connectors. */
  connector: z.string().optional(),
  /** Imported connectors: the actions steps may call. Default: every action that only reads. */
  actions: z.array(z.string()).max(200).optional(),
  /** Imported connectors, per action: "allow" runs it without asking, "ask" asks the person first. */
  policy: z.record(z.string(), z.enum(["allow", "ask"])).optional(),
  title: z.string().optional(),
  description: z.string().optional(),
});

/** The version of the definition this app writes and reads; raised only by a breaking change. */
export const DEFINITION_VERSION = 1 as const;

export const wizardSchema = z.object({
  version: z.literal(DEFINITION_VERSION).default(DEFINITION_VERSION),
  title: z.string().min(1),
  description: z.string().default(""),
  avatar: z.enum(ENGENTY_KINDS).default("round"),
  /** Shown on the first page above the first question. */
  intro: z.string().optional(),
  /**
   * The language the wizard speaks to people: its texts, the runner's words, its numbers and
   * dates, by its two-letter code ("en", "de", "it"). Any language, not only those engenty's own
   * strings are written in; `validateWizard` checks it names a real one. Without one it is read
   * from the wizard's own words (`wizardLang`).
   */
  lang: z
    .string()
    .regex(/^[a-z]{2}$/)
    .optional(),
  /** Tabular data the wizard keeps between runs, per person — or for all runs (`shared`). */
  lists: z.array(listSchema).max(12).optional(),
  /** Accounts the person connects; kept between runs, per person. */
  connections: z.array(connectionSchema).max(12).optional(),
  steps: z.array(stepSchema).min(1),
});
export type WizardDefinition = z.infer<typeof wizardSchema>;

export const INTERACTIVE: ReadonlySet<StepType> = new Set(["page", "review", "result"]);

/** Which formats each producing step can be downloaded in. */
export function formatsFor(step: Step): Format[] {
  if (step.type === "generate") {
    switch (step.asset) {
      case "image":
        return step.each ? ["png", "zip"] : ["png"];
      case "video":
        return step.each ? ["mp4", "zip"] : ["mp4"];
      case "voice":
        return ["mp3"];
      case "document":
        return ["pdf", "docx", "html", "md", "png"];
      case "dashboard":
        return ["html", "pdf", "png"];
    }
  }
  if (step.type === "film") {
    return ["mp4"];
  }
  if (step.type === "widget") {
    return step.video ? ["mp4", "png"] : ["html", "png", "pdf", "mp4", "json"];
  }
  if (step.type === "surface") {
    return ["json"];
  }
  if (step.type === "agent") {
    if (step.output.format === "json") {
      // Nested data reads as a document too.
      return step.output.schema
        ? ["json", "csv", "xlsx", "md", "pdf", "zip"]
        : ["json", "csv", "xlsx", "md", "zip"];
    }
    return ["md", "txt", "docx", "pdf", "html", "zip"];
  }
  return [];
}

/** Formats a stored list can be downloaded in; zip = the kept files its rows name, with the list. */
export const LIST_FORMATS: Format[] = ["xlsx", "csv", "json", "md", "zip"];

const LIST_REF = /^lists\.([a-zA-Z][a-zA-Z0-9_]*)$/;

/** "lists.providers" → "providers"; anything else → null. */
export function listRef(ref: string): string | null {
  return ref.match(LIST_REF)?.[1] ?? null;
}

export const DEFAULT_WIDGET_SIZE = { width: 1280, height: 720 };

export function widgetSize(step: WidgetStep) {
  return step.size ?? DEFAULT_WIDGET_SIZE;
}

/** A widget data reference without braces: "{{steps.x}}" and "steps.x" mean the same. */
export function dataRef(raw: string): string {
  return raw
    .trim()
    .replace(/^\{\{\s*/, "")
    .replace(/\s*\}\}$/, "");
}

export interface ValidationIssue {
  stepId?: string;
  message: string;
}

const TEMPLATE_RE = /\{\{\s*([^}]+?)\s*\}\}/g;

export function templateRefs(template: string): string[] {
  return [...template.matchAll(TEMPLATE_RE)].map((m) => m[1]);
}

/**
 * Structural checks the schema cannot express: ids, references between steps,
 * templates naming things that exist by the time the step runs.
 */
export function validateWizard(def: WizardDefinition, files?: string[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const stepIds = new Set<string>();
  const fieldIds = new Set<string>();
  const seenSteps = new Set<string>();
  const seenFields = new Set<string>();
  const listIds = new Set<string>();
  const sharedLists = new Set<string>();
  const connectionIds = new Set<string>();
  const notShown = (id: string) =>
    `List "${id}" is shared: every run writes it, so the person running the wizard never sees it.`;

  if (def.lang && !isRealLanguage(def.lang)) {
    issues.push({
      message: `"${def.lang}" isn't a language code. Use a two-letter code such as "en", "de" or "it".`,
    });
  }

  for (const list of def.lists ?? []) {
    if (listIds.has(list.id)) {
      issues.push({ message: `Duplicate list id "${list.id}".` });
    }
    listIds.add(list.id);
    if (list.shared) {
      sharedLists.add(list.id);
      if (list.check) {
        issues.push({ message: `${notShown(list.id)} It cannot be checked row by row.` });
      }
    }
    if (list.key && !list.columns.some((c) => c.id === list.key)) {
      issues.push({ message: `List "${list.id}": key "${list.key}" is not one of its columns.` });
    }
    for (const [role, column] of Object.entries(list.check ?? {})) {
      const found = list.columns.find((c) => c.id === column);
      if (!found) {
        issues.push({
          message: `List "${list.id}": check.${role} "${column}" is not one of its columns.`,
        });
      } else if (role === "status" && found.type !== "select") {
        issues.push({ message: `List "${list.id}": check.status "${column}" must be a select.` });
      }
    }
  }
  for (const connection of def.connections ?? []) {
    if (connectionIds.has(connection.id)) {
      issues.push({ message: `Duplicate connection id "${connection.id}".` });
    }
    connectionIds.add(connection.id);
    if (Boolean(connection.kind) === Boolean(connection.connector)) {
      issues.push({
        message: `Connection "${connection.id}" needs either "kind" or "connector", not both.`,
      });
    }
  }

  for (const step of def.steps) {
    if (stepIds.has(step.id)) {
      issues.push({ stepId: step.id, message: `Duplicate step id "${step.id}".` });
    }
    stepIds.add(step.id);
    if (step.type === "page") {
      for (const field of step.fields) {
        if (fieldIds.has(field.id)) {
          issues.push({ stepId: step.id, message: `Duplicate field id "${field.id}".` });
        }
        fieldIds.add(field.id);
        if (
          (field.kind === "select" || field.kind === "multiselect" || field.kind === "slot") &&
          !field.options?.length &&
          !field.optionsFrom
        ) {
          issues.push({ stepId: step.id, message: `Field "${field.id}" needs options.` });
        }
        if (field.kind === "slot") {
          const wrong = (field.options ?? []).find((o) => !slotTime(o));
          if (wrong !== undefined) {
            issues.push({
              stepId: step.id,
              message: `Field "${field.id}": "${wrong}" is not a date and time with its offset, like "2026-10-12T09:00:00+02:00".`,
            });
          }
        }
        if (field.kind === "items" && !field.columns?.length) {
          issues.push({ stepId: step.id, message: `Field "${field.id}" needs columns.` });
        }
        if (field.kind === "connection" && !connectionIds.has(field.connection ?? "")) {
          issues.push({
            stepId: step.id,
            message: `Field "${field.id}" needs "connection": the id of one of the wizard's connections.`,
          });
        }
        if (field.kind === "list" && !listIds.has(field.list ?? "")) {
          issues.push({
            stepId: step.id,
            message: `Field "${field.id}" needs "list": the id of one of the wizard's lists.`,
          });
        } else if (field.kind === "list" && sharedLists.has(field.list ?? "")) {
          issues.push({
            stepId: step.id,
            message: `Field "${field.id}": ${notShown(field.list ?? "")}`,
          });
        }
        if (field.min !== undefined || field.max !== undefined) {
          if ((field.kind !== "image" && field.kind !== "file") || !field.multiple) {
            issues.push({
              stepId: step.id,
              message: `Field "${field.id}": "min" and "max" count the files of an image or file field with "multiple".`,
            });
          } else if (field.min !== undefined && field.max !== undefined && field.min > field.max) {
            issues.push({
              stepId: step.id,
              message: `Field "${field.id}": min is larger than max.`,
            });
          }
        }
        if (field.scan && field.kind !== "text") {
          issues.push({
            stepId: step.id,
            message: `Field "${field.id}": "scan" fills a text field; kind is "${field.kind}".`,
          });
        }
        if (field.listen && field.kind !== "file") {
          issues.push({
            stepId: step.id,
            message: `Field "${field.id}": "listen" belongs to a file field; kind is "${field.kind}".`,
          });
        }
        if (field.video && field.kind !== "file") {
          issues.push({
            stepId: step.id,
            message: `Field "${field.id}": "video" belongs to a file field; kind is "${field.kind}".`,
          });
        }
      }
    }
  }

  const last = def.steps.at(-1);
  if (last?.type !== "result") {
    issues.push({ message: "The last step must be a result step." });
  }

  const checkTemplate = (step: Step, template: string) => {
    for (const ref of templateRefs(template)) {
      const [head, second] = ref.split(".");
      if (head === "steps") {
        if (!second || !seenSteps.has(second)) {
          issues.push({
            stepId: step.id,
            message: `"{{${ref}}}" refers to a step that has not run before "${step.id}".`,
          });
        }
      } else if (head === "brand" || head === "facts" || head === "today" || head === "notes") {
        // provided by the runner
      } else if (head === "item" || head === "index" || head === "count") {
        if ((step.type !== "generate" && step.type !== "agent") || !step.each) {
          issues.push({
            stepId: step.id,
            message: `"{{${ref}}}" only exists in a generate or agent step with "each".`,
          });
        }
      } else if (head === "lists") {
        if (!second || !listIds.has(second)) {
          issues.push({ stepId: step.id, message: `"{{${ref}}}" refers to an unknown list.` });
        }
      } else if (!seenFields.has(head)) {
        issues.push({
          stepId: step.id,
          message: `"{{${ref}}}" refers to a field that is not asked before "${step.id}".`,
        });
      }
    }
  };

  /**
   * What a condition may read before `step`: an answer asked earlier, an output field of an
   * earlier agent step ("steps.<step>.<field>", the step itself for a branch), or how many rows
   * a stored list has ("lists.<list>.count").
   */
  const knownBefore = (step: Step, ref: string, self = false): boolean => {
    if (seenFields.has(ref)) {
      return true;
    }
    const [head, from, key, ...more] = ref.split(".");
    if (head === "lists") {
      return key === "count" && more.length === 0 && listIds.has(from ?? "");
    }
    // `steps.<step>.<field>.p`: how probable the decision's answer is.
    const probability = more.length === 1 && more[0] === "p";
    if (head !== "steps" || !key || (more.length > 0 && !probability)) {
      return false;
    }
    if (!(seenSteps.has(from) || (self && from === step.id))) {
      return false;
    }
    const source = def.steps.find((s) => s.id === from);
    return (
      source?.type === "agent" &&
      (!probability || isDecisionStep(source)) &&
      (outputKeys(source).includes(key) || (Boolean(source.each) && key === "rows" && !probability))
    );
  };

  const conditionIssues = (stepId: string, c: Condition): ValidationIssue[] => {
    if ((c.op === "gt" || c.op === "lt") && typeof c.value !== "number") {
      return [{ stepId, message: `"${c.op}" on "${c.field}" compares with a number value.` }];
    }
    if (c.op === "in" && !Array.isArray(c.value)) {
      return [{ stepId, message: `"in" on "${c.field}" needs a list of values.` }];
    }
    if (c.op !== "empty" && c.op !== "notEmpty" && c.value === undefined) {
      return [{ stepId, message: `"${c.op}" on "${c.field}" needs a value.` }];
    }
    return [];
  };

  /** Why an `optionsFrom` reference finds nothing, or null when it is fine. */
  const optionsFromProblem = (raw: string, cards?: CardsDef): string | null => {
    const [head, from, key, column, ...more] = dataRef(raw).split(".");
    if (head === "lists" && from && key && !column) {
      const list = def.lists?.find((l) => l.id === from);
      if (!list) {
        return `"optionsFrom" names an unknown list "${from}".`;
      }
      if (sharedLists.has(from)) {
        return notShown(from);
      }
      return list.columns.some((c) => c.id === key)
        ? null
        : `"optionsFrom": list "${from}" has no column "${key}".`;
    }
    if (head === "steps" && from && key && more.length === 0) {
      const source = seenSteps.has(from) ? def.steps.find((s) => s.id === from) : undefined;
      // An agent step with `each` hands on one table, `rows`: the entry's columns and its fields.
      if (source?.type === "agent" && source.each && key === "rows") {
        return column ? null : `"optionsFrom": "${from}.rows" is a table; name one of its columns.`;
      }
      const out = source?.type === "agent" ? declaredShape(source)?.fields[key] : undefined;
      if (!out) {
        return `"optionsFrom" names "${from}.${key}", which is not an output of an earlier agent step.`;
      }
      // The keys of a table's rows, or of a list's entries; undefined: any (free columns).
      const columns =
        out.kind === "table"
          ? out.columns?.length
            ? out.columns
            : undefined
          : out.kind === "list" && out.of.kind === "object"
            ? Object.keys(out.of.fields)
            : null;
      if (columns === null) {
        if (column || cards) {
          return column
            ? `"optionsFrom": "${from}.${key}" is not a table with the column "${column}".`
            : `"cards": "${from}.${key}" is not a table.`;
        }
        return out.kind === "list"
          ? null
          : `"optionsFrom": "${from}.${key}" is not a list (a table takes a column, or "cards").`;
      }
      if (column) {
        return !columns || columns.includes(column)
          ? null
          : `"optionsFrom": "${from}.${key}" is not a table with the column "${column}".`;
      }
      if (cards) {
        const missing = Object.values(cards).find((c) => columns && !columns.includes(c));
        return missing ? `"cards": "${from}.${key}" has no column "${missing}".` : null;
      }
      return `"optionsFrom": "${from}.${key}" is not a list (a table takes a column, or "cards").`;
    }
    return `"optionsFrom" is "steps.<id>.<key>", "steps.<id>.<key>.<column>" or "lists.<id>.<column>".`;
  };

  for (const step of def.steps) {
    switch (step.type) {
      case "page": {
        const groups = new Set<string>();
        for (const g of step.groups ?? []) {
          if (groups.has(g.id)) {
            issues.push({ stepId: step.id, message: `Duplicate field group "${g.id}".` });
          }
          groups.add(g.id);
          if (!step.fields.some((f) => f.group === g.id)) {
            issues.push({ stepId: step.id, message: `Field group "${g.id}" has no fields.` });
          }
        }
        const decided = step.fields.some((f) => f.ask || f.group);
        if (decided && step.fields.length > MAX_DECIDED_FIELDS) {
          issues.push({
            stepId: step.id,
            message: `A page whose fields are decided has at most ${MAX_DECIDED_FIELDS} fields.`,
          });
        }
        for (const field of step.fields) {
          if (field.ask && field.group) {
            issues.push({
              stepId: step.id,
              message: `Field "${field.id}" has "ask" or "group", not both.`,
            });
          }
          if (field.group && !groups.has(field.group)) {
            issues.push({
              stepId: step.id,
              message: `Field "${field.id}" names an unknown group "${field.group}".`,
            });
          }
        }
        for (const field of step.fields) {
          for (const c of conditionsOf(field.when)) {
            const own = step.fields.some((f) => f.id === c.field && f.id !== field.id);
            if (!own && !knownBefore(step, c.field)) {
              issues.push({
                stepId: step.id,
                message: `Field "${field.id}": "when" reads "${c.field}", which is neither on this page nor known before it.`,
              });
            }
            issues.push(...conditionIssues(step.id, c));
          }
          if (field.optionsFrom) {
            const problem =
              field.kind !== "select" && field.kind !== "multiselect" && field.kind !== "slot"
                ? `"optionsFrom" fills the choices of a select, multiselect or slot; kind is "${field.kind}".`
                : field.cards && field.kind === "slot"
                  ? '"cards" draws the choices of a select or multiselect, not of a slot.'
                  : optionsFromProblem(field.optionsFrom, field.cards);
            if (problem) {
              issues.push({ stepId: step.id, message: `Field "${field.id}": ${problem}` });
            }
          } else if (field.cards) {
            issues.push({
              stepId: step.id,
              message: `Field "${field.id}": "cards" needs "optionsFrom" naming a table output.`,
            });
          }
          if (field.prefill) {
            const ref = dataRef(field.prefill);
            if (ref.split(".")[0] !== "steps") {
              issues.push({
                stepId: step.id,
                message: `Field "${field.id}": prefill names an earlier step ("steps.<id>.<key>").`,
              });
            } else {
              checkTemplate(step, `{{${ref}}}`);
            }
          }
          seenFields.add(field.id);
        }
        break;
      }
      case "agent":
        checkTemplate(step, step.instructions);
        if (step.call) {
          checkTemplate(step, JSON.stringify(step.call.input));
          if (step.each) {
            issues.push({ stepId: step.id, message: 'A step with "call" runs once: no "each".' });
          }
          if (step.output.format !== "json") {
            issues.push({
              stepId: step.id,
              message: 'A step with "call" keeps the tool\'s answer: output format "json".',
            });
          }
        } else if (!step.instructions.trim()) {
          issues.push({ stepId: step.id, message: "An AI step needs instructions." });
        }
        for (const c of step.connections ?? []) {
          if (!connectionIds.has(c)) {
            issues.push({ stepId: step.id, message: `Step uses unknown connection "${c}".` });
          }
        }
        if (step.output.surface && step.output.format !== "json") {
          issues.push({
            stepId: step.id,
            message: 'A step composes a view ("surface") of json output only.',
          });
        }
        if (step.output.schema) {
          if (step.output.fields?.length) {
            issues.push({
              stepId: step.id,
              message: 'Output has "fields" or "schema", not both.',
            });
          }
          if (step.output.format !== "json" || step.call) {
            issues.push({
              stepId: step.id,
              message: step.call
                ? 'A step with "call" keeps the tool\'s answer as it is: no "schema".'
                : 'A "schema" describes json output: output format "json".',
            });
          }
        }
        if (Array.isArray(step.output.surface)) {
          // A step with `each` hands over its entries as `rows`.
          for (const issue of validateSurface(
            step.output.surface,
            step.each ? ["rows"] : declaredShape(step),
          )) {
            issues.push({ stepId: step.id, message: `View: ${issue.message}` });
          }
        }
        if (step.each) {
          const ref = dataRef(step.each);
          const list = ref.match(/^lists\.([a-zA-Z][a-zA-Z0-9_]*)$/)?.[1];
          if (list) {
            if (!listIds.has(list)) {
              issues.push({ stepId: step.id, message: `each names an unknown list "${list}".` });
            }
          } else if (ref.startsWith("steps.") && ref.split(".").length === 3) {
            checkTemplate(step, `{{${ref}}}`);
          } else {
            issues.push({
              stepId: step.id,
              message: `each "${step.each}" is "steps.<id>.<key>" (a table or list output) or "lists.<id>".`,
            });
          }
        }
        break;
      case "generate":
        checkTemplate(step, step.prompt);
        checkTemplate(step, step.options?.style ?? "");
        if (
          step.referenceImage &&
          !seenFields.has(step.referenceImage) &&
          !seenSteps.has(step.referenceImage)
        ) {
          issues.push({
            stepId: step.id,
            message: `referenceImage "${step.referenceImage}" is not an earlier field or step.`,
          });
        }
        if (step.each) {
          const ref = dataRef(step.each);
          if (step.asset !== "image" && step.asset !== "video") {
            issues.push({ stepId: step.id, message: `"each" is for image and video steps.` });
          } else if (ref.startsWith("steps.")) {
            checkTemplate(step, `{{${ref}}}`);
          } else if (!seenFields.has(ref) && !seenSteps.has(ref)) {
            issues.push({
              stepId: step.id,
              message: `each "${step.each}" is not an earlier field, step or "steps.<id>.<key>".`,
            });
          }
        }
        break;
      case "widget":
        for (const [key, ref] of Object.entries(step.data)) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
            issues.push({
              stepId: step.id,
              message: `Widget data key "${key}" is not an identifier.`,
            });
          }
          checkTemplate(step, `{{${dataRef(ref)}}}`);
        }
        if (files && !files.includes(step.entry)) {
          issues.push({
            stepId: step.id,
            message: `Widget entry "${step.entry}" is not in the workspace.`,
          });
        }
        if (files && step.sample && !files.includes(step.sample)) {
          issues.push({
            stepId: step.id,
            message: `Widget sample "${step.sample}" is not in the workspace.`,
          });
        }
        break;
      case "surface": {
        for (const [key, ref] of Object.entries(step.data)) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
            issues.push({
              stepId: step.id,
              message: `Surface data key "${key}" is not an identifier.`,
            });
          }
          const list = listRef(dataRef(ref));
          if (list) {
            if (!listIds.has(list)) {
              issues.push({
                stepId: step.id,
                message: `Surface data reads an unknown list "${list}".`,
              });
            }
          } else {
            checkTemplate(step, `{{${dataRef(ref)}}}`);
          }
        }
        const groups = new Set((step.groups ?? []).map((g) => g.id));
        for (const c of step.candidates ?? []) {
          if (c.components[0]?.id !== c.id) {
            issues.push({
              stepId: step.id,
              message: `Surface piece "${c.id}": its first component carries the piece's id.`,
            });
          }
          if (c.group && !groups.has(c.group)) {
            issues.push({
              stepId: step.id,
              message: `Surface piece "${c.id}" names an unknown group "${c.group}".`,
            });
          }
        }
        const components =
          step.components ??
          assembleSurface(
            step.candidates ?? [],
            (step.candidates ?? []).map((c) => c.id),
          );
        for (const issue of validateSurface(components, Object.keys(step.data))) {
          issues.push({ stepId: step.id, message: `Surface: ${issue.message}` });
        }
        break;
      }
      case "film":
        checkTemplate(step, step.brief);
        for (const [name, ref] of Object.entries(step.inputs)) {
          if (!/^[a-z][a-z0-9-]{0,40}$/.test(name)) {
            issues.push({
              stepId: step.id,
              message: `Film input "${name}" is not a folder name (lowercase letters, digits, -).`,
            });
          }
          const r = dataRef(ref);
          if (r.startsWith("steps.")) {
            checkTemplate(step, `{{${r}}}`);
          } else if (!seenFields.has(r)) {
            issues.push({
              stepId: step.id,
              message: `Film input "${name}": "${ref}" is not an earlier field or "steps.<id>".`,
            });
          }
        }
        if (step.kit && !step.kit.endsWith(".zip")) {
          issues.push({ stepId: step.id, message: `Film kit "${step.kit}" is a .zip.` });
        } else if (files && step.kit && !files.includes(step.kit)) {
          issues.push({
            stepId: step.id,
            message: `Film kit "${step.kit}" is not in the workspace.`,
          });
        }
        for (const skill of step.skills) {
          if (skill.startsWith("skills/") && files && !files.includes(`${skill}/SKILL.md`)) {
            issues.push({
              stepId: step.id,
              message: `Skill "${skill}" has no SKILL.md in the workspace.`,
            });
          }
        }
        break;
      case "review":
        for (const ref of step.show) {
          const list = listRef(ref);
          if (list ? !listIds.has(list) : !seenSteps.has(ref)) {
            issues.push({
              stepId: step.id,
              message: `Review shows unknown ${list ? "list" : "step"} "${ref}".`,
            });
          } else if (list && sharedLists.has(list)) {
            issues.push({ stepId: step.id, message: notShown(list) });
          }
        }
        break;
      case "result":
        for (const d of step.deliverables) {
          const list = listRef(d.from);
          if (list ? !listIds.has(list) : !seenSteps.has(d.from)) {
            issues.push({
              stepId: step.id,
              message: `Deliverable from unknown ${list ? "list" : "step"} "${d.from}".`,
            });
          } else if (list && sharedLists.has(list)) {
            issues.push({ stepId: step.id, message: notShown(list) });
          }
        }
        break;
    }
    if ((step.next ?? []).filter(isOtherwise).length > 1) {
      issues.push({
        stepId: step.id,
        message: 'A step has at most one "otherwise" branch (one without "when" and "ask").',
      });
    }
    for (const rule of step.next ?? []) {
      if (rule.goto !== "end" && !stepIds.has(rule.goto)) {
        issues.push({ stepId: step.id, message: `Branch goes to unknown step "${rule.goto}".` });
      }
      // A branch reads what the person answered (on any page), an output field of this or an
      // earlier agent step, or the row count of a stored list.
      for (const c of conditionsOf(rule.when)) {
        if (!fieldIds.has(c.field) && !knownBefore(step, c.field, true)) {
          issues.push({ stepId: step.id, message: `Branch reads unknown field "${c.field}".` });
        }
        issues.push(...conditionIssues(step.id, c));
      }
    }
    seenSteps.add(step.id);
  }
  return issues;
}

/** Parse + validate in one go. */
export function parseWizard(
  input: unknown,
  files?: string[],
):
  | { ok: true; wizard: WizardDefinition; issues: ValidationIssue[] }
  | { ok: false; issues: ValidationIssue[] } {
  const parsed = wizardSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, issues: shapeIssues(parsed.error, input) };
  }
  const issues = validateWizard(parsed.data, files);
  return { ok: true, wizard: parsed.data, issues };
}

function stepLabel(raw: unknown, index: number): string {
  const steps = (raw as { steps?: unknown[] } | null)?.steps;
  const id = (steps?.[index] as { id?: unknown } | undefined)?.id;
  return typeof id === "string" ? `steps[${index}] "${id}"` : `steps[${index}]`;
}

/** Where the shape is wrong, a step named by its id: `steps[2] "draft".title: …`. */
export function shapeIssues(error: z.ZodError, raw: unknown): ValidationIssue[] {
  return error.issues.map((i) => {
    const [head, index, ...rest] = i.path;
    const where =
      head === "steps" && typeof index === "number"
        ? [stepLabel(raw, index), ...rest].join(".")
        : i.path.join(".");
    return { message: `${where || "wizard"}: ${i.message}` };
  });
}

/**
 * What branch rules can read in a run: the person's answers by field id, and the structured
 * output of the steps run so far as `steps.<step>.<field>`.
 */
export function branchValues(
  values: Record<string, unknown>,
  outputs: Record<string, { json?: unknown; decided?: Record<string, number> }>,
  /** Rows per stored list, read as `lists.<list>.count`. */
  listCounts: Record<string, number> = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...values };
  for (const [list, count] of Object.entries(listCounts)) {
    out[`lists.${list}.count`] = count;
  }
  for (const [stepId, output] of Object.entries(outputs)) {
    if (output.json && typeof output.json === "object" && !Array.isArray(output.json)) {
      for (const [key, value] of Object.entries(output.json)) {
        out[`steps.${stepId}.${key}`] = value;
      }
    }
    for (const [key, p] of Object.entries(output.decided ?? {})) {
      out[`steps.${stepId}.${key}.p`] = p;
    }
  }
  return out;
}

/** A branch back to an earlier step without `max` is taken at most this often in one run. */
export const DEFAULT_LOOP_MAX = 10;

/** How a run counts the times it took a branch: "<step>→<goto>". */
export function loopKey(stepId: string, goto: string): string {
  return `${stepId}→${goto}`;
}

/** Whether a rule may still send the run on: one with `max`, or one back, stops after so many. */
export function ruleOpen(
  def: WizardDefinition,
  stepId: string,
  rule: NextRule,
  loops: Record<string, number> = {},
): boolean {
  const from = def.steps.findIndex((s) => s.id === stepId);
  const to =
    rule.goto === "end" ? def.steps.length : def.steps.findIndex((s) => s.id === rule.goto);
  const max = rule.max ?? (to >= 0 && to <= from ? DEFAULT_LOOP_MAX : Number.POSITIVE_INFINITY);
  return (loops[loopKey(stepId, rule.goto)] ?? 0) < max;
}

/**
 * Where a run goes after a step: the first open `when` rule that holds (`rule` is its index in
 * `next`), else a decision over the open `ask` rules, else the next step in the list. `cursor`
 * null = the end.
 */
export type RuleOutcome =
  | { kind: "go"; cursor: string | null; rule: number | null }
  | { kind: "decide"; rules: number[] };

export function followRules(
  def: WizardDefinition,
  stepId: string,
  values: Record<string, unknown>,
  loops: Record<string, number> = {},
): RuleOutcome {
  const index = def.steps.findIndex((s) => s.id === stepId);
  const step = def.steps[index];
  if (!step) {
    return { kind: "go", cursor: null, rule: null };
  }
  const rules = step.next ?? [];
  for (const [i, rule] of rules.entries()) {
    if (ruleOpen(def, stepId, rule, loops) && ruleMatches(rule, values)) {
      return { kind: "go", cursor: rule.goto === "end" ? null : rule.goto, rule: i };
    }
  }
  const asks = rules.flatMap((rule, i) =>
    rule.ask && ruleOpen(def, stepId, rule, loops) ? [i] : [],
  );
  if (asks.length) {
    return { kind: "decide", rules: asks };
  }
  return { kind: "go", ...otherwiseOf(def, stepId, loops) };
}

/** A rule with neither a condition nor a statement: where the run goes when no other rule holds. */
export function isOtherwise(rule: NextRule): boolean {
  return rule.when === undefined && rule.ask === undefined;
}

/**
 * Where a step goes when none of its rules holds: its "otherwise" rule (`rule` is its index in
 * `next`), else the next step in the list. `cursor` null = the end.
 */
export function otherwiseOf(
  def: WizardDefinition,
  stepId: string,
  loops: Record<string, number> = {},
): { cursor: string | null; rule: number | null } {
  const index = def.steps.findIndex((s) => s.id === stepId);
  const rules = def.steps[index]?.next ?? [];
  const i = rules.findIndex((r) => isOtherwise(r) && ruleOpen(def, stepId, r, loops));
  if (i >= 0) {
    return { cursor: rules[i].goto === "end" ? null : rules[i].goto, rule: i };
  }
  return { cursor: def.steps[index + 1]?.id ?? null, rule: null };
}

/** The step after `step` by its `when` rules alone. `null` = the end. */
export function nextStepId(
  def: WizardDefinition,
  stepId: string,
  values: Record<string, unknown>,
): string | null {
  const outcome = followRules(def, stepId, values);
  if (outcome.kind === "go") {
    return outcome.cursor;
  }
  const index = def.steps.findIndex((s) => s.id === stepId);
  return def.steps[index + 1]?.id ?? null;
}

function isEmptyValue(v: unknown): boolean {
  return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
}

/** The conditions of a rule or a field, as a list: one, several, or none. */
export function conditionsOf(when: When | undefined): Condition[] {
  return when === undefined ? [] : Array.isArray(when) ? when : [when];
}

export function conditionMatches(c: Condition, values: Record<string, unknown>): boolean {
  const v = values[c.field];
  switch (c.op) {
    case "empty":
      return isEmptyValue(v);
    case "notEmpty":
      return !isEmptyValue(v);
    case "equals":
      return String(v) === String(c.value);
    case "notEquals":
      return String(v) !== String(c.value);
    case "in":
      return Array.isArray(c.value) && c.value.map(String).includes(String(v));
    case "gt":
    case "lt": {
      const a = readNumber(v);
      const b = readNumber(c.value);
      return a !== null && b !== null && (c.op === "gt" ? a > b : a < b);
    }
    case "contains":
      if (Array.isArray(v)) {
        return v.map(String).includes(String(c.value));
      }
      return (
        typeof v === "string" &&
        c.value !== undefined &&
        v.toLowerCase().includes(String(c.value).toLowerCase())
      );
  }
}

/** Whether every condition holds; no conditions hold trivially. */
export function whenHolds(when: When | undefined, values: Record<string, unknown>): boolean {
  return conditionsOf(when).every((c) => conditionMatches(c, values));
}

/** Whether a `when` rule holds. An `ask` rule never holds here: a decision takes it (see decide). */
export function ruleMatches(rule: NextRule, values: Record<string, unknown>): boolean {
  return rule.when !== undefined && whenHolds(rule.when, values);
}

/** A page with decided fields has at most this many; it shows at most MAX_SHOWN_FIELDS of them. */
export const MAX_DECIDED_FIELDS = 12;
export const MAX_SHOWN_FIELDS = 5;

/** Whether a field is shown only when a decision keeps it. */
export function isDecidedField(field: Field): boolean {
  return Boolean(field.ask || field.group);
}

/**
 * The fields of a page that are shown: those whose `when` holds on what was known before the
 * page (`known`) and what the page holds so far (`page`). A hidden field's value does not count
 * for the fields after it.
 */
export function shownFields(
  fields: Field[],
  known: Record<string, unknown>,
  page: Record<string, unknown>,
): Field[] {
  const values = { ...known, ...page };
  const out: Field[] = [];
  for (const field of fields) {
    if (whenHolds(field.when, values)) {
      out.push(field);
    } else {
      delete values[field.id];
    }
  }
  return out;
}

/** The references the `when` of a page's fields read outside the page: what the page must know. */
export function pageNeeds(fields: Field[]): string[] {
  const own = new Set(fields.map((f) => f.id));
  return [
    ...new Set(
      fields.flatMap((f) => conditionsOf(f.when).map((c) => c.field)).filter((r) => !own.has(r)),
    ),
  ];
}

/** At most this many choices come from data. */
export const MAX_DATA_OPTIONS = 100;

/**
 * The choices an `optionsFrom` reference finds in a run: the entries of a list output, one
 * column of a table output, or one column of a stored list — as text, without duplicates and
 * empties. Empty when the data is not there (yet).
 */
export function optionsFromData(
  ref: string,
  outputs: Record<string, { json?: unknown }>,
  lists: Record<string, { rows: { cells: Record<string, unknown> }[] }> = {},
  cards?: CardsDef,
): string[] {
  if (cards) {
    return cardsFromData(ref, outputs, cards).map((c) => c.value);
  }
  const [head, id, key, column, ...more] = dataRef(ref).split(".");
  let raw: unknown[] = [];
  if (head === "lists" && id && key && !column) {
    raw = (lists[id]?.rows ?? []).map((r) => r.cells[key]);
  } else if (head === "steps" && id && key && more.length === 0) {
    const json = outputs[id]?.json as Record<string, unknown> | undefined;
    const value = json && typeof json === "object" ? json[key] : undefined;
    if (Array.isArray(value)) {
      raw = column
        ? value.map((row) =>
            row && typeof row === "object" ? (row as Record<string, unknown>)[column] : undefined,
          )
        : value;
    }
  }
  const seen = new Set<string>();
  for (const v of raw) {
    if (v === null || v === undefined || typeof v === "object") {
      continue;
    }
    const text = String(v).trim().slice(0, 200);
    if (text) {
      seen.add(text);
    }
    if (seen.size >= MAX_DATA_OPTIONS) {
      break;
    }
  }
  return [...seen];
}

/** The rows of a table output as cards: what `optionsFrom` with `cards` finds in the run. */
export function cardsFromData(
  ref: string,
  outputs: Record<string, { json?: unknown }>,
  cards: CardsDef,
): CardOption[] {
  const [head, id, key, ...more] = dataRef(ref).split(".");
  if (head !== "steps" || !id || !key || more.length) {
    return [];
  }
  const json = outputs[id]?.json as Record<string, unknown> | undefined;
  const rows = json && typeof json === "object" ? json[key] : undefined;
  if (!Array.isArray(rows)) {
    return [];
  }
  const cell = (row: Record<string, unknown>, column: string | undefined, max = 200) => {
    const v = column ? row[column] : undefined;
    if (v === null || v === undefined || typeof v === "object") {
      return "";
    }
    return String(v).trim().slice(0, max);
  };
  const out: CardOption[] = [];
  const seen = new Set<string>();
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const row = raw as Record<string, unknown>;
    const label = cell(row, cards.label);
    const value = cell(row, cards.value) || label;
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    const card: CardOption = { value, label: label || value };
    const image = cell(row, cards.image, 2000);
    const link = cell(row, cards.link, 2000);
    const subtitle = cell(row, cards.subtitle, 300);
    const meta = cell(row, cards.meta, 80);
    if (/^(https?:|data:|\/)/.test(image) || /^[a-zA-Z0-9_-]{6,64}$/.test(image)) {
      card.image = image;
    }
    if (/^https?:\/\//.test(link)) {
      card.link = link;
    }
    if (subtitle) {
      card.subtitle = subtitle;
    }
    if (meta) {
      card.meta = meta;
    }
    out.push(card);
    if (out.length >= MAX_DATA_OPTIONS) {
      break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Appointment times

const SLOT_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** An offered appointment time read on its own clock: the offset it was written with. */
export interface SlotTime {
  /** The calendar day there: "2026-10-12". */
  day: string;
  /** The time of day there: "09:00". */
  time: string;
  /** That day and time as if it were UTC — to name the weekday and month without moving it. */
  wall: Date;
}

/**
 * A slot option as day and time in its own offset (the business's time zone, not the reader's).
 * Null when it is not an ISO 8601 date-time with an offset.
 */
export function slotTime(iso: string): SlotTime | null {
  const m = SLOT_RE.exec(iso.trim());
  if (!m) {
    return null;
  }
  const [, y, mo, d, h, mi] = m.map(Number);
  const wall = new Date(Date.UTC(y, mo - 1, d, h, mi));
  if (
    wall.getUTCMonth() !== mo - 1 ||
    wall.getUTCDate() !== d ||
    h > 23 ||
    mi > 59 ||
    !Number.isFinite(Date.parse(iso))
  ) {
    return null;
  }
  return { day: `${m[1]}-${m[2]}-${m[3]}`, time: `${m[4]}:${m[5]}`, wall };
}

/** The weekday and date of a slot's day: "Montag, 12. Oktober" / "Monday, 12 October". */
export function slotDayText(iso: string, lang = "en"): string {
  const slot = slotTime(iso);
  if (!slot) {
    return iso;
  }
  const locale = localeOf(lang);
  const weekday = slot.wall.toLocaleDateString(locale, { weekday: "long", timeZone: "UTC" });
  const date = slot.wall.toLocaleDateString(locale, {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
  return `${weekday}, ${date}`;
}

/** A chosen slot as a person reads it back: "Di 13.10.2026, 10:30" / "Tue 13/10/2026, 10:30". */
export function slotText(iso: string, lang = "en"): string {
  const slot = slotTime(iso);
  if (!slot) {
    return iso;
  }
  const locale = localeOf(lang);
  const weekday = slot.wall
    .toLocaleDateString(locale, { weekday: "short", timeZone: "UTC" })
    .replace(/\.$/, "");
  const date = slot.wall.toLocaleDateString(locale, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "UTC",
  });
  return `${weekday} ${date}, ${slot.time}`;
}

/**
 * The slot among `options` that is the same moment as `value`, written as offered — so an answer
 * in another offset ("…T07:00:00Z" for "…T09:00:00+02:00") picks the offered time.
 */
export function offeredSlot(value: string, options: string[]): string | undefined {
  if (options.includes(value)) {
    return value;
  }
  const at = slotTime(value) ? Date.parse(value) : Number.NaN;
  return Number.isFinite(at) ? options.find((o) => slotTime(o) && Date.parse(o) === at) : undefined;
}

// ---------------------------------------------------------------------------
// Line items

export interface ItemsTotals {
  rows: Record<string, unknown>[];
  net: number;
  vatRate: number;
  vat: number;
  gross: number;
  currency: string;
}

export function itemsTotals(
  field: Field,
  value: unknown,
  values: Record<string, unknown>,
): ItemsTotals {
  const rows = Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
  const numeric = (field.columns ?? []).filter((c) => c.kind !== "text");
  const withAmount = rows.map((row) => {
    const amount = numeric.length ? numeric.reduce((acc, c) => acc * amountOf(row[c.id]), 1) : 0;
    return { ...row, amount: round2(amount) };
  });
  const net = round2(withAmount.reduce((a, r) => a + (r.amount as number), 0));
  let vatRate = field.vat?.rate ?? 0;
  if (field.vat?.field) {
    const raw = values[field.vat.field];
    const parsed = readNumber(raw, { units: true });
    if (parsed !== null) {
      vatRate = parsed;
    }
  }
  const vat = round2((net * vatRate) / 100);
  return {
    rows: withAmount,
    net,
    vatRate,
    vat,
    gross: round2(net + vat),
    currency: field.currency ?? "EUR",
  };
}

/** A typed amount as a number: a phone's number pad in German gives "89,90". */
function amountOf(v: unknown): number {
  return readNumber(v) ?? 0;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function allFields(def: WizardDefinition): Field[] {
  return def.steps.flatMap((s) => (s.type === "page" ? s.fields : []));
}

const GERMAN =
  /\b(und|der|die|das|ist|nicht|für|mit|ein|eine|wird|zu|dein|deine|ihr|wir|was|wie|oder)\b|[äöüß]/gi;
const ENGLISH = /\b(and|the|is|not|for|with|a|an|your|you|we|what|how|or|to|of)\b/gi;

/**
 * The language a wizard speaks to people: the one it names, else read from its own words
 * (titles, labels, intro) — English where they are not clearly German.
 */
export function wizardLang(def: WizardDefinition): string {
  if (def.lang) {
    return def.lang;
  }
  const text = [
    def.title,
    def.description,
    def.intro,
    ...def.steps.flatMap((s) => [
      s.title,
      s.description,
      ...(s.type === "page" ? s.fields.flatMap((f) => [f.label, f.help, f.placeholder]) : []),
    ]),
  ]
    .filter(Boolean)
    .join(" ");
  const de = text.match(GERMAN)?.length ?? 0;
  const en = text.match(ENGLISH)?.length ?? 0;
  return de > en ? "de" : "en";
}

// --- can this app read a definition? ---------------------------------------------------------
// The schema drops what it does not know. A definition written for a newer app would be read
// without complaint and run wrongly, so it counts only when nothing of it is lost.

function keepsAll(given: unknown, read: unknown): boolean {
  if (Array.isArray(given)) {
    return Array.isArray(read) && given.every((v, i) => keepsAll(v, read[i]));
  }
  if (given && typeof given === "object") {
    return (
      Boolean(read) &&
      typeof read === "object" &&
      Object.entries(given).every(
        ([k, v]) => v === undefined || (k in (read as object) && keepsAll(v, (read as never)[k])),
      )
    );
  }
  return true;
}

/** True when this app's schema reads the definition without losing anything of it. */
export function readable(definition: unknown): boolean {
  const parsed = wizardSchema.safeParse(definition);
  return parsed.success && keepsAll(definition, parsed.data);
}
