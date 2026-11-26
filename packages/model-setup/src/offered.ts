import type { ServerId } from "@engenty/model-providers/servers";
import type { OfferedModel } from "./types.js";

const NOTES = {
  qwen: {
    en: "Writes, researches and uses tools well; for a Mac with 32 GB or more.",
    de: "Schreibt, recherchiert und nutzt Werkzeuge gut; für einen Mac mit 32 GB oder mehr.",
  },
  gemmaLarge: {
    en: "Google’s larger Gemma 4; reads images too.",
    de: "Googles größeres Gemma 4; liest auch Bilder.",
  },
  gemma: {
    en: "Enough for short texts and sorting; for a Mac with 16 GB.",
    de: "Reicht für kurze Texte und Einordnen; für einen Mac mit 16 GB.",
  },
  small: {
    en: "Small, with tools; for short answers on any Mac.",
    de: "Klein, mit Werkzeugen; für kurze Antworten auf jedem Mac.",
  },
  gemmaSmall: {
    en: "Small and quick; for short answers.",
    de: "Klein und schnell; für kurze Antworten.",
  },
};

/**
 * Models that write, by the server that runs them, for a host that asks no one for a list. The
 * first that fits the computer is the one the setup suggests.
 */
export const OFFERED_MODELS: Record<ServerId, readonly OfferedModel[]> = {
  ollama: [
    { name: "qwen3.8:27b", job: "text", size: 17.7, memory: 22, note: NOTES.qwen },
    { name: "gemma4:26b", job: "text", size: 18.7, memory: 22, note: NOTES.gemmaLarge },
    { name: "gemma4:12b", job: "text", size: 8, memory: 11, note: NOTES.gemma },
    { name: "gemma4:e4b", job: "text", size: 6.6, memory: 8, note: NOTES.gemmaSmall },
  ],
  lmstudio: [
    { name: "qwen/qwen3.8-27b", job: "text", size: 16, memory: 20, note: NOTES.qwen },
    { name: "google/gemma-4-26b-a4b", job: "text", size: 16, memory: 20, note: NOTES.gemmaLarge },
    { name: "google/gemma-4-12b", job: "text", size: 7, memory: 10, note: NOTES.gemma },
    { name: "google/gemma-4-e4b", job: "text", size: 6, memory: 8, note: NOTES.gemmaSmall },
  ],
  mlx: [
    {
      name: "mlx-community/Qwen3.8-27B-4bit",
      job: "text",
      size: 16.1,
      memory: 20,
      note: NOTES.qwen,
    },
    {
      name: "mlx-community/gemma-4-26b-a4b-it-4bit",
      job: "text",
      size: 15.4,
      memory: 19,
      note: NOTES.gemmaLarge,
    },
    {
      name: "mlx-community/gemma-4-12b-it-4bit",
      job: "text",
      size: 6.8,
      memory: 10,
      note: NOTES.gemma,
    },
    { name: "mlx-community/Qwen3-4B-4bit", job: "text", size: 2.3, memory: 5, note: NOTES.small },
  ],
};
