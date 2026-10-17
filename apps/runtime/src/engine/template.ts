import {
  allFields,
  type Field,
  isAudioValue,
  isLocationValue,
  itemsTotals,
  localeOf,
  locationText,
  type WizardDefinition,
  wizardLang,
} from "@engenty-wizards/shared/definition";
import { formatMoney } from "@engenty-wizards/shared/numbers";
import {
  type AssetSection,
  type BrandColor,
  type BrandFont,
  type BrandGradient,
  type BrandPattern,
  type BrandRule,
  type ColorSection,
  fontLicenseWords,
  gradientCss,
  type LogoSection,
  type ProjectFact,
  type TextStyle,
  textStyleLine,
} from "@engenty-wizards/shared/projects";
import type { RunState } from "@engenty-wizards/shared/run";
import { type ListDef, type ListRow, listAsMarkdown } from "@engenty-wizards/shared/store";

export interface TemplateScope {
  def: WizardDefinition;
  state: RunState;
  /** The project the wizard belongs to: who it is, its colours, how its logos are used, its facts. */
  brand: {
    name?: string;
    about?: string;
    colors?: BrandColor[];
    colorSections?: ColorSection[];
    gradients?: BrandGradient[];
    patterns?: BrandPattern[];
    colorRules?: BrandRule[];
    logoSections?: LogoSection[];
    assetSections?: AssetSection[];
    fonts?: BrandFont[];
    textStyles?: TextStyle[];
    typeRules?: BrandRule[];
    logoRules?: BrandRule[];
    facts?: ProjectFact[];
  };
  /** The wizard's stored lists as they are when the step starts. */
  lists?: Record<string, { def: ListDef; rows: ListRow[] }>;
  /** A generate step with `each`: the entry this result is made for. */
  entry?: { item: unknown; index: number; count: number };
}

const TEMPLATE_RE = /\{\{\s*([^}]+?)\s*\}\}/g;

/** Line items as a Markdown table with their totals — what a model needs to write a document. */
export function itemsAsMarkdown(
  field: Field,
  value: unknown,
  values: Record<string, unknown>,
  lang = "en",
): string {
  const locale = localeOf(lang);
  const totals = itemsTotals(field, value, values);
  const cols = field.columns ?? [];
  if (!totals.rows.length) {
    return "(no line items)";
  }
  const head = `| ${cols.map((c) => c.label).join(" | ")} | Amount |\n|${cols.map(() => " --- ").join("|")}| ---: |`;
  const body = totals.rows.map(
    (r) =>
      `| ${cols
        .map((c) =>
          c.kind === "money"
            ? formatMoney(Number(r[c.id]) || 0, totals.currency, locale)
            : String(r[c.id] ?? ""),
        )
        .join(" | ")} | ${formatMoney(r.amount as number, totals.currency, locale)} |`,
  );
  const sums = [
    `Net: ${formatMoney(totals.net, totals.currency, locale)}`,
    totals.vatRate
      ? `VAT ${totals.vatRate}%: ${formatMoney(totals.vat, totals.currency, locale)}`
      : null,
    `Total: ${formatMoney(totals.gross, totals.currency, locale)}`,
  ].filter(Boolean);
  return [head, ...body, "", ...sums].join("\n");
}

/** Facts as lines a model reads: "Label: value". */
export function factLines(facts: ProjectFact[]): string {
  return facts.map((f) => `${f.label}: ${f.value}`).join("\n");
}

/**
 * The colours as a model reads them; a section's after the standard ones. A gradients section
 * names its gradients as CSS, each with what it is for.
 */
export function colorLine(
  colors: BrandColor[],
  sections: ColorSection[] = [],
  gradients: BrandGradient[] = [],
): string {
  const line = (list: BrandColor[]) =>
    list.map((c) => (c.name ? `${c.name} ${c.value}` : c.value)).join(", ");
  const known = (c: BrandColor) => sections.some((s) => s.id === c.section);
  return [
    line(colors.filter((c) => !known(c))),
    ...sections.map((s) => {
      if (s.kind === "gradients") {
        const own = gradients.filter((g) => g.section === s.id);
        const one = (g: BrandGradient) =>
          `${g.name || "gradient"}${g.description ? ` (${g.description})` : ""} ${gradientCss(g)}`;
        return own.length ? `${s.title}: ${own.map(one).join("; ")}` : "";
      }
      const own = colors.filter((c) => c.section === s.id);
      return own.length ? `${s.title}: ${line(own)}` : "";
    }),
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * The brand's type as a model reads it: its fonts with their licences, then its text styles. A
 * licence that names its uses is binding.
 */
export function typeLines(fonts: BrandFont[] = [], styles: TextStyle[] = []): string {
  const families = fonts.map((f) => {
    const weights = f.weights.length ? `, weights ${f.weights.join("/")}` : "";
    return `- ${f.family}${f.role ? ` (${f.role})` : ""}${weights}${fontLicenseWords(f)}`;
  });
  const scale = styles.map((s) => `- ${s.name}: ${textStyleLine(s, fonts)}`);
  return [
    families.length ? `Fonts:\n${families.join("\n")}` : "",
    fonts.some((f) => f.uses?.length)
      ? "A font's licence is binding: use a font only for what it may be used for, and set anything else in a system font."
      : "",
    scale.length ? `Text styles:\n${scale.join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

const sectionWords = (s: { title: string; description: string } | undefined) =>
  !s ? "" : s.description ? `${s.title} (${s.description})` : s.title;

/** The logo's section in words — "Logomark (small spaces, app icons)" — or "" where it has none. */
export function logoSectionLine(sections: LogoSection[] | undefined, fileId: string): string {
  return sectionWords(sections?.find((x) => x.logos.includes(fileId)));
}

/** The title of the asset's section — "Icons" — or "" where it has none. */
export function assetSectionLine(sections: AssetSection[] | undefined, fileId: string): string {
  return sections?.find((x) => x.assets.includes(fileId))?.title ?? "";
}

function brandRef(brand: TemplateScope["brand"], key: string): unknown {
  switch (key) {
    case "name":
      return brand.name ?? "";
    case "about":
      return brand.about ?? "";
    // What the free "details" text once held is now the description and the facts.
    case "details":
      return [brand.about, factLines(brand.facts ?? [])].filter(Boolean).join("\n");
    case "accent":
      return brand.colors?.[0]?.value ?? "";
    case "colors":
      return colorLine(brand.colors ?? [], brand.colorSections, brand.gradients);
    case "fonts":
      return typeLines(brand.fonts, brand.textStyles);
    default:
      return "";
  }
}

function stringify(v: unknown): string {
  if (v === undefined || v === null) {
    return "";
  }
  if (typeof v === "string") {
    return v;
  }
  if (typeof v === "number" || typeof v === "boolean") {
    return String(v);
  }
  if (Array.isArray(v) && v.every((x) => typeof x !== "object")) {
    return v.join(", ");
  }
  return JSON.stringify(v, null, 2);
}

export function resolveRef(ref: string, scope: TemplateScope): unknown {
  const { def, state, brand } = scope;
  const [head, ...rest] = ref.split(".");
  if (head === "lists") {
    const list = scope.lists?.[rest[0] ?? ""];
    return list ? listAsMarkdown(list.def, list.rows) : "";
  }
  if (head === "today") {
    return new Date().toISOString().slice(0, 10);
  }
  if (head === "item" || head === "index" || head === "count") {
    const entry = scope.entry;
    if (!entry) {
      return "";
    }
    if (head === "index") {
      return entry.index + 1;
    }
    if (head === "count") {
      return entry.count;
    }
    let cur: unknown = entry.item;
    for (const key of rest) {
      cur = cur && typeof cur === "object" ? (cur as Record<string, unknown>)[key] : undefined;
    }
    return cur;
  }
  if (head === "brand") {
    return brandRef(brand, rest[0] ?? "name");
  }
  if (head === "facts") {
    const facts = brand.facts ?? [];
    return rest[0] ? (facts.find((f) => f.key === rest[0])?.value ?? "") : factLines(facts);
  }
  if (head === "steps") {
    const out = state.outputs[rest[0] ?? ""];
    if (!out) {
      return "";
    }
    if (rest.length === 1) {
      return out.json !== undefined ? out.json : (out.text ?? "");
    }
    let cur: unknown = out.json;
    for (const key of rest.slice(1)) {
      cur = cur && typeof cur === "object" ? (cur as Record<string, unknown>)[key] : undefined;
    }
    return cur;
  }
  const field = allFields(def).find((f) => f.id === head);
  const value = state.values[head];
  if (field?.kind === "items") {
    if (!rest.length) {
      return itemsAsMarkdown(field, value, state.values, wizardLang(def));
    }
    const totals = itemsTotals(field, value, state.values) as unknown as Record<string, unknown>;
    return totals[rest[0]];
  }
  if (field?.kind === "file" && rest[0] === "speech") {
    const pieces = state.heard?.[head];
    // The lines an agent reads and cuts by: "[12.40–15.10] what is said".
    return pieces
      ? pieces.map((p) => `[${p.start.toFixed(2)}–${p.end.toFixed(2)}] ${p.text}`).join("\n") ||
          "(no intelligible speech)"
      : "";
  }
  if (field?.kind === "image" || field?.kind === "file") {
    // The files themselves are read with read_document / scan_documents by these names.
    const ids = (Array.isArray(value) ? value : [value]).filter(
      (v): v is string => typeof v === "string" && v.length > 0,
    );
    return ids.map((id) => `upload:${id}`).join(", ");
  }
  if (field?.kind === "location") {
    if (!isLocationValue(value)) {
      return "";
    }
    switch (rest[0]) {
      case undefined:
        return locationText(value);
      case "map":
        return value.lat === undefined
          ? ""
          : `https://www.openstreetmap.org/?mlat=${value.lat}&mlon=${value.lng}#map=17/${value.lat}/${value.lng}`;
      default:
        return (value as Record<string, unknown>)[rest[0]];
    }
  }
  if (field?.kind === "audio") {
    if (!isAudioValue(value)) {
      return "";
    }
    if (rest[0] === "seconds") {
      return value.seconds;
    }
    // A recording reads as what is said in it.
    return value.transcript?.trim() || "(voice note without intelligible speech)";
  }
  if (field?.kind === "signature") {
    // Documents place it as an image: <img src="asset://ID">.
    return typeof value === "string" && value ? `asset://${value}` : "";
  }
  if (field?.kind === "list") {
    const list = scope.lists?.[field.list ?? ""];
    return list ? listAsMarkdown(list.def, list.rows) : "";
  }
  if (field?.kind === "toggle") {
    return value ? "yes" : "no";
  }
  return value;
}

export function renderTemplate(template: string, scope: TemplateScope): string {
  return template.replace(TEMPLATE_RE, (_m, ref: string) =>
    stringify(resolveRef(ref.trim(), scope)),
  );
}

/** Everything the person entered so far, readable — handed to agents as data. */
export function answersAsText(scope: TemplateScope): string {
  const lines: string[] = [];
  for (const field of allFields(scope.def)) {
    const value = scope.state.values[field.id];
    if (value === undefined || value === "" || (Array.isArray(value) && !value.length)) {
      continue;
    }
    lines.push(`### ${field.label}\n${stringify(resolveRef(field.id, scope))}`);
  }
  return lines.join("\n\n");
}
