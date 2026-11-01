/**
 * The portal's words, in English and German (docs/copy-style.md: du, gender-neutral German;
 * `pnpm copy:check` reads both halves). A client space is "client space" in English and "Space"
 * in German. The firm's AI is "<firm> AI" / „<Firma> KI“: it never speaks as a person.
 */

const en = {
  "nav.chat": "Chat",
  "nav.newChat": "New chat",
  "nav.wizards": "Wizards",
  "nav.results": "Results",
  "nav.label": "Your client space",
  "nav.menu": "Menu",
  "nav.close": "Close menu",
  signIn: "Sign in",
  signOut: "Sign out",
  "signIn.clients": "For clients of {firm}",
  "signIn.title": "Work with {firm}, any time",
  "signIn.lead":
    "Ask {firm}’s AI about your plans, start {firm}’s wizards and find everything that comes out of them.",
  "signIn.failed": "The sign-in didn’t work. Try again.",
  "signIn.ask": "Questions, at any hour",
  "signIn.ask.hint": "The AI knows what {firm} has opened to you.",
  "signIn.wizards": "Start ready-made wizards",
  "signIn.wizards.hint": "A wizard asks you step by step and does the rest.",
  "signIn.results": "Everything in one place",
  "signIn.results.hint": "Every result to look at and download.",
  "public.wizards": "Get started",
  "public.start": "Start",
  "public.nothing": "Nothing here yet.",
  madeWith: "with engenty wizards",
  otherOrganization: "You’re signed in for another organization.",
  "otherOrganization.hint": "Sign out, then sign in again for {firm}.",
  noSpaces: "You don’t have a client space here yet.",
  "noSpaces.hint": "{firm} invites you by your e-mail address. Once they have, it shows up here.",
  "spaces.switch": "Switch client space",
  "hello.morning": "Good morning, {name}.",
  "hello.day": "Hello, {name}.",
  "hello.evening": "Good evening, {name}.",
  "home.first":
    "{firm}’s AI helps you with {space} here. It knows what {firm} has opened to you and everything made here.",
  "home.examples": "For example",
  "home.example.know": "What do you know about us?",
  "home.example.sum": "Sum up the latest documents on one page",
  "home.example.wizard": "Wizard",
  "home.allWizards": "All wizards",
  "home.new": "New for you",
  "home.allResults": "All results",
  "waiting.title": "Waiting for you",
  "waiting.since": "Waiting for you since {date}",
  "waiting.continue": "Continue",
  "composer.home": "Ask {firm} AI about your files, your plans, anything here",
  "composer.reply": "Ask {firm} AI",
  "composer.label": "Your message",
  "composer.send": "Send",
  "composer.wizard": "Wizard",
  "composer.wizards": "Start a wizard",
  "composer.wizards.none": "{firm} hasn’t opened a wizard to you yet.",
  reach: "You and {firm} see this chat.",
  "chats.today": "Today",
  "chats.week": "This week",
  "chats.none": "Your chats show up here.",
  "chats.untitled": "New chat",
  "chat.you": "You",
  "chat.ai": "{firm} AI",
  "chat.writing": "{firm} AI is writing…",
  "chat.empty": "This chat has no messages yet.",
  "card.wizard": "Wizard by {firm}",
  "card.open": "Open",
  "status.done": "done",
  "status.running": "running",
  "status.waiting_input": "waiting for you",
  "status.failed": "failed",
  "status.cancelled": "stopped",
  "wizards.title": "Wizards",
  "wizards.lead":
    "{firm}’s ready-made wizards. A wizard asks you step by step and puts the result in your results.",
  "wizards.steps.one": "1 step",
  "wizards.steps": "{n} steps",
  "wizards.empty": "{firm} hasn’t opened a wizard to you yet.",
  "wizard.start": "Start",
  "wizard.starting": "Starting…",
  "results.title": "Results",
  "results.files": "Files",
  "results.all": "All",
  "results.byFirm": "By {firm}",
  "results.mine": "By you",
  "results.empty": "No results yet. They show up here once a wizard is done or {firm} shares one.",
  "results.none": "Nothing here with this filter.",
  "files.empty": "No files yet. {firm}’s documents for you show up here.",
  "files.download": "Download",
  "files.all": "All files",
  "run.back": "Back",
  loading: "Loading…",
  error: "Something went wrong: {error}",
  notFound: "This page doesn’t exist.",
  language: "Deutsch",
};

const de: typeof en = {
  "nav.chat": "Chat",
  "nav.newChat": "Neuer Chat",
  "nav.wizards": "Wizards",
  "nav.results": "Ergebnisse",
  "nav.label": "Dein Space",
  "nav.menu": "Menü",
  "nav.close": "Menü schließen",
  signIn: "Anmelden",
  signOut: "Abmelden",
  "signIn.clients": "Für Kund:innen von {firm}",
  "signIn.title": "Mit {firm} arbeiten, jederzeit",
  "signIn.lead":
    "Frag die KI von {firm} zu deinen Vorhaben, starte die Wizards von {firm} und finde alles, was dabei entsteht.",
  "signIn.failed": "Die Anmeldung hat nicht geklappt. Versuch es noch einmal.",
  "signIn.ask": "Fragen, auch spät am Abend",
  "signIn.ask.hint": "Die KI kennt, was {firm} für dich freigegeben hat.",
  "signIn.wizards": "Fertige Wizards starten",
  "signIn.wizards.hint": "Ein Wizard fragt dich Schritt für Schritt und erledigt den Rest.",
  "signIn.results": "Alles an einem Ort",
  "signIn.results.hint": "Jedes Ergebnis zum Ansehen und Herunterladen.",
  "public.wizards": "Loslegen",
  "public.start": "Starten",
  "public.nothing": "Hier ist noch nichts.",
  madeWith: "mit engenty wizards",
  otherOrganization: "Du bist für eine andere Organisation angemeldet.",
  "otherOrganization.hint": "Melde dich ab und dann für {firm} wieder an.",
  noSpaces: "Du hast hier noch keinen Space.",
  "noSpaces.hint": "{firm} lädt dich über deine E-Mail-Adresse ein. Danach erscheint er hier.",
  "spaces.switch": "Space wechseln",
  "hello.morning": "Guten Morgen, {name}.",
  "hello.day": "Hallo {name}.",
  "hello.evening": "Guten Abend, {name}.",
  "home.first":
    "Hier hilft dir die KI von {firm} bei {space}. Sie kennt, was {firm} für dich freigegeben hat, und alles, was hier entsteht.",
  "home.examples": "Zum Beispiel",
  "home.example.know": "Was weißt du über uns?",
  "home.example.sum": "Fass mir die neuesten Unterlagen auf einer Seite zusammen",
  "home.example.wizard": "Wizard",
  "home.allWizards": "Alle Wizards",
  "home.new": "Neu für dich",
  "home.allResults": "Alle Ergebnisse",
  "waiting.title": "Wartet auf dich",
  "waiting.since": "Wartet auf dich seit {date}",
  "waiting.continue": "Weitermachen",
  "composer.home": "Frag {firm} KI zu deinen Dateien, deinen Plänen, allem hier",
  "composer.reply": "Frag {firm} KI",
  "composer.label": "Deine Nachricht",
  "composer.send": "Senden",
  "composer.wizard": "Wizard",
  "composer.wizards": "Wizard starten",
  "composer.wizards.none": "{firm} hat noch keinen Wizard für dich freigegeben.",
  reach: "Du und {firm} seht diesen Chat.",
  "chats.today": "Heute",
  "chats.week": "Diese Woche",
  "chats.none": "Hier stehen deine Chats.",
  "chats.untitled": "Neuer Chat",
  "chat.you": "Du",
  "chat.ai": "{firm} KI",
  "chat.writing": "{firm} KI schreibt …",
  "chat.empty": "In diesem Chat steht noch nichts.",
  "card.wizard": "Wizard von {firm}",
  "card.open": "Öffnen",
  "status.done": "fertig",
  "status.running": "läuft",
  "status.waiting_input": "wartet auf dich",
  "status.failed": "fehlgeschlagen",
  "status.cancelled": "gestoppt",
  "wizards.title": "Wizards",
  "wizards.lead":
    "Fertige Wizards von {firm}. Ein Wizard fragt dich Schritt für Schritt und legt das Ergebnis in deine Ergebnisse.",
  "wizards.steps.one": "1 Schritt",
  "wizards.steps": "{n} Schritte",
  "wizards.empty": "{firm} hat noch keinen Wizard für dich freigegeben.",
  "wizard.start": "Starten",
  "wizard.starting": "Startet …",
  "results.title": "Ergebnisse",
  "results.files": "Dateien",
  "results.all": "Alle",
  "results.byFirm": "Von {firm}",
  "results.mine": "Von dir",
  "results.empty":
    "Noch keine Ergebnisse. Sie erscheinen hier, sobald ein Wizard fertig ist oder {firm} eins teilt.",
  "results.none": "Mit diesem Filter ist hier nichts.",
  "files.empty": "Noch keine Dateien. Die Unterlagen von {firm} für dich erscheinen hier.",
  "files.download": "Herunterladen",
  "files.all": "Alle Dateien",
  "run.back": "Zurück",
  loading: "Lädt …",
  error: "Etwas ist schiefgegangen: {error}",
  notFound: "Diese Seite gibt es nicht.",
  language: "English",
};

export type Lang = "de" | "en";
export type TextKey = keyof typeof en;

const KEY = "wz_portal_lang";

function firstLang(): Lang {
  try {
    const kept = localStorage.getItem(KEY);
    if (kept === "de" || kept === "en") {
      return kept;
    }
  } catch {
    // Without storage the browser's language decides.
  }
  return navigator.language.toLowerCase().startsWith("de") ? "de" : "en";
}

export let lang: Lang = firstLang();

/** The other language, kept for the next visit; the page loads again in it. */
export function switchLang() {
  const next = lang === "de" ? "en" : "de";
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // Kept for this page only.
  }
  lang = next;
  location.reload();
}

export function t(key: TextKey, params: Record<string, string | number> = {}): string {
  const text = (lang === "de" ? de : en)[key];
  return text.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? ""));
}

/** Whether the words have a key: for a run's status, which the runtime names. */
export const hasText = (key: string): key is TextKey => key in en;
