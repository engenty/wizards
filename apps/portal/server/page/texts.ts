// Every word a visitor reads on a team's page, in the page's language (docs/copy-style.md in the
// open repository: calm, one idea per sentence). The reader is "du" as everywhere, unless the
// team chose "Sie" for its page: its visitors are its customers, and the team knows how it
// speaks to them.

const de = {
  start: "Los geht's",
  youGet: "Du bekommst",
  youDo: "Du machst",
  howItGoes: "So läuft es",
  noAccount: "Kein Konto nötig",
  wizards: (n: number) => (n === 1 ? "1 Wizard" : `${n} Wizards`),
  minutes: (m: number) => `etwa ${m} Min`,
  minutesLong: (m: number) => `etwa ${m} Minuten`,
  minutesRange: (a: number, b: number) => (a === b ? `etwa ${a} Minuten` : `${a} bis ${b} Minuten`),
  task: (fields: number, reviews: number, uploads: boolean) => {
    const parts = [
      uploads ? "Dateien hochladen" : "",
      fields ? `${fields} ${fields === 1 ? "Frage" : "Fragen"} beantworten` : "",
      reviews ? `${reviews === 1 ? "einen Entwurf" : `${reviews} Entwürfe`} prüfen` : "",
    ].filter(Boolean);
    return parts.length ? join(parts, "und") : "Nur starten";
  },
  short: (fields: number, uploads: boolean) =>
    [uploads ? "Dateien" : "", fields ? `${fields} ${fields === 1 ? "Frage" : "Fragen"}` : ""]
      .filter(Boolean)
      .join(", "),
  all: "Alle Wizards",
  /** What a result is (`resultKind`), as the marketplace names it; a dashboard is a widget here. */
  kind: {
    text: "Text",
    document: "Dokument",
    table: "Tabelle",
    image: "Bild",
    video: "Video",
    audio: "Audio",
    dashboard: "Widget",
  } as Record<string, string>,
  example: "Beispiel ansehen",
  exampleNote: "Ein Lauf, den das Team geteilt hat.",
  pause: "Pausieren geht jederzeit, auf diesem Gerät geht es weiter.",
  download: "Zum Herunterladen, oder du schickst sie direkt aus dem Wizard.",
  imprint: "Impressum",
  page: "Seite",
  poweredBy: "Wizards von engenty",
  nothing: "Hier ist noch nichts.",
  nothingNote:
    "Diese Adresse hat noch keine öffentliche Seite. Teams bauen ihre Wizards mit engenty wizards und zeigen sie hier.",
  whatIs: "Was ist engenty wizards?",
  paused: "Diese Seite ist pausiert.",
  pausedNote: "Das Team kümmert sich darum. Bitte später wieder vorbeischauen.",
  down: "Diese Seite ist gerade nicht erreichbar.",
  downNote: "Bitte in einer Minute noch einmal versuchen.",
  notBuilt: "Demo: Dieser Wizard ist noch nicht gebaut.",
  notBuiltNote: "Auf der echten Seite führt der Knopf zum Wizard.",
  back: "Zurück zur Seite",
};

const en: typeof de = {
  start: "Start",
  youGet: "You get",
  youDo: "You do",
  howItGoes: "How it goes",
  noAccount: "No account needed",
  wizards: (n) => (n === 1 ? "1 wizard" : `${n} wizards`),
  minutes: (m) => `about ${m} min`,
  minutesLong: (m) => `about ${m} minutes`,
  minutesRange: (a, b) => (a === b ? `about ${a} minutes` : `${a} to ${b} minutes`),
  task: (fields, reviews, uploads) => {
    const parts = [
      uploads ? "upload your files" : "",
      fields ? `answer ${fields} ${fields === 1 ? "question" : "questions"}` : "",
      reviews ? `check ${reviews === 1 ? "one draft" : `${reviews} drafts`}` : "",
    ].filter(Boolean);
    const text = parts.length ? join(parts, "and") : "just start";
    return text.charAt(0).toUpperCase() + text.slice(1);
  },
  short: (fields, uploads) =>
    [uploads ? "Files" : "", fields ? `${fields} ${fields === 1 ? "question" : "questions"}` : ""]
      .filter(Boolean)
      .join(", "),
  all: "All wizards",
  kind: {
    text: "Text",
    document: "Document",
    table: "Table",
    image: "Image",
    video: "Video",
    audio: "Audio",
    dashboard: "Widget",
  },
  example: "See an example",
  exampleNote: "A run the team shared.",
  pause: "You can stop at any time and continue on this device.",
  download: "To download, or you send them straight from the wizard.",
  imprint: "Imprint",
  page: "Page",
  poweredBy: "Wizards by engenty",
  nothing: "There is nothing here yet.",
  nothingNote:
    "This address has no public page yet. Teams build their wizards with engenty wizards and show them here.",
  whatIs: "What is engenty wizards?",
  paused: "This page is paused.",
  pausedNote: "The team is looking into it. Come back later.",
  down: "This page can't be reached right now.",
  downNote: "Try again in a minute.",
  notBuilt: "Demo: this wizard isn't built yet.",
  notBuiltNote: "On a real page the button leads to the wizard.",
  back: "Back to the page",
};

/** The German page in the formal form: only the words that address the reader change. */
const deSie: Partial<Texts> = {
  youGet: "Sie bekommen",
  youDo: "Sie machen",
  download: "Zum Herunterladen, oder Sie schicken sie direkt aus dem Wizard.",
  pause: "Pausieren geht jederzeit, auf diesem Gerät geht es weiter.",
};

/** "a, b und c" */
function join(parts: string[], and: string): string {
  if (parts.length < 2) {
    return parts[0] ?? "";
  }
  return `${parts.slice(0, -1).join(", ")} ${and} ${parts[parts.length - 1]}`;
}

export type Texts = typeof de;
export const textsOf = (lang: string, form?: "du" | "sie"): Texts =>
  lang === "en" ? en : form === "sie" ? { ...de, ...deSie } : de;
