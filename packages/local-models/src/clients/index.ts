import { claude } from "./claude.js";
import type { Client, ClientId } from "./client.js";
import { codex } from "./codex.js";
import { cursor } from "./cursor.js";

export {
  type ChatCall,
  type ChatClient,
  type ChatEvent,
  type ChatMcp,
  issuesIn,
} from "./chat.js";
export { CLAUDE_BIN, type ClaudeResult, claude, claudeAnswer } from "./claude.js";
export { CLIENT_IDS, type Client, type ClientId } from "./client.js";
export { CODEX_BIN, type CodexEvent, codex, codexAnswer, codexExecArgs } from "./codex.js";
export { CURSOR_BIN, type CursorResult, cursor, cursorWorkspace } from "./cursor.js";
export { type ClientStatus, type Detectable, detectClient } from "./detect.js";
export {
  type ClientAuth,
  clientEnv,
  type EnvSpec,
  forgetEnv,
  freshAuth,
  loginEnv,
  loginShellEnv,
  ProbeUndecided,
  probeVersion,
  type ResolvedEnv,
  resolveEnv,
  run,
  setClientFolders,
  stripKeys,
} from "./env.js";
export {
  ClientFailure,
  type ClientMeta,
  clientFailure,
  type FailureCode,
  failureCode,
} from "./failure.js";
export {
  type Bridge,
  type BridgeTool,
  type ClientAnswer,
  type ClientCall,
  type ClientImageCall,
  ClientImageModel,
  ClientModel,
  type ClientModelOptions,
  type Effort,
} from "./model.js";
export {
  DEFAULT_WORDS,
  extensionOf,
  jsonInstruction,
  type PromptWords,
  parseJsonAnswer,
  renderPrompt,
} from "./prompt.js";
export { type ClientOutput, lastJson, runClient } from "./run.js";

/** The clients, by id. */
export const CLIENTS: Record<ClientId, Client> = { claude, codex, cursor };
