export { macAppPresent, suggestedClient, vendorApp } from "./apps.js";
export {
  ClientSetup,
  type ClientSetupOptions,
  type SetupClient,
  type TerminalCommand,
} from "./clients.js";
export { OllamaModels, type OllamaModelsOptions } from "./local-models.js";
export { Tested, type TestedStore } from "./models.js";
export {
  appAsksForPassword,
  findOllama,
  freeGb,
  installOllama,
  type Outcome,
  startOllama,
} from "./ollama.js";
export { type SetupHost, type SetupModels, type SourceOutcome, setupRoutes } from "./routes.js";
export { TerminalError, type TerminalOptions, Terminals } from "./terminal.js";
