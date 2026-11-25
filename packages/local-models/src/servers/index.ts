import { lmStudio } from "../lmstudio/server.js";
import { ollama } from "../ollama/server.js";
import type { LocalServer, ServerId } from "./server.js";

export {
  fits,
  type InstalledModel,
  type LocalServer,
  SERVER_IDS,
  type ServerId,
  type ServerOptions,
  type ServerState,
  type ServerTrouble,
} from "./server.js";

/** The servers, by id. */
export const SERVERS: Record<ServerId, LocalServer> = { ollama, lmstudio: lmStudio };
