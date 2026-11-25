import type { OfferedModel } from "./types.js";

/**
 * Models that write, for a host that asks no one for a list. The first that fits the computer is
 * the one the setup suggests.
 */
export const OFFERED_TEXT_MODELS: readonly OfferedModel[] = [
  {
    name: "qwen3.8:27b",
    job: "text",
    size: 17.7,
    memory: 22,
    note: {
      en: "Writes, researches and uses tools well; for a Mac with 32 GB or more.",
      de: "Schreibt, recherchiert und nutzt Werkzeuge gut; für einen Mac mit 32 GB oder mehr.",
    },
  },
  {
    name: "gemma4:26b",
    job: "text",
    size: 18.7,
    memory: 22,
    note: {
      en: "Google’s larger Gemma 4; reads images too.",
      de: "Googles größeres Gemma 4; liest auch Bilder.",
    },
  },
  {
    name: "gemma4:12b",
    job: "text",
    size: 8,
    memory: 11,
    note: {
      en: "Enough for short texts and sorting; for a Mac with 16 GB.",
      de: "Reicht für kurze Texte und Einordnen; für einen Mac mit 16 GB.",
    },
  },
  {
    name: "gemma4:e4b",
    job: "text",
    size: 6.6,
    memory: 8,
    note: {
      en: "Small and quick; for short answers.",
      de: "Klein und schnell; für kurze Antworten.",
    },
  },
];
