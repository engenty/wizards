#!/usr/bin/env node
// Checks the UI's strings and the docs' prose against the mechanical rules of docs/copy-style.md:
// dashes, quotes, ellipses, spelling, the address and the glossary's "not" column. Lists what it finds;
// `--strict` also fails on it. The voice itself is for people to check.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
// Every string table a person reads from: [file, where the English starts, where the German starts, a
// prefix for its keys]. A start is the declaration the object literal follows; `.en` / `.de` after it
// takes that half of one object holding both languages.
const TABLES = [
  ["apps/web/src/lib/i18n.ts", "const en", "const de", ""],
  ["packages/shared/src/runner-texts.ts", "const en", "const de", ""],
  ["apps/runtime/src/texts.ts", "const EN", "const DE", "server:"],
  ["packages/shared/src/run.ts", "const NOTES_EN", "const NOTES_DE", "run:"],
  ["packages/shared/src/marketplace.ts", "const MARKET_EN", "const MARKET_DE", "market:"],
  ["packages/shared/src/providers.ts", "const PROVIDER_EN", "const PROVIDER_DE", "provider:"],
  ["packages/wizards/src/plugin/thread.ts", "const texts.en", "const texts.de", "thread:"],
  ["apps/runtime/src/engine/push.ts", "const TEXT.en", "const TEXT.de", "push:"],
];

/** The object literal that follows `decl` in `src` (`const x = {` or `const x: T = {`), read without running it. */
function objectAfter(src, decl, file) {
  const start = new RegExp(`${decl}(?:: [^=]+)? = \\{`).exec(src);
  if (!start) throw new Error(`${file}: no “${decl} = {”`);
  const i = start.index + start[0].length - 1;
  let depth = 0;
  let quote = null;
  let j = i;
  for (; j < src.length; j++) {
    const c = src[j];
    if (quote) {
      if (c === "\\") j++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) break;
  }
  const body = src.slice(i, j + 1).replace(/\.\.\.[A-Z_]+\.(de|en),?/g, "");
  return Function(`return ${body}`)();
}

/** A table's English and German lines by key; a line with plural forms is checked form by form. */
function dictionaries([file, en, de, prefix]) {
  const src = readFileSync(root + file, "utf8");
  const out = {};
  for (const [lang, where] of [
    ["en", en],
    ["de", de],
  ]) {
    const [decl, half] = where.split(".");
    const table = half ? objectAfter(src, decl, file)[half] : objectAfter(src, decl, file);
    out[lang] = Object.fromEntries(
      Object.entries(table).flatMap(([key, line]) =>
        typeof line === "string"
          ? [[prefix + key, line]]
          : Object.entries(line).map(([form, text]) => [`${prefix}${key}.${form}`, text]),
      ),
    );
  }
  return out;
}

// Messages the studio sends to the AI on the person's behalf, not shown as UI.
const AI_FACING = ["widget.buildMessage", "editor.fixIssuesAsk"];

// [rule, pattern, keys allowed to break it]
const RULES = {
  en: [
    ["em dash: use a spaced en dash –", /—/],
    ["hyphen as a dash: use –", / - /, ["data.markdownHint"]],
    ["three dots: use …", /\.\.\./],
    ["space before …", / …/],
    ["straight quotes: use “ ”", /"/],
    ["straight apostrophe: use ’", /\w'\w|s' /],
    [
      "American spelling",
      /\b(colors?|colored|summariz\w*|organiz\w*|analyz\w*|favorite|center|canceled)\b/i,
    ],
    ["exclamation mark", /!/],
    ["please", /\bplease\b/i, AI_FACING],
    ["glossary: project → space", /\bprojects?\b/i],
    ["glossary: synced / read-only", /\b(synced|read-only)\b/i, ["connectors.actions"]],
    [
      "glossary: local install / this machine → your computer",
      /\blocal install\b|\bthis machine\b/i,
    ],
    ["glossary: the runtime → engenty wizards", /\bruntime\b/i],
    ["glossary: E-mail → email", /\bE-mail\b/],
    ["glossary: log in → sign in", /\blog ?in\b/i, ["auth.dev"]],
    ["~ for estimates: use ≈ or about", /~ ?\{/],
  ],
  de: [
    ["Geviertstrich: – verwenden", /—/],
    ["Bindestrich als Gedankenstrich: – verwenden", / - /, ["data.markdownHint"]],
    ["drei Punkte: … verwenden", /\.\.\./],
    ["… ohne Leerzeichen davor", /\S…/],
    ["gerade Anführungszeichen: „…“ verwenden", /"/],
    ["gerader Apostroph: ’ verwenden", /\w'\w/],
    ["Sie-Form", /\b(Ihnen|Ihre[mnrs]?)\b|[a-zäöü,] Sie\b/],
    ["ihr/euch für die Lesenden: du verwenden", /\b(euch|eure[mnrs]?)\b/i],
    ["Ausrufezeichen", /!/],
    [
      "österreichisch: Standarddeutsch verwenden (Januar, USt-IdNr., Kassierer)",
      /\b(Jänner|Feber|heuer|Kassier|Obfrau|Bankomat|Sackerl)\b|\bUID\b(?! ?\/)/,
    ],
    [
      "generisches Maskulinum: neutral umformulieren oder Doppelpunkt (Kund:innen)",
      /\b(Besucher|Kunden?|Bewerber|Nutzer|Teilnehmer|Mitarbeiter|Endnutzer|Anwender|Händler|Interessent|Patient|Empfänger|Absender|Leser|Betreiber|Inhaber|Kollege|Handwerker|Antragsteller|Käufer|Verkäufer|Lieferant|Mieter|Vermieter|Eigentümer|Auftraggeber|Wettbewerber)(?!:in)(n|en|s)?\b/,
    ],
    ["Glossar: Projekt → Space", /\bProjekt/],
    ["Glossar: schreibgeschützt / synchronisiert", /schreibgeschützt|synchronisiert/i],
    ["Glossar: lokale Installation / Rechner → Computer", /lokalen? Installation|\bRechner/i],
    ["Glossar: API Key → API-Key", /\bAPI Key/],
    ["Glossar: Durchlauf → Lauf", /Durchl[aä]uf/],
    [
      "Glossar: Konnektor → Connector",
      /Konnektor/,
      [
        "integrate.openConnectors",
        "integrate.claudeAiWhere",
        "integrate.desktopWhere",
        "mcp.claudeAi",
      ],
    ],
    ["~ für Schätzungen: ≈ oder etwa", /~ ?\{/],
  ],
};

const strict = process.argv.includes("--strict");
let total = 0;
for (const lang of ["en", "de"]) {
  const strings = {};
  for (const table of TABLES) Object.assign(strings, dictionaries(table)[lang]);
  for (const [rule, pattern, allowed = []] of RULES[lang]) {
    const hits = Object.entries(strings).filter(
      ([key, text]) => !allowed.includes(key) && pattern.test(text.replace(/\{\w+\}/g, "{}")),
    );
    if (!hits.length) continue;
    total += hits.length;
    console.log(`\n${lang.toUpperCase()} · ${rule} (${hits.length})`);
    for (const [key, text] of hits.slice(0, 8)) console.log(`  ${key}: ${text.slice(0, 110)}`);
    if (hits.length > 8) console.log(`  … ${hits.length - 8} more`);
  }
}
// The docs: their prose, without frontmatter, code, HTML and link targets.
const DOC_RULES = [
  ["em dash: use a spaced en dash –", /—/],
  ["straight quotes: use “ ”", /"/],
  ["straight apostrophe: use ’", /\w'\w/],
  [
    "American spelling",
    /\b(colors?|colored|summariz\w*|organiz\w*|analyz\w*|favorite|canceled)\b/i,
  ],
  ["please", /\bplease\b/i],
];
const USER_DOC_RULES = [
  ["glossary: local install / this machine → your computer", /\blocal install\b|\bthis machine\b/i],
  ["glossary: E-mail → email", /\be-mail\b/i],
];

/** A page's lines as a reader sees them, each with its line number; code and markup left out. */
function prose(src) {
  const lines = src.split("\n");
  let start = 0;
  if (lines[0] === "---") start = lines.indexOf("---", 1) + 1;
  const out = [];
  let fence = null;
  for (let i = start; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    const mark = /^(`{3,}|~{3,})/.exec(trimmed)?.[1];
    if (fence) {
      if (mark && trimmed.startsWith(fence)) fence = null;
      continue;
    }
    if (mark) {
      fence = mark;
      continue;
    }
    const text = lines[i]
      .replace(/(`+).*?\1/g, "")
      .replace(/`[^`]*$/, "")
      .replace(/^[^`]*`/, "")
      .replace(/<[^>\n]+>/g, "")
      .replace(/\]\([^)\n]*\)/g, "]");
    out.push([i + 1, text]);
  }
  return out;
}

const pages = (dir) =>
  readdirSync(root + dir, { recursive: true })
    .filter((f) => f.endsWith(".md"))
    .map((f) => `${dir}/${f}`);
const docs = [...pages("docs/content"), "README.md"];
for (const [rule, pattern, userOnly] of [
  ...DOC_RULES,
  ...USER_DOC_RULES.map(([rule, pattern]) => [rule, pattern, true]),
]) {
  const hits = [];
  for (const file of docs) {
    if (userOnly && file.startsWith("docs/content/dev")) continue;
    for (const [n, text] of prose(readFileSync(root + file, "utf8"))) {
      if (pattern.test(text)) hits.push(`${file}:${n}: ${text.trim().slice(0, 100)}`);
    }
  }
  if (!hits.length) continue;
  total += hits.length;
  console.log(`\nDocs · ${rule} (${hits.length})`);
  for (const hit of hits.slice(0, 8)) console.log(`  ${hit}`);
  if (hits.length > 8) console.log(`  … ${hits.length - 8} more`);
}

// Words a person reads, written straight into the code instead of a table: a string or JSX text with
// German letters, or with two German words, in a file that holds no table.
const SOURCE_DIRS = [
  "apps/web/src",
  "apps/runtime/src",
  "packages/runner/src",
  "packages/shared/src",
  "packages/wizards/src",
];
// German that is no UI copy: [file or folder, a piece of the line (none: all of it), why].
const NOT_COPY = [
  ["apps/web/src/dev", null, "the dev-only mascot builder, not shipped to people"],
  [
    "apps/runtime/src/agents/architect.ts",
    "Neuer Schritt",
    "AI prompt: the German words the studio sends",
  ],
  ["apps/runtime/src/agents/studio-assistant.ts", "Primär", "AI prompt: an example colour name"],
  ["apps/runtime/src/authoring/guide.ts", null, "AI prompt: German examples of what people write"],
  ["apps/runtime/src/media/transcribe.ts", "ähm", "AI prompt: filler words to keep"],
  ["apps/runtime/src/services/knowledge.ts", "Graz Süd", "AI tool hint: an example value"],
  ["apps/runtime/src/tools/project.ts", "Graz Süd", "AI tool description: an example value"],
  ["apps/runtime/src/services/project-index.ts", "der die das", "stop words for search"],
  ["apps/runtime/src/browser/fast/span-picker.ts", "Jän|Mär", "month names a page may show"],
  [
    "apps/runtime/src/connectors/index.ts",
    "App-Passwort",
    "FIELD_WORDS.de, the German half of a table",
  ],
];
const GERMAN_WORD =
  /\b(und|oder|nicht|noch|kein|keine|dein|deine|deinen|dich|dir|bitte|wird|werden|ist|sind|hier|jetzt|mit|für|auf|eine?|der|die|das|zum|zur|Schritt|Lauf|Datei|Dateien)\b/g;
const LITERAL = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`|>[^<>{}\n]*</g;
// Words of the UI that are German on their own, one is enough.
const GERMAN_UI =
  /\b(Ablauf|aktualisiert|gespeichert|gelöscht|Abbrechen|Speichern|Weiter|Fertig|Ja|Nein|Fehler|Einstellungen|Anmelden|Abmelden|Hochladen|Bearbeiten|Suchen|Senden|Laden|Schritte?|Läufe|Ergebnis|Vorlage|Entwurf|Konto|Passwort|Teilen|Kopieren|Erneut)\b/;
const looksGerman = (text) =>
  /[äöüÄÖÜß]/.test(text) || GERMAN_UI.test(text) || (text.match(GERMAN_WORD) ?? []).length >= 2;
const tables = new Set(TABLES.map(([file]) => file));
const hardCoded = [];
for (const dir of SOURCE_DIRS) {
  for (const name of readdirSync(root + dir, { recursive: true })) {
    const file = `${dir}/${name}`;
    if (!/\.tsx?$/.test(file) || /\.(test|d)\.tsx?$/.test(file) || tables.has(file)) continue;
    const allowed = NOT_COPY.filter(([path]) => file === path || file.startsWith(`${path}/`));
    if (allowed.some(([, piece]) => !piece)) continue;
    readFileSync(root + file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        const code = line.trimStart();
        // Comments, a line the allowlist names, and `de: "…"` beside its English in one object.
        if (/^(\/\/|\*|\/\*)/.test(code) || allowed.some(([, piece]) => code.includes(piece)))
          return;
        if (/\bde: ["'`].*\ben: ["'`]/.test(code)) return;
        for (const literal of code.match(LITERAL) ?? []) {
          if (looksGerman(literal)) hardCoded.push(`${file}:${i + 1}: ${literal.slice(0, 90)}`);
        }
      });
  }
}
if (hardCoded.length) {
  total += hardCoded.length;
  console.log(`\nCode · German outside a string table (${hardCoded.length})`);
  for (const hit of hardCoded.slice(0, 8)) console.log(`  ${hit}`);
  if (hardCoded.length > 8) console.log(`  … ${hardCoded.length - 8} more`);
}

console.log(total ? `\n${total} places break a rule of docs/copy-style.md.` : "Copy checks out.");
process.exitCode = strict && total ? 1 : 0;
