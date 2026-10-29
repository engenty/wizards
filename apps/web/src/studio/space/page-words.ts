import type { ItemFormat } from "@engenty/wizards-shared/marketplace";
import type { PageVoice } from "./page-address";

/**
 * The public page's own words in the page's language and form, as Manage writes them on the
 * page (its `pages/texts.ts`): for the teaser preview beside the page's fields. Not the studio's
 * copy: the studio is read in the maker's language, the page in the visitors'.
 */
export const PAGE_WORDS: Record<
  PageVoice,
  {
    youDo: string;
    howItGoes: string;
    youGet: string;
    start: string;
    minutes: (n: number) => string;
    fields: (n: number) => string;
    reviews: (n: number) => string;
    uploads: string;
    kinds: Record<ItemFormat, string>;
  }
> = {
  "de-du": {
    youDo: "Du machst",
    howItGoes: "So läuft es",
    youGet: "Du bekommst",
    start: "Los geht’s",
    minutes: (n) => `etwa ${n} Min`,
    fields: (n) => (n === 1 ? "1 Frage" : `${n} Fragen`),
    reviews: (n) => (n === 1 ? "einmal prüfen" : `${n}-mal prüfen`),
    uploads: "Dateien hochladen",
    kinds: {
      text: "Text",
      document: "Dokument",
      table: "Tabelle",
      image: "Bild",
      video: "Video",
      audio: "Audio",
      dashboard: "Widget",
    },
  },
  "de-sie": {
    youDo: "Sie machen",
    howItGoes: "So läuft es",
    youGet: "Sie bekommen",
    start: "Los geht’s",
    minutes: (n) => `etwa ${n} Min`,
    fields: (n) => (n === 1 ? "1 Frage" : `${n} Fragen`),
    reviews: (n) => (n === 1 ? "einmal prüfen" : `${n}-mal prüfen`),
    uploads: "Dateien hochladen",
    kinds: {
      text: "Text",
      document: "Dokument",
      table: "Tabelle",
      image: "Bild",
      video: "Video",
      audio: "Audio",
      dashboard: "Widget",
    },
  },
  en: {
    youDo: "You do",
    howItGoes: "How it goes",
    youGet: "You get",
    start: "Let’s go",
    minutes: (n) => `about ${n} min`,
    fields: (n) => (n === 1 ? "1 question" : `${n} questions`),
    reviews: (n) => (n === 1 ? "one check" : `${n} checks`),
    uploads: "Upload files",
    kinds: {
      text: "Text",
      document: "Document",
      table: "Table",
      image: "Image",
      video: "Video",
      audio: "Audio",
      dashboard: "Widget",
    },
  },
};
