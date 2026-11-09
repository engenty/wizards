// SPDX-License-Identifier: FSL-1.1-MIT OR MIT
import { z } from "zod";
import { calcNames, calcSchema, calcScope, calcTruthy, calcValue, parsedCalc } from "./calc.js";
import { tableColumnsSchema } from "./engenty/data-tables/columns.js";
import { readNumber } from "./numbers.js";
import { type ObjectShape, outputShapeSchema, shapeOfFields } from "./shape.js";
import { isShareTargetId } from "./sharing.js";
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

/** The Halloween costumes a wizard's engenty can wear. Same list as the web app's engenty figures. */
export const ENGENTY_COSTUMES = ["witch", "devil", "bat", "pumpkin"] as const;

/** A theme's id: `halloween`, or `@owner/halloween` for a theme from the catalog (theme.ts). */
export const THEME_ID = /^(@[a-z0-9-]{1,39}\/)?[a-z0-9][a-z0-9-]{0,47}$/;
export type EngentyCostume = (typeof ENGENTY_COSTUMES)[number];

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

/** Whether the reader's English is British: the first English one of their languages is en-GB (or en-UK). */
export function britishEnglish(languages: readonly string[]): boolean {
  const english = languages.find((tag) => langOf(tag) === "en");
  return /^en[-_](gb|uk)\b/i.test(english?.trim() ?? "");
}

/** English as a British reader spells it: "organisation" where the copy says "organization". */
export function britishSpelling(text: string): string {
  return text.replace(/([Oo])rganiz/g, "$1rganis");
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
 * The model classes a step can ask for (its `model`), cheapest first. A step names a class;
 * which model serves it is bound outside the wizard (the model-gateway, or the settings of a
 * runtime that runs alone).
 */
export const TEXT_CLASSES = ["classifier", "low", "standard", "high"] as const;
export type TextClass = (typeof TEXT_CLASSES)[number];
export const MODEL_CLASSES = [...TEXT_CLASSES, "image", "video", "audio", "speech"] as const;
export type ModelClass = (typeof MODEL_CLASSES)[number];
/**
 * The makers a step may name next to its class (`maker`), and each one's classes. With a maker
 * the step asks for `wizards/<maker>/<class>`: the organization's tier binds it to one of that
 * maker's models, never another maker's. `highest` is the top line some makers have; it exists
 * only with a maker. The classifier class takes none.
 */
export const MAKERS = ["anthropic", "openai", "google", "mistral"] as const;
export type Maker = (typeof MAKERS)[number];
export const STEP_CLASSES = [...TEXT_CLASSES, "highest"] as const;
export type StepClass = (typeof STEP_CLASSES)[number];
export const MAKER_CLASSES: Record<Maker, readonly StepClass[]> = {
  anthropic: ["low", "standard", "high", "highest"],
  openai: ["low", "standard", "high", "highest"],
  google: ["low", "standard", "high"],
  mistral: ["low", "high"],
};

/** The text class a step runs on where no maker class can be asked for: `highest` is `high` there. */
export function textClassOf(model: StepClass): TextClass {
  return model === "highest" ? "high" : model;
}

/** What the gateway is asked for: `<maker>/<class>` with a maker, else the class. */
export function classIdOf(step: { model?: StepClass; maker?: Maker }, fallback: TextClass): string {
  const model = step.model ?? fallback;
  return step.maker ? `${step.maker}/${model}` : textClassOf(model);
}

/** Why a step's maker and class don't go together; null where they do. */
export function makerProblem(step: { model?: StepClass; maker?: Maker }): string | null {
  if (!step.maker) {
    return step.model === "highest"
      ? `The class "highest" needs a maker: ${makersWith("highest").join(" or ")}.`
      : null;
  }
  if (!step.model) {
    return `A step with a maker names its class too: one of ${MAKER_CLASSES[step.maker].join(", ")}.`;
  }
  if (step.model === "classifier") {
    return "The classifier class takes no maker.";
  }
  return MAKER_CLASSES[step.maker].includes(step.model)
    ? null
    : `"${step.maker}" has no class "${step.model}": it has ${MAKER_CLASSES[step.maker].join(", ")}.`;
}

function makersWith(model: StepClass): Maker[] {
  return MAKERS.filter((maker) => MAKER_CLASSES[maker].includes(model));
}

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
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "notIn",
  "contains",
  "exists",
  "notExists",
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

/** A condition, or one that must not hold. */
const leafSchema = z.union([conditionSchema, z.object({ not: conditionSchema })]);
export type ConditionLeaf = z.infer<typeof leafSchema>;

/** Holds when one of its parts holds: a condition, or a list of conditions that all hold. */
const anySchema = z.object({
  any: z.array(z.union([leafSchema, z.array(leafSchema).min(1)])).min(1),
});
export type AnyTest = z.infer<typeof anySchema>;

const testSchema = z.union([leafSchema, anySchema]);
export type Test = z.infer<typeof testSchema>;

/**
 * A condition, `{ not }` or `{ any }`, or a list of them that must all hold. The depth is fixed,
 * so the JSON Schema needs no reference to itself.
 */
export const whenSchema = z.union([
  testSchema,
  z.array(testSchema).min(1),
  /** A test conditions cannot write: `budget > demo * 2`, `size == "Groß" or count(items) > 50`. */
  calcSchema,
]);
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
  /**
   * email: a visitor's own address, for telling them the run waits for them or ended. The answer may
   * be a customer's address and the mail carries a link that opens the run, so it has to be meant.
   */
  notify: z.boolean().optional(),
  /** image / file: several files; the value is then a list, in the order the person put them. */
  multiple: z.boolean().optional(),
  /**
   * image / file with `multiple`: how many files at least and at most (whole numbers, 1 to 30).
   * number: the lowest and the highest value the person may give.
   */
  min: z.number().optional(),
  max: z.number().optional(),
  /** number: the value moves in steps of this size (500: 2000, 2500, 3000 …). */
  increment: z.number().positive().optional(),
  /** number: the sign or word after the value ("€", "Personen", "m²"). */
  unit: z.string().max(16).optional(),
  /**
   * How the field is drawn, where its kind has more than one way; without it the runner picks as
   * it always did. number: "slider" (needs min and max; the value stands large above it) or
   * "stepper" (minus and plus). select: "list" (one row with a round button per choice, for
   * choices that need a line of text).
   */
  look: z.enum(["slider", "stepper", "list"]).optional(),
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

/** "90m", "6h", "2d": how long a `wait` lasts. */
export const waitDurationSchema = z
  .string()
  .regex(/^[1-9]\d{0,3}(m|h|d)$/, 'A duration like "90m", "6h" or "2d".');

const WAIT_UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/**
 * What a person's step (a page, a review) may add. Without them it waits for its answer as long as
 * it takes. `timeout`: give up after this long, `steps.<id>.timedOut` is true and `next` decides.
 * `remind`: remind whoever is asked after this long, once.
 */
const personStep = {
  timeout: waitDurationSchema.optional(),
  remind: waitDurationSchema.optional(),
};

const stepBase = {
  id,
  title: z.string().min(1),
  description: z.string().optional(),
  /**
   * The part of the wizard the step belongs to, as the progress bar names it ("Budget"). A step
   * without one belongs to the part before it. Steps on different branches share a name, so the
   * bar stays the same whichever way the run goes.
   */
  section: z.string().min(1).max(24).optional(),
  next: z.array(nextRuleSchema).optional(),
  /** Where the run goes when this step fails for good; without it the run fails. */
  onFail: z.string().optional(),
};

const outputFieldShape = {
  id,
  kind: z.enum(["text", "number", "list", "table", "yesno", "choice", "score"]),
  /** What the field holds; for `yesno`, `choice` and `score` the question it answers. */
  description: z.string().optional(),
  /** Table only: the exact column keys every row has — what a widget reads. */
  columns: z.array(z.string().min(1)).optional(),
  /** Choice: the options, one of which is the answer. Score: the levels, lowest first. */
  options: z.array(z.string().min(1)).min(2).max(40).optional(),
};

/** A choice or a score names its options; a score has at most ten. */
function withOptions<T extends z.ZodType<{ kind: string; options?: string[] }>>(schema: T) {
  return schema
    .refine(
      (field) =>
        (field.kind !== "choice" && field.kind !== "score") || Boolean(field.options?.length),
      { message: "A choice or score field lists its options.", path: ["options"] },
    )
    .refine((field) => field.kind !== "score" || (field.options?.length ?? 0) <= 10, {
      message: "A score has at most ten levels.",
      path: ["options"],
    });
}

export const outputFieldSchema = withOptions(z.object(outputFieldShape));

/** A question of a decision: yes or no, one of its options, or a level of a score. */
export const DECISION_KINDS = ["yesno", "choice", "score"] as const;
export const decisionFieldSchema = withOptions(
  z.object({ ...outputFieldShape, kind: z.enum(DECISION_KINDS) }).omit({ columns: true }),
);

/**
 * Who answers a page or a review: the run's own person (the default), the run's owner, or the people
 * the share dialog names (`wizard.answerers`). A role, never a person: people are the install's.
 */
export const whoSchema = z.enum(["person", "owner", "team"]);
export type Who = z.infer<typeof whoSchema>;

export const pageStepSchema = z.object({
  ...stepBase,
  ...personStep,
  type: z.literal("page"),
  who: whoSchema.optional(),
  fields: z.array(fieldSchema).min(1),
  /** Fields of which a decision shows one: see `group` on a field. */
  groups: z.array(fieldGroupSchema).max(6).optional(),
  cta: z.string().optional(),
  /**
   * How the page is laid out, from the surface catalog: its fields placed with `Field`, with text,
   * figures, images and callouts between them. Without it the fields stand one under the other.
   * Paths and calc read the page's answers by field id, as the person types, and the keys of `data`.
   */
  components: surfaceComponentsSchema.optional(),
  /** What the components read besides the answers: key → steps.id.key, lists.id, brand.name or today. */
  data: z.record(z.string(), z.string()).optional(),
});

/** A host name a step may list in `hosts`: labels of letters, digits and dashes, or `*.` before them. */
export const HOST_PATTERN =
  /^(\*\.)?([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/i;

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
   * A fixed step: one tool of a plugin, or one action of a connection of the wizard, called once
   * with these inputs and no model; its answer is the step's json output, as it is. For data a
   * later page shows unchanged (free appointment times), where a model would only copy it, and
   * for every write through a connection that signs in as the space: the fields are the wizard's,
   * so nothing a person typed can steer the call. String inputs are templates; a filled-in whole
   * number or true/false is passed as one, an empty one is left out.
   */
  call: z
    .union([
      z.object({
        tool: pluginToolIdSchema,
        input: z.record(z.string(), z.unknown()).default({}),
      }),
      z.object({
        /** A connection of the wizard, by id. */
        connection: id,
        /** The connector's action to run. */
        action: z.string().min(1).max(120),
        input: z.record(z.string(), z.unknown()).default({}),
      }),
    ])
    .optional(),
  /**
   * A fixed step: a function of the wizard, run once with these inputs and no model
   * (docs/plans/code-step.md). `entry` is a workspace file (.ts or .js) that defines
   * `function run(input)`; what it returns is the step's json output, fitted to `output.fields`
   * or `output.schema`. For maths, reshaping and scoring that `calc` cannot say in one line.
   */
  code: z
    .object({
      /** Workspace path of the code, like a widget's `entry`. */
      entry: z.string().min(1),
      /**
       * What `run` gets: key → a path ("budget", "steps.find.offers", "lists.prices", "today")
       * for the raw value, or a template ("{{name}} in {{city}}") for text.
       */
      input: z.record(z.string(), z.string()).default({}),
    })
    .optional(),
  tools: z.array(z.union([z.enum(TOOL_IDS), pluginToolIdSchema])).default([]),
  /** Ids of wizard connections (the person's accounts) this step may use. */
  connections: z.array(z.string()).optional(),
  /**
   * Hosts `http_request` may reach, as names: `api.example.com`, or `*.example.org` for every
   * host below example.org. A guest's run reaches no other host; a member's run every public one
   * until the space's broker switch is on. Part of the run's grant, fixed when it starts.
   */
  hosts: z.array(z.string().regex(HOST_PATTERN).max(253)).max(20).optional(),
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
  /** The model class the step needs; default `standard`. The model itself is bound elsewhere. */
  model: z.enum(STEP_CLASSES).optional(),
  /** The maker whose model runs the class; without one the organization's tier picks it. */
  maker: z.enum(MAKERS).optional(),
  effort: z.enum(EFFORTS).optional(),
  /** Shown to the person while it works. */
  /**
   * One run of the step per entry, at most twenty: the rows of a table output
   * ("steps.<id>.<key>"), the entries of a list output, or the rows of a stored list
   * ("lists.<id>"). The instructions read the entry as {{item.<column>}}, {{index}}, {{count}}.
   * The output is a table: the entry's columns and the step's output fields, one row per entry.
   */
  each: z.string().optional(),
  /**
   * The step keeps its conversation: after a crash or a deploy it goes on at the call it was at,
   * and it can stop to ask a person with no process waiting. Needs a model an API serves; not with
   * `browser` or `sandbox`, `each` or `call`.
   */
  durable: z.boolean().optional(),
  working: z.string().optional(),
});

/**
 * A decision: questions about the run, answered yes or no, by one of their options or by a level
 * of a score, in one call to the `classifier` class. A model that only decides (no text) can take
 * it and says how sure it is: `steps.<id>.<field>.p`.
 */
export const decisionStepSchema = z.object({
  ...stepBase,
  type: z.literal("decision"),
  /** What the decision weighs, as a template: {{field}}, {{steps.id}}. */
  instructions: z.string().min(1),
  output: z.object({ fields: z.array(decisionFieldSchema).min(1).max(12) }),
  /** Shown to the person while it works. */
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
  /** For document/dashboard: the model class that writes it; default `standard`. */
  model: z.enum(STEP_CLASSES).optional(),
  /** The maker whose model runs the class; without one the organization's tier picks it. */
  maker: z.enum(MAKERS).optional(),
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
   * The result is a video: the timeline is rendered to an MP4 with sound when the step runs,
   * and that video is what the person sees and downloads.
   */
  video: z.boolean().optional(),
  working: z.string().optional(),
});

/** Formats a motion-graphics step makes; the composition is drawn for this frame. */
export const MOTION_FORMATS = ["16:9", "9:16", "1:1"] as const;
export type MotionFormat = (typeof MOTION_FORMATS)[number];

export const MOTION_SIZES: Record<MotionFormat, { width: number; height: number }> = {
  "16:9": { width: 1920, height: 1080 },
  "9:16": { width: 1080, height: 1920 },
  "1:1": { width: 1080, height: 1080 },
};

/**
 * A video the AI client installed on this machine makes in a folder of its own: it writes the
 * composition as code (HTML, CSS, JS) with the skills it is given, looks at its frames and fixes
 * them; the runtime renders the MP4. It runs on the person's subscription, never on credits.
 */
export const motionGraphicsStepSchema = z.object({
  ...stepBase,
  type: z.literal("motion-graphics"),
  /** What the video is: story, look, what to use. A template. */
  brief: z.string().min(1),
  /**
   * Skill packages the client reads: platform packages ("hyperframes") or a folder of the
   * workspace with a SKILL.md ("skills/<name>").
   */
  skills: z.array(z.string().min(1)).max(12).default(["hyperframes"]),
  /**
   * A style kit in the workspace — a showreel made once with its rules, helpers and stills, as
   * a .zip — unpacked as `showcase/`: the bar every video of this wizard is made to.
   */
  kit: z.string().optional(),
  /**
   * What the video is made from: name → a field id or "steps.<id>". Files (uploads, voice lines,
   * pictures) are copied into `input/<name>/`, text is written to `input/<name>.md`.
   */
  inputs: z.record(z.string(), z.string()).default({}),
  format: z.enum(MOTION_FORMATS).default("16:9"),
  /**
   * "steps.<id>" of an earlier motion-graphics step: this video starts from that one's finished code and
   * lays it out for its own format — scenes, timing and sound stay. Made from scratch when that
   * step did not run.
   */
  from: z.string().optional(),
  /** About how long the video runs, in seconds. */
  seconds: z.number().int().min(3).max(600).optional(),
  /** The model class; default `low` — the kit carries the craft. */
  model: z.enum(STEP_CLASSES).optional(),
  /** The maker whose model runs the class; without one the organization's tier picks it. */
  maker: z.enum(MAKERS).optional(),
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
  ...personStep,
  type: z.literal("review"),
  who: whoSchema.optional(),
  /** Step ids whose output is shown. */
  show: z.array(z.string()).min(1),
  edit: z.boolean().optional(),
  regenerate: z.boolean().optional(),
  /** Approve or decline instead of "Looks good": `steps.<id>.approved`, `steps.<id>.note`. */
  approve: z.boolean().optional(),
});

export const deliverableSchema = z.object({
  from: z.string(),
  label: z.string().optional(),
  formats: z.array(z.enum(FORMATS)).min(1),
});

/** One share target the result offers, with what its form starts with. */
export const shareOptionSchema = z.object({
  /** "email", "slack", "browser", "storage:<connector>" or "connector:<connector>". */
  target: z.string().min(1),
  /** How the result names it, e.g. "Auf LinkedIn posten". Default: the target's own name. */
  label: z.string().optional(),
  /** Prefills the target's form by field id. Templates: {{field}}, {{steps.id}}, {{brand.name}}. */
  values: z.record(z.string(), z.string()).optional(),
});
export type ShareOption = z.infer<typeof shareOptionSchema>;

export const resultStepSchema = z.object({
  ...stepBase,
  type: z.literal("result"),
  message: z.string().optional(),
  deliverables: z.array(deliverableSchema),
  /**
   * Where the person can send or publish the result besides the link and the downloads. Left
   * out: the targets that need no model. An empty list: none.
   */
  share: z.array(shareOptionSchema).max(12).optional(),
});

/** What a duration lasts, in milliseconds. */
export function waitDurationMs(duration: string): number {
  const unit = duration.slice(-1) as keyof typeof WAIT_UNIT_MS;
  return Number(duration.slice(0, -1)) * WAIT_UNIT_MS[unit];
}

/** What a signal is called: "invoice.paid", "lieferung-da". */
export const signalNameSchema = z
  .string()
  .max(80)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, 'A signal\'s name, like "invoice.paid".');

/** Names only the runtime writes: a run's end, a mailbox, a person on a channel. Nobody sends these. */
const OWN_SIGNAL_PREFIXES = ["run.", "mail.", "message."];

/** A name anyone with a way in may send. */
export function signalNameOpen(name: string): boolean {
  return !OWN_SIGNAL_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** A run's end, keyed by the run's id: another run can wait for it. */
export const RUN_DONE_SIGNAL = "run.done";

/**
 * What the person of a channel writes while the run waits. Only a wait for this name takes it: a
 * chat message must not end a wait for a payment.
 */
export const MESSAGE_SIGNAL = "message.received";

/**
 * A mail in a mailbox of the space. One mail makes two of these: keyed by its sender, and by its
 * thread (`thread:<id>`).
 */
export const MAIL_SIGNAL = "mail.received";

/** What a mail's signal holds under `data`. */
export const MAIL_FIELDS = ["from", "name", "subject", "text", "thread", "message", "at"] as const;

/** The field names a signal's data missing from this list; empty when it fits. */
export function signalMissing(
  data: unknown,
  fields: readonly string[] | null | undefined,
): string[] {
  const given = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  return (fields ?? []).filter((id) => given[id] === undefined || given[id] === null);
}

/**
 * A step that waits and needs no process meanwhile: for a time, until a date, or for a signal.
 * `until` is an ISO date or a template such as "{{deadline}}"; a date gone by waits for nothing.
 * A signal is matched by its name and key; `timeout` gives up after a time. `fields`: what its
 * data must hold; only these reach the run.
 */
export const waitStepSchema = z.object({
  ...stepBase,
  type: z.literal("wait"),
  for: waitDurationSchema.optional(),
  until: z.string().min(1).optional(),
  signal: z
    .object({
      name: signalNameSchema,
      key: z.string().min(1).max(500),
      timeout: waitDurationSchema.optional(),
      fields: z
        .array(z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_-]*$/))
        .max(40)
        .optional(),
    })
    .optional(),
});
export type WaitStep = z.infer<typeof waitStepSchema>;

/** Whether `steps.<wait>.<key>` (with `.<field>` below `data`) is something this wait hands on. */
export function waitHandsOn(step: WaitStep, key: string, more: string[]): boolean {
  if (!step.signal) {
    return key === "waited" && more.length === 0;
  }
  if (key === "data") {
    return more.length === 1 && (!step.signal.fields || step.signal.fields.includes(more[0]));
  }
  return (key === "came" || key === "timedOut") && more.length === 0;
}

/** Whether `steps.<page or review>.<key>` is something this person's step hands on. */
export function personStepHandsOn(step: PageStep | ReviewStep, key: string): boolean {
  if (key === "timedOut") {
    return Boolean(step.timeout);
  }
  return step.type === "review" && Boolean(step.approve) && (key === "approved" || key === "note");
}

/** What a person's step hands on, as refs for the editor's lists. */
export function personStepRefs(step: PageStep | ReviewStep): string[] {
  return ["timedOut", "approved", "note"]
    .filter((key) => personStepHandsOn(step, key))
    .map((key) => `steps.${step.id}.${key}`);
}

/** What a wait hands on, as refs for the editor's lists. */
export function waitOutputRefs(step: WaitStep): string[] {
  if (!step.signal) {
    return [`steps.${step.id}.waited`];
  }
  return [
    `steps.${step.id}.came`,
    `steps.${step.id}.timedOut`,
    ...(step.signal.fields ?? (step.signal.name === MAIL_SIGNAL ? MAIL_FIELDS : [])).map(
      (f) => `steps.${step.id}.data.${f}`,
    ),
  ];
}

export const stepSchema = z.discriminatedUnion("type", [
  pageStepSchema,
  agentStepSchema,
  decisionStepSchema,
  generateStepSchema,
  widgetStepSchema,
  surfaceStepSchema,
  motionGraphicsStepSchema,
  reviewStepSchema,
  waitStepSchema,
  resultStepSchema,
]);
export type Step = z.infer<typeof stepSchema>;
export type PageStep = z.infer<typeof pageStepSchema>;
export type SurfaceStep = z.infer<typeof surfaceStepSchema>;
export type AgentStep = z.infer<typeof agentStepSchema>;
export type DecisionStep = z.infer<typeof decisionStepSchema>;

/** A step whose json output later steps read by field: an agent step or a decision. */
export type ModelStep = AgentStep | DecisionStep;

/** A fixed step: one `call` or the wizard's own `code`, run once with no model and no credits. */
export function runsWithoutModel(step: AgentStep): boolean {
  return Boolean(step.call || step.code);
}

/** Whether a wizard has a code step: it runs only where the `codeSteps` switch is on. */
export function hasCodeStep(def: Pick<WizardDefinition, "steps">): boolean {
  return def.steps.some((s) => s.type === "agent" && Boolean(s.code));
}

/**
 * A decision as the agent step it runs as: the `classifier` class, no tools, its questions as
 * json fields. A decision with the person's uploads to look at runs that way; one without is
 * answered in one call (engine/steps.ts).
 */
export function decisionAsAgent(step: DecisionStep): AgentStep {
  const { type: _, output, ...rest } = step;
  return {
    ...rest,
    type: "agent",
    tools: [],
    model: "classifier",
    output: { format: "json", fields: output.fields },
  };
}

/** The agent step a model step runs as. */
export function asAgent(step: ModelStep): AgentStep {
  return step.type === "decision" ? decisionAsAgent(step) : step;
}

/**
 * What an agent step's json output holds: its schema, or its fields as one. Undefined when it
 * names neither (the model then returns one table).
 */
export function declaredShape(model: ModelStep): ObjectShape | undefined {
  const step = asAgent(model);
  if (step.output.schema) {
    return step.output.schema;
  }
  return step.output.fields?.length ? shapeOfFields(step.output.fields) : undefined;
}

/** What an agent step's json output holds: its declared shape, or else one table. */
export function stepShape(step: ModelStep): ObjectShape {
  return (
    declaredShape(step) ?? {
      kind: "object",
      fields: { data: { kind: "table", description: "The result as a table" } },
    }
  );
}

/** The top-level keys of an agent step's output: what `steps.<id>.<key>` may name. */
export function outputKeys(step: ModelStep): string[] {
  return Object.keys(declaredShape(step)?.fields ?? {});
}
export type GenerateStep = z.infer<typeof generateStepSchema>;
export type WidgetStep = z.infer<typeof widgetStepSchema>;
export type MotionGraphicsStep = z.infer<typeof motionGraphicsStepSchema>;
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
  /** … or the id of one of the space's imported connectors … */
  connector: z.string().optional(),
  /** … or a connection of the space, by id: its audience and rules decide, `policy` has no say. */
  spaceConnection: z.string().max(40).optional(),
  /** Imported connectors: the actions steps may call. Default: every action that only reads. */
  actions: z.array(z.string()).max(200).optional(),
  /** Imported connectors, per action: "allow" runs it without asking, "ask" asks the person first. */
  policy: z.record(z.string(), z.enum(["allow", "ask"])).optional(),
  title: z.string().optional(),
  description: z.string().optional(),
});

/**
 * The version of the definition this app writes and reads. The format is in beta until 1.0: it
 * can change without a new version, and stored definitions are converted once when it does.
 * A definition without a version is of this one.
 */
export const DEFINITION_VERSION = 1 as const;

/** A definition as it is written: what the JSON Schema describes. */
export const wizardSchema = z
  .object({
    version: z.literal(DEFINITION_VERSION).default(DEFINITION_VERSION),
    title: z.string().min(1),
    description: z.string().default(""),
    avatar: z.enum(ENGENTY_KINDS).default("round"),
    /** A costume the avatar wears; none without one. */
    costume: z.enum(ENGENTY_COSTUMES).optional(),
    /** Shown on the first page above the first question. */
    intro: z.string().optional(),
    /**
     * What tells this wizard's runs apart in the runs panel, a template of answers such as
     * `{{kunde}} · {{angebot}}`. Filled and stored on the run as its answers arrive.
     */
    label: z.string().max(200).optional(),
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
    /** How the wizard's pages look, over its space's brand: colours, typefaces, effects, CSS. */
    /**
     * The themes the wizard offers, in its order: ids of the space's themes, or `brand`, `host`
     * and `default`. The place that shows the wizard picks one; its own pages take the first the
     * space has. Without any: the space's brand.
     */
    themes: z.array(z.string().regex(THEME_ID)).max(8).optional(),
    steps: z.array(stepSchema).min(1),
  })
  .superRefine((def, ctx) => {
    def.steps.forEach((step, i) => {
      const classed =
        step.type === "agent" || step.type === "generate" || step.type === "motion-graphics";
      const problem = classed ? makerProblem(step) : null;
      if (classed && problem) {
        ctx.addIssue({
          code: "custom",
          path: ["steps", i, step.maker ? "maker" : "model"],
          message: problem,
        });
      }
    });
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
  if (step.type === "motion-graphics") {
    return ["mp4"];
  }
  if (step.type === "widget") {
    return step.video ? ["mp4", "png"] : ["html", "png", "pdf", "mp4", "json"];
  }
  if (step.type === "surface") {
    return ["json"];
  }
  if (step.type === "agent" || step.type === "decision") {
    const agent = asAgent(step);
    if (agent.output.format === "json") {
      // Nested data reads as a document too.
      return agent.output.schema
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

/** What a template may read beside the wizard's own steps and answers: the runner fills these. */
const RUNNER_REFS = new Set(["brand", "facts", "today", "notes"]);

export interface ValidationIssue {
  stepId?: string;
  message: string;
}

/** The longest a person's step waits or reminds. */
const PERSON_WAIT_MAX_MS = 31 * 86_400_000;

function personStepIssues(step: PageStep | ReviewStep): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const [name, duration] of [
    ["timeout", step.timeout],
    ["remind", step.remind],
  ] as const) {
    if (duration && waitDurationMs(duration) > PERSON_WAIT_MAX_MS) {
      issues.push({
        stepId: step.id,
        message: `"${name}" is at most 31 days; it says ${duration}.`,
      });
    }
  }
  if (step.timeout && step.remind && waitDurationMs(step.remind) >= waitDurationMs(step.timeout)) {
    issues.push({
      stepId: step.id,
      message: `"remind" comes before "timeout": ${step.remind} is not shorter than ${step.timeout}.`,
    });
  }
  // A decline with no way of its own would go on to the next step, as an approval does.
  const approved = `steps.${step.id}.approved`;
  if (
    step.type === "review" &&
    step.approve &&
    !(step.next ?? []).some((rule) => whenNames(rule.when).includes(approved))
  ) {
    issues.push({
      stepId: step.id,
      message: `A review with "approve" needs a branch on ${approved}: a decline would go on like an approval.`,
    });
  }
  return issues;
}

const TEMPLATE_RE = /\{\{\s*([^}]+?)\s*\}\}/g;

export function templateRefs(template: string): string[] {
  return [...template.matchAll(TEMPLATE_RE)].map((m) => m[1]);
}

/**
 * Structural checks the schema cannot express: ids, references between steps,
 * templates naming things that exist by the time the step runs.
 */
/** The parts of a wizard, once each and in the order of its steps; none without sections. */
export function sectionsOf(def: Pick<WizardDefinition, "steps">): string[] {
  return [...new Set(def.steps.flatMap((s) => (s.section ? [s.section] : [])))];
}

/** The part a step belongs to: its own, or the one before it. Null before the first. */
export function sectionOf(def: Pick<WizardDefinition, "steps">, stepId: string): string | null {
  let current: string | null = null;
  for (const step of def.steps) {
    current = step.section ?? current;
    if (step.id === stepId) {
      return current;
    }
  }
  return null;
}

/**
 * What a code step may not have: it runs the wizard's function once, with no model, so nothing
 * of an AI step applies, and its output is json of a declared shape. Its inputs are checked with
 * the step's templates.
 */
function codeStepIssues(
  step: AgentStep,
  code: NonNullable<AgentStep["code"]>,
  files: string[] | undefined,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const say = (message: string) => issues.push({ stepId: step.id, message });
  if (!/\.(ts|js)$/.test(code.entry)) {
    say(`Code entry "${code.entry}" is a .ts or .js file.`);
  } else if (files && !files.includes(code.entry)) {
    say(`Code entry "${code.entry}" is not in the workspace.`);
  }
  const extra = [
    step.each && "each",
    step.durable && "durable",
    step.tools.length && "tools",
    step.connections?.length && "connections",
  ].filter(Boolean);
  if (extra.length) {
    say(`A step with "code" runs no model: no ${extra.map((k) => `"${k}"`).join(", ")}.`);
  }
  if (step.output.format !== "json") {
    say('A step with "code" returns json: output format "json".');
  } else if (!step.output.fields?.length && !step.output.schema) {
    say('A step with "code" declares what it returns: output "fields" or "schema".');
  }
  if (step.output.surface === true) {
    say('A step with "code" runs no model to compose a view: give "surface" its components.');
  }
  return issues;
}

/** A name that comes back after another ("A", "B", "A"): the bar could not show it in order. */
function sectionIssues(def: WizardDefinition): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seen = new Set<string>();
  let current: string | null = null;
  for (const step of def.steps) {
    if (step.section && step.section !== current) {
      if (seen.has(step.section)) {
        issues.push({
          stepId: step.id,
          message: `Section "${step.section}" comes back after another one; the steps of a section stand together.`,
        });
      }
      seen.add(step.section);
      current = step.section;
    }
  }
  return issues;
}

/** What `min`, `max`, `increment`, `unit` and `look` allow on a field of its kind. */
function fieldShapeIssues(field: Field): string[] {
  const issues: string[] = [];
  const say = (text: string) => issues.push(`Field "${field.id}": ${text}`);
  const { min, max, increment, unit, look } = field;
  const number = field.kind === "number";
  const files = (field.kind === "image" || field.kind === "file") && Boolean(field.multiple);
  if (min !== undefined || max !== undefined) {
    if (!number && !files) {
      say(
        '"min" and "max" bound a number field or count the files of an image or file field with "multiple".',
      );
    } else if (files) {
      for (const n of [min, max]) {
        if (n !== undefined && (!Number.isInteger(n) || n < 1 || n > MAX_FILES)) {
          say(`"min" and "max" count files: whole numbers from 1 to ${MAX_FILES}.`);
          break;
        }
      }
    }
    if (min !== undefined && max !== undefined && min > max) {
      say("min is larger than max.");
    }
  }
  if ((increment !== undefined || unit !== undefined) && !number) {
    say(`"increment" and "unit" belong to a number field; kind is "${field.kind}".`);
  }
  if (increment !== undefined && min !== undefined && max !== undefined && increment > max - min) {
    say("increment is larger than the range from min to max.");
  }
  if (look === "slider" || look === "stepper") {
    if (!number) {
      say(`look "${look}" draws a number field; kind is "${field.kind}".`);
    } else if (look === "slider" && (min === undefined || max === undefined)) {
      say('look "slider" needs "min" and "max".');
    }
  } else if (look === "list" && field.kind !== "select") {
    say(`look "list" draws a select field; kind is "${field.kind}".`);
  }
  return issues;
}

export function validateWizard(def: WizardDefinition, files?: string[]): ValidationIssue[] {
  const issues: ValidationIssue[] = sectionIssues(def);
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

  if (def.themes && new Set(def.themes).size !== def.themes.length) {
    issues.push({ message: "A theme is named twice in themes." });
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
    const ways = [connection.kind, connection.connector, connection.spaceConnection].filter(
      Boolean,
    ).length;
    if (ways !== 1) {
      issues.push({
        message: `Connection "${connection.id}" needs one of "kind", "connector" or "spaceConnection".`,
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
        for (const message of fieldShapeIssues(field)) {
          issues.push({ stepId: step.id, message });
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
    if (head !== "steps" || !key) {
      return false;
    }
    if (!(seenSteps.has(from) || (self && from === step.id))) {
      return false;
    }
    const source = def.steps.find((s) => s.id === from);
    if (source?.type === "wait") {
      return waitHandsOn(source, key, more);
    }
    if (
      (source?.type === "page" || source?.type === "review") &&
      more.length === 0 &&
      personStepHandsOn(source, key)
    ) {
      return true;
    }
    // `steps.<step>.<field>.p`: how probable the decision's answer is.
    const probability = more.length === 1 && more[0] === "p";
    if (more.length > 0 && !probability) {
      return false;
    }
    if (source?.type === "decision") {
      return outputKeys(source).includes(key);
    }
    return (
      source?.type === "agent" &&
      !probability &&
      (outputKeys(source).includes(key) || (Boolean(source.each) && key === "rows"))
    );
  };

  const conditionIssues = (stepId: string, c: Condition): ValidationIssue[] => {
    if (COMPARING.has(c.op) && typeof c.value !== "number") {
      return [{ stepId, message: `"${c.op}" on "${c.field}" compares with a number value.` }];
    }
    if ((c.op === "in" || c.op === "notIn") && !Array.isArray(c.value)) {
      return [{ stepId, message: `"${c.op}" on "${c.field}" needs a list of values.` }];
    }
    if (c.op !== "exists" && c.op !== "notExists" && c.value === undefined) {
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
      const out =
        source?.type === "agent" || source?.type === "decision"
          ? declaredShape(source)?.fields[key]
          : undefined;
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
    /** What a view's `data` reads: identifiers as keys, and things this wizard has. */
    const checkDataRefs = (data: Record<string, string>, whose: string) => {
      for (const [key, ref] of Object.entries(data)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
          issues.push({
            stepId: step.id,
            message: `${whose} data key "${key}" is not an identifier.`,
          });
        }
        const list = listRef(dataRef(ref));
        if (list) {
          if (!listIds.has(list)) {
            issues.push({
              stepId: step.id,
              message: `${whose} data reads an unknown list "${list}".`,
            });
          }
        } else {
          checkTemplate(step, `{{${dataRef(ref)}}}`);
        }
      }
    };
    switch (step.type) {
      case "page": {
        if (step.data && !step.components) {
          issues.push({ stepId: step.id, message: 'A page reads "data" only with "components".' });
        }
        if (step.components) {
          checkDataRefs(step.data ?? {}, "Page");
          const fieldNames = step.fields.map((f) => f.id);
          for (const key of Object.keys(step.data ?? {})) {
            if (fieldNames.includes(key)) {
              issues.push({
                stepId: step.id,
                message: `Page data key "${key}" is also a field of this page; they read the same name.`,
              });
            }
          }
          for (const issue of validateSurface(
            step.components,
            [...fieldNames, ...Object.keys(step.data ?? {})],
            { page: fieldNames },
          )) {
            issues.push({ stepId: step.id, message: `Page: ${issue.message}` });
          }
        }
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
          for (const name of whenNames(field.when)) {
            const own = step.fields.some((f) => f.id === name && f.id !== field.id);
            if (!own && !knownBefore(step, name)) {
              issues.push({
                stepId: step.id,
                message: `Field "${field.id}": "when" reads "${name}", which is neither on this page nor known before it.`,
              });
            }
          }
          for (const c of conditionsOf(field.when)) {
            issues.push(...conditionIssues(step.id, c));
          }
          issues.push(...whenCalcIssues(step.id, field.when, `Field "${field.id}"`));
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
      case "decision":
        checkTemplate(step, step.instructions);
        break;
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
          if (step.code) {
            issues.push({ stepId: step.id, message: 'A step has "call" or "code", not both.' });
          }
        } else if (step.code) {
          issues.push(...codeStepIssues(step, step.code, files));
          for (const [key, value] of Object.entries(step.code.input)) {
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
              issues.push({
                stepId: step.id,
                message: `Code input "${key}" is not an identifier.`,
              });
            }
            checkTemplate(step, value.includes("{{") ? value : `{{${dataRef(value)}}}`);
          }
        } else if (!step.instructions.trim()) {
          issues.push({ stepId: step.id, message: "An AI step needs instructions." });
        }
        if (step.durable) {
          // What a turn had open is gone when it goes on: a browser's page, a sandbox's files.
          for (const tool of ["browser", "sandbox"] as const) {
            if (step.tools.includes(tool)) {
              issues.push({
                stepId: step.id,
                message: `A durable step can't use "${tool}": what it has open is gone when the step goes on after an interruption.`,
              });
            }
          }
          if (step.each || step.call) {
            issues.push({
              stepId: step.id,
              message: `"durable" does nothing on a step with "${step.each ? "each" : "call"}": it has no conversation to keep.`,
            });
          }
        }
        for (const c of step.connections ?? []) {
          if (!connectionIds.has(c)) {
            issues.push({ stepId: step.id, message: `Step uses unknown connection "${c}".` });
          }
        }
        if (step.call && "connection" in step.call) {
          const called = step.call.connection;
          const named = (def.connections ?? []).find((c) => c.id === called);
          if (!named) {
            issues.push({ stepId: step.id, message: `Step calls unknown connection "${called}".` });
          } else if (named.kind) {
            issues.push({
              stepId: step.id,
              message: `A "call" names an action of a connector: connection "${called}" is of kind "${named.kind}".`,
            });
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
        checkDataRefs(step.data, "Surface");
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
      case "motion-graphics":
        checkTemplate(step, step.brief);
        for (const [name, ref] of Object.entries(step.inputs)) {
          if (!/^[a-z][a-z0-9-]{0,40}$/.test(name)) {
            issues.push({
              stepId: step.id,
              message: `Motion-graphics input "${name}" is not a folder name (lowercase letters, digits, -).`,
            });
          }
          const r = dataRef(ref);
          if (r.startsWith("steps.")) {
            checkTemplate(step, `{{${r}}}`);
          } else if (!seenFields.has(r)) {
            issues.push({
              stepId: step.id,
              message: `Motion-graphics input "${name}": "${ref}" is not an earlier field or "steps.<id>".`,
            });
          }
        }
        if (step.from) {
          const id = dataRef(step.from).replace(/^steps\./, "");
          if (
            !seenSteps.has(id) ||
            def.steps.find((s) => s.id === id)?.type !== "motion-graphics"
          ) {
            issues.push({
              stepId: step.id,
              message: `Motion-graphics "from" "${step.from}" is not an earlier motion-graphics step ("steps.<id>").`,
            });
          }
        }
        if (step.kit && !step.kit.endsWith(".zip")) {
          issues.push({ stepId: step.id, message: `Motion-graphics kit "${step.kit}" is a .zip.` });
        } else if (files && step.kit && !files.includes(step.kit)) {
          issues.push({
            stepId: step.id,
            message: `Motion-graphics kit "${step.kit}" is not in the workspace.`,
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
      case "wait":
        if ([step.for, step.until, step.signal].filter(Boolean).length !== 1) {
          issues.push({
            stepId: step.id,
            message: 'A wait has "for", "until" or "signal": one of them.',
          });
        }
        if (step.signal) {
          checkTemplate(step, step.signal.key);
        }
        if (step.until) {
          checkTemplate(step, step.until);
          if (!templateRefs(step.until).length && Number.isNaN(Date.parse(step.until))) {
            issues.push({
              stepId: step.id,
              message: `"until" is an ISO date or a template; "${step.until}" is neither.`,
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
          } else if (!list && def.steps.find((s) => s.id === ref)?.type === "wait") {
            issues.push({ stepId: step.id, message: `A wait has nothing to show: "${ref}".` });
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
          } else if (!list && def.steps.find((s) => s.id === d.from)?.type === "wait") {
            issues.push({
              stepId: step.id,
              message: `A wait has nothing to hand over: "${d.from}".`,
            });
          } else if (list && sharedLists.has(list)) {
            issues.push({ stepId: step.id, message: notShown(list) });
          }
        }
        for (const option of step.share ?? []) {
          if (!isShareTargetId(option.target)) {
            issues.push({
              stepId: step.id,
              message: `Unknown share target "${option.target}": use email, slack, browser, storage:<connector> or connector:<connector>.`,
            });
          }
          for (const value of Object.values(option.values ?? {})) {
            checkTemplate(step, value);
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
    if (step.onFail !== undefined) {
      if (step.onFail === step.id) {
        issues.push({ stepId: step.id, message: "A step can't go to itself when it fails." });
      } else if (!stepIds.has(step.onFail)) {
        issues.push({ stepId: step.id, message: `onFail goes to unknown step "${step.onFail}".` });
      }
    }
    if (step.type === "page" || step.type === "review") {
      issues.push(...personStepIssues(step));
    }
    for (const rule of step.next ?? []) {
      if (rule.goto !== "end" && !stepIds.has(rule.goto)) {
        issues.push({ stepId: step.id, message: `Branch goes to unknown step "${rule.goto}".` });
      }
      // A branch reads what the person answered (on any page), an output field of this or an
      // earlier agent step, or the row count of a stored list.
      for (const name of whenNames(rule.when)) {
        if (!fieldIds.has(name) && !knownBefore(step, name, true)) {
          issues.push({ stepId: step.id, message: `Branch reads unknown field "${name}".` });
        }
      }
      for (const c of conditionsOf(rule.when)) {
        issues.push(...conditionIssues(step.id, c));
      }
      issues.push(...whenCalcIssues(step.id, rule.when, "Branch"));
    }
    seenSteps.add(step.id);
  }
  // A run's label fills as the run goes on: it may read any step and any answer of the wizard.
  for (const ref of templateRefs(def.label ?? "")) {
    const [head, second] = ref.split(".");
    if (
      head === "steps"
        ? !(second && seenSteps.has(second))
        : !(seenFields.has(head) || RUNNER_REFS.has(head))
    ) {
      issues.push({ message: `The label reads "{{${ref}}}", which this wizard doesn't have.` });
    }
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
      // What a signal brought stays below `data`: its sender cannot set the step's own keys.
      const data = (output.json as Record<string, unknown>).data;
      if (data && typeof data === "object" && !Array.isArray(data)) {
        for (const [key, value] of Object.entries(data)) {
          out[`steps.${stepId}.data.${key}`] = value;
        }
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

/** Where a plain page goes, as the browser may work it out: `when` rules in order, then otherwise. */
export interface AheadRule {
  when?: When;
  goto: string;
}

/**
 * A page the browser may show with no server (`RunView.ahead`): the page, and where it goes. `next`
 * is null where the server decides that (an `ask`, a loop, a name the browser has no value for).
 */
export interface AheadPage {
  step: PageStep;
  next: AheadRule[] | null;
}

/**
 * The page after `stepId`, when `ahead` says which: the first rule that holds, as `followRules`
 * takes it. Null when the server must decide, or when the rule leads anywhere but a page of `ahead`
 * (the end, a step that works, a review, the result).
 */
export function nextInBrowser(
  ahead: Record<string, AheadPage>,
  stepId: string,
  values: Record<string, unknown>,
): string | null {
  const rules = ahead[stepId]?.next;
  if (!rules) {
    return null;
  }
  const rule = rules.find((r) => r.when === undefined || whenHolds(r.when, values));
  return rule && rule.goto !== stepId && ahead[rule.goto] ? rule.goto : null;
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

/** The ops that compare numbers. */
export const COMPARING: ReadonlySet<ConditionOp> = new Set(["gt", "gte", "lt", "lte"]);
/** The ops that take no value. */
export const VALUELESS: ReadonlySet<ConditionOp> = new Set(["exists", "notExists"]);

/** The tests of a `when` that must all hold; none for a calculation or no `when`. */
function testsOf(when: When | undefined): Test[] {
  if (when === undefined || whenCalc(when) !== null) {
    return [];
  }
  return Array.isArray(when) ? when : [when as Test];
}

function leavesOf(test: Test | ConditionLeaf[]): Condition[] {
  if (Array.isArray(test)) {
    return test.flatMap(leavesOf);
  }
  if ("any" in test) {
    return test.any.flatMap(leavesOf);
  }
  return "not" in test ? [test.not] : [test];
}

/** Every condition a rule or a field tests, wherever it sits in `any` or `not`. */
export function conditionsOf(when: When | undefined): Condition[] {
  return testsOf(when).flatMap(leavesOf);
}

/** A `when` the studio edits as a list of plain conditions: one, several, or none. */
export function plainConditions(when: When | undefined): Condition[] | null {
  const tests = testsOf(when);
  if (whenCalc(when) !== null) {
    return null;
  }
  return tests.every((t) => !("any" in t) && !("not" in t)) ? (tests as Condition[]) : null;
}

/**
 * A `when` worked out from what `leaf` says of each condition: true, false, or null where that
 * is not known. A calculation is the caller's; here it is null.
 */
export function whenValue(
  when: When | undefined,
  leaf: (c: Condition) => boolean | null,
): boolean | null {
  if (whenCalc(when) !== null) {
    return null;
  }
  const all = (values: (boolean | null)[]) =>
    values.includes(false) ? false : values.includes(null) ? null : true;
  const value = (test: Test | ConditionLeaf[]): boolean | null => {
    if (Array.isArray(test)) {
      return all(test.map(value));
    }
    if ("any" in test) {
      const parts = test.any.map(value);
      return parts.includes(true) ? true : parts.includes(null) ? null : false;
    }
    if ("not" in test) {
      const held = leaf(test.not);
      return held === null ? null : !held;
    }
    return leaf(test);
  };
  return all(testsOf(when).map(value));
}

/** How `whenText` joins what it says: two parts with and, with or, and a part negated. */
export interface WhenWords {
  and: (first: string, second: string) => string;
  or: (first: string, second: string) => string;
  not: (part: string) => string;
}

/** A `when` as words: `leaf` says a condition, `words` join them. A calculation is its text. */
export function whenText(
  when: When | undefined,
  leaf: (c: Condition) => string,
  words: WhenWords,
): string {
  const calc = whenCalc(when);
  if (calc !== null) {
    return calc;
  }
  const join = (parts: string[], by: WhenWords["and"], nested: boolean) => {
    const joined = parts.length ? parts.reduce((first, second) => by(first, second)) : "";
    return nested && parts.length > 1 ? `(${joined})` : joined;
  };
  const text = (test: Test | ConditionLeaf[], nested: boolean): string => {
    if (Array.isArray(test)) {
      return join(
        test.map((t) => text(t, true)),
        words.and,
        nested,
      );
    }
    if ("any" in test) {
      return join(
        test.any.map((t) => text(t, true)),
        words.or,
        nested,
      );
    }
    return "not" in test ? words.not(leaf(test.not)) : leaf(test);
  };
  const tests = testsOf(when);
  return join(
    tests.map((t) => text(t, tests.length > 1)),
    words.and,
    false,
  );
}

/** The calculation a `when` tests, if it is one. */
export function whenCalc(when: When | undefined): string | null {
  return when && !Array.isArray(when) && "calc" in when ? when.calc : null;
}

/** What a `when` reads: the fields of its conditions, or the names of its calculation. */
export function whenNames(when: When | undefined): string[] {
  const calc = whenCalc(when);
  if (calc === null) {
    return conditionsOf(when).map((c) => c.field);
  }
  const node = parsedCalc(calc);
  return "error" in node ? [] : calcNames(node);
}

/** What is wrong with the calculation a `when` tests. */
function whenCalcIssues(
  stepId: string,
  when: When | undefined,
  whose: string,
): { stepId: string; message: string }[] {
  const calc = whenCalc(when);
  const node = calc === null ? null : parsedCalc(calc);
  return node && "error" in node
    ? [{ stepId, message: `${whose}: "when" cannot be worked out: ${node.error}` }]
    : [];
}

export function conditionMatches(c: Condition, values: Record<string, unknown>): boolean {
  const v = values[c.field];
  switch (c.op) {
    case "notExists":
      return isEmptyValue(v);
    case "exists":
      return !isEmptyValue(v);
    case "eq":
      return String(v) === String(c.value);
    case "ne":
      return String(v) !== String(c.value);
    case "in":
      return Array.isArray(c.value) && c.value.map(String).includes(String(v));
    case "notIn":
      return Array.isArray(c.value) && !c.value.map(String).includes(String(v));
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const a = readNumber(v);
      const b = readNumber(c.value);
      if (a === null || b === null) {
        return false;
      }
      return c.op === "gt" ? a > b : c.op === "gte" ? a >= b : c.op === "lt" ? a < b : a <= b;
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

/** Whether a `when` holds; none holds trivially. */
export function whenHolds(when: When | undefined, values: Record<string, unknown>): boolean {
  const calc = whenCalc(when);
  if (calc !== null) {
    return calcTruthy(calcValue(calc, calcScope(values)));
  }
  return whenValue(when, (c) => conditionMatches(c, values)) === true;
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
  return [...new Set(fields.flatMap((f) => whenNames(f.when)).filter((r) => !own.has(r)))];
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
