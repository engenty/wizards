import type { ClientAuth } from "@engenty/local-models/clients";

/** A client on this computer: what the setup and the settings show of it. */
export interface ClientSetupStatus<Id extends string = string> {
  id: Id;
  name: string;
  /** How to install it in a terminal; the setup runs the same command. */
  install: string;
  /** The vendor's desktop app on this computer ("Claude"): the subscription is most likely there. */
  app: string | null;
  /** Null: not installed. */
  version: string | null;
  auth: ClientAuth;
  /** The sign-in opens the client's own app, which the person ends. */
  interactiveLogin: boolean;
  /** It makes images on the sign-in as well (Codex); video and audio no client makes. */
  images: boolean;
}

/** What a terminal says to the page that shows it. */
export type TerminalEvent =
  | { type: "data"; data: string }
  | { type: "exit"; code: number }
  | { type: "done" };

/** What a model does: writes text, finds by meaning, decides. */
export const MODEL_JOBS = ["text", "search", "decision"] as const;
export type ModelJob = (typeof MODEL_JOBS)[number];

/** A model the host offers to download for a job; the best of a job comes first. */
export interface OfferedModel {
  /** As Ollama names it: what `ollama pull` takes. */
  name: string;
  job: ModelJob;
  /** The download, in GB. */
  size: number;
  /** About the memory it takes while it answers, in GB. */
  memory: number;
  note: { en: string; de: string };
}

/** A model Ollama holds. */
export interface HeldModel {
  name: string;
  /** On disk, in GB. */
  size: number;
  jobs: ModelJob[];
  /** As Ollama says: `completion`, `tools`, `vision`, `audio`, `embedding`, `decision`, … */
  capabilities: string[];
  /** `mlx` or `llamacpp`; null where Ollama does not say. */
  runner: string | null;
  quantization: string | null;
  /** It leaves this computer room while it answers. */
  fits: boolean;
  /** In memory right now. */
  loaded: boolean;
}

/** A download into Ollama: while it runs, and how it ended. */
export interface ModelDownload {
  model: string;
  done: number;
  total: number;
  /** `ollama`: Ollama does not run on this computer; else what Ollama said. */
  error: string | null;
  finished: boolean;
}

/** Ollama on this computer, its models and the ones to download. */
export interface OllamaModelsState {
  ollama: {
    url: string;
    /** Null: Ollama does not answer at the address. */
    version: string | null;
    /** It is on this computer, though it may not run. */
    installed: boolean;
    /** The host can install it itself: on a Mac. */
    canInstall: boolean;
    start: { running: boolean; error: string | null } | null;
  };
  /** The computer's memory and the free space for models, in GB. */
  memory: number;
  free: number | null;
  installed: HeldModel[];
  /** Null: the list is not reachable, the installed models stand alone. */
  offered: (OfferedModel & { installed: boolean; fits: boolean })[] | null;
  downloads: ModelDownload[];
}
