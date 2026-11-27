import type { ChatClient } from "./chat.js";
import type { EnvSpec } from "./env.js";
import type { ClientMeta } from "./failure.js";
import type { ClientModel, ClientModelOptions } from "./model.js";

/** The AI clients a person signs in to with their own subscription. */
export const CLIENT_IDS = ["claude", "codex", "antigravity", "cursor"] as const;
export type ClientId = (typeof CLIENT_IDS)[number];

/**
 * An AI client installed on this computer that answers on the person's own subscription or
 * sign-in: how it is found and signed in, how it runs headless as a model, and how it answers a
 * chat turn with the host's MCP server. Nothing of the host's process reaches it: no key of the
 * host's, no session of a parent client.
 */
export interface Client extends EnvSpec, ChatClient, ClientMeta {
  id: ClientId;
  bin: string;
  /** It takes the host's MCP server in a chat; without it, it only writes. */
  tools: boolean;
  /** Null: not installed. Throws ProbeUndecided when the probe could not finish on a busy machine. */
  version(env: NodeJS.ProcessEnv): Promise<string | null>;
  /**
   * What a terminal runs to sign the client in. `interactive`: the client's own app opens and the
   * person ends it.
   */
  login: { args: string[]; interactive: boolean };
  /** The client as a model; `alias` is the model by the client's own name. */
  model(alias: string, options?: ClientModelOptions): ClientModel;
}
