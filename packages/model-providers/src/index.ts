export { CLIENT_IDS, CLIENTS, type Client, type ClientId, detectClient } from "./clients/index.js";
export { ollamaModel } from "./ollama/index.js";
export { type ProbeResult, type ProbeSource, type ProbeState, probe } from "./probe.js";
export {
  fits,
  type InstalledModel,
  type LocalServer,
  SERVER_IDS,
  SERVERS,
  type ServerId,
} from "./servers/index.js";
