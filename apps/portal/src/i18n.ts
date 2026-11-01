/**
 * The portal's words, in English and German (docs/copy-style.md: du, gender-neutral German;
 * `pnpm copy:check` reads both halves). A client space is "client space" in English and "Space"
 * in German.
 */

const en = {
  "nav.forYou": "For you",
  "nav.chats": "Chats",
  "nav.files": "Files",
  "nav.results": "Results",
  signIn: "Sign in",
  signOut: "Sign out",
  "signIn.clients": "For clients of {firm}",
  "signIn.lead": "Sign in to see your documents, results and chats with {firm}.",
  "signIn.failed": "The sign-in didn’t work. Try again.",
  "public.wizards": "Get started",
  "public.start": "Start",
  "public.nothing": "Nothing here yet.",
  otherOrganization: "You’re signed in for another organization.",
  "otherOrganization.hint": "Sign out, then sign in again for {firm}.",
  noSpaces: "You don’t have a client space here yet.",
  "noSpaces.hint": "{firm} invites you by your e-mail address. Once they have, it shows up here.",
  "spaces.title": "Your client spaces",
  "forYou.waiting": "Waiting for you",
  "forYou.waiting.empty": "Nothing waits for you right now.",
  "forYou.continue": "Continue",
  "forYou.shared": "New from {firm}",
  "forYou.shared.empty": "No results shared with you yet.",
  "forYou.wizards": "What you can start",
  "forYou.wizards.empty": "{firm} hasn’t opened a wizard to you yet.",
  "results.title": "Results",
  "results.empty": "No results yet. They show up here once a wizard is done or {firm} shares one.",
  "results.mine": "yours",
  "results.shared": "shared",
  "files.title": "Files",
  "files.empty": "No files yet.",
  "files.download": "Download",
  "chats.title": "Chats",
  "chats.empty": "No chats yet. Write to {firm} to start one.",
  "chats.new": "New chat",
  "chats.untitled": "New chat",
  "chats.placeholder": "Write to {firm}",
  "chats.send": "Send",
  "chats.ask": "Ask the AI too",
  "chats.ask.hint": "The AI answers with what {firm} has opened to you.",
  "chats.answering": "The AI is answering…",
  "chats.ai": "AI",
  "chats.you": "You",
  "chats.back": "All chats",
  "wizard.start": "Start",
  "wizard.starting": "Starting…",
  "run.back": "Back",
  loading: "Loading…",
  error: "Something went wrong: {error}",
  notFound: "This page doesn’t exist.",
  language: "Deutsch",
};

const de: typeof en = {
  "nav.forYou": "Für dich",
  "nav.chats": "Chats",
  "nav.files": "Dateien",
  "nav.results": "Ergebnisse",
  signIn: "Anmelden",
  signOut: "Abmelden",
  "signIn.clients": "Für Kund:innen von {firm}",
  "signIn.lead": "Melde dich an, um deine Unterlagen, Ergebnisse und Chats mit {firm} zu sehen.",
  "signIn.failed": "Die Anmeldung hat nicht geklappt. Versuch es noch einmal.",
  "public.wizards": "Loslegen",
  "public.start": "Starten",
  "public.nothing": "Hier ist noch nichts.",
  otherOrganization: "Du bist für eine andere Organisation angemeldet.",
  "otherOrganization.hint": "Melde dich ab und dann für {firm} wieder an.",
  noSpaces: "Du hast hier noch keinen Space.",
  "noSpaces.hint": "{firm} lädt dich über deine E-Mail-Adresse ein. Danach erscheint er hier.",
  "spaces.title": "Deine Spaces",
  "forYou.waiting": "Wartet auf dich",
  "forYou.waiting.empty": "Gerade wartet nichts auf dich.",
  "forYou.continue": "Weitermachen",
  "forYou.shared": "Neu von {firm}",
  "forYou.shared.empty": "Noch keine Ergebnisse mit dir geteilt.",
  "forYou.wizards": "Was du starten kannst",
  "forYou.wizards.empty": "{firm} hat noch keinen Wizard für dich freigegeben.",
  "results.title": "Ergebnisse",
  "results.empty":
    "Noch keine Ergebnisse. Sie erscheinen hier, sobald ein Wizard fertig ist oder {firm} eins teilt.",
  "results.mine": "von dir",
  "results.shared": "geteilt",
  "files.title": "Dateien",
  "files.empty": "Noch keine Dateien.",
  "files.download": "Herunterladen",
  "chats.title": "Chats",
  "chats.empty": "Noch keine Chats. Schreib {firm}, um einen zu beginnen.",
  "chats.new": "Neuer Chat",
  "chats.untitled": "Neuer Chat",
  "chats.placeholder": "Schreib {firm}",
  "chats.send": "Senden",
  "chats.ask": "Auch die KI fragen",
  "chats.ask.hint": "Die KI antwortet mit dem, was {firm} für dich freigegeben hat.",
  "chats.answering": "Die KI antwortet …",
  "chats.ai": "KI",
  "chats.you": "Du",
  "chats.back": "Alle Chats",
  "wizard.start": "Starten",
  "wizard.starting": "Startet …",
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
