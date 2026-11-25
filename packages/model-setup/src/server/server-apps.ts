import type { ServerId } from "@engenty/local-models/servers";
import type { Outcome } from "./install.js";
import { findLmStudio, startLmStudio } from "./lmstudio.js";
import { findOllama, installOllama, startOllama } from "./ollama.js";

/** A server as a program on this computer. */
export interface ServerApp {
  /** Its command or app; null: it is not here. */
  find(): string | null;
  /** Where the person gets it. */
  download: string;
  /** Absent: the person installs it. */
  install?(logs: string, onLine: (line: string) => void): Promise<Outcome>;
  /** Starts it and waits until it answers. */
  start(logs: string, answers: () => Promise<boolean>): Promise<boolean>;
}

export const SERVER_APPS: Record<ServerId, ServerApp> = {
  ollama: {
    find: () => findOllama(),
    download: "https://ollama.com/download",
    // On Linux its installer asks for a password in a terminal.
    ...(process.platform === "darwin" ? { install: installOllama } : {}),
    start: async (logs) => (await startOllama(findOllama(), logs)) !== null,
  },
  // Its terms leave the install to the person.
  lmstudio: {
    find: findLmStudio,
    download: "https://lmstudio.ai/download",
    start: startLmStudio,
  },
};
