import { createHash } from "node:crypto";

export const EFFORTS = ["low", "medium", "high"] as const;
export type Effort = (typeof EFFORTS)[number];

/** What the adapters on the providers' own SDKs share. */
export interface SdkSetup {
  /** Without one, the SDK reads its environment (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`). */
  apiKey?: string;
  baseUrl?: string;
  effort?: Effort | null;
  /** The environment variable with the key, named in the same message. */
  keyEnv?: string;
  /** Most tokens one step may write (64 000). */
  maxTokens?: number;
  model: string;
  /** The provider's name, for the person: "Goose has no valid API key for …". */
  name?: string;
}

/** Clients by kind, URL and key, made once. */
export function clientCache<C>() {
  const clients = new Map<string, C>();
  return (kind: string, s: SdkSetup, make: () => C): C => {
    const key = createHash("sha256")
      .update(`${kind}|${s.baseUrl ?? ""}|${s.apiKey ?? ""}`)
      .digest("hex");
    const hit = clients.get(key);
    if (hit) {
      return hit;
    }
    const client = make();
    clients.set(key, client);
    return client;
  };
}

/** A tool call's arguments; undefined when they are no valid JSON. */
export function parseArgs(args: string): unknown {
  try {
    return JSON.parse(args || "{}");
  } catch {
    return;
  }
}
