import type { ClientAuth } from "@engenty/model-sources/clients";
import type { ServerId, ServerTrouble } from "@engenty/model-sources/servers";

/** A client on this computer: what the setup and the settings show of it. */
export interface ClientSetupStatus<Id extends string = string> {
  id: Id;
  name: string;
  /** The name with its provider, where a list shows it. */
  label: string;
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
  /** As the server names it: what `ollama pull` takes, an entry of LM Studio's catalog. */
  name: string;
  job: ModelJob;
  /** The download, in GB. */
  size: number;
  /** About the memory it takes while it answers, in GB. */
  memory: number;
  note: { en: string; de: string };
}

/** A model a server holds. */
export interface HeldModel {
  name: string;
  /** On disk, in GB. */
  size: number;
  jobs: ModelJob[];
  /** As the server says: `completion`, `tools`, `vision`, `audio`, `embedding`, `decision`, … */
  capabilities: string[];
  /** `mlx` or `llamacpp`; null where the server does not say. */
  runner: string | null;
  quantization: string | null;
  /** It leaves this computer room while it answers. */
  fits: boolean;
  /** In memory right now. */
  loaded: boolean;
}

/** A download into a server: while it runs, and how it ended. */
export interface ModelDownload {
  model: string;
  done: number;
  total: number;
  /** `unreachable`: the server does not run on this computer; else what it said. */
  error: string | null;
  finished: boolean;
}

/** A server for open models, as a list shows it. Nothing here loads a model. */
export interface ServerStatus {
  id: ServerId;
  name: string;
  /** It is on this computer, though it may not run. */
  installed: boolean;
  /** It answers at its address. */
  running: boolean;
}

/** A server on this computer, its models and the ones to download. */
export interface LocalModelsState {
  server: ServerStatus & {
    url: string;
    /** Null where the server does not say. */
    version: string | null;
    /** Why it gives nothing away, though it runs. */
    trouble: ServerTrouble | null;
    /** The host can install it itself. */
    canInstall: boolean;
    /** Where the person gets it. */
    download: string;
    /** Its API removes models; else its own app does. */
    removes: boolean;
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
