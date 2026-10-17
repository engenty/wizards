import type { Effort, TextClass } from "@engenty-wizards/shared/definition";
import type { RunNote } from "@engenty-wizards/shared/run";
import type { HarnessImageModel, HarnessModel } from "./model.js";

/**
 * A harness is an AI client installed on this machine — Claude Code, Codex, Antigravity, Cursor
 * Agent — that answers on the person's own subscription or sign-in. The runtime runs it headless
 * as a model (./model.ts) and signs it in through the inline terminal (./terminal.ts). Nothing of
 * this process reaches it: no key of ours, no session of a parent client.
 */
export const HARNESS_IDS = ["claude", "codex", "antigravity", "cursor"] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];

/** How a client is signed in: with the person's subscription, with a key from their shell, or not at all. */
export type HarnessAuth = "subscription" | "api_key" | "none";

/** What the login shell decides about a client: its environment and its sign-in. */
export interface EnvSpec {
  id: HarnessId;
  /** Variables of the login shell the client may see: how it signs in and where it talks to. */
  passThrough: RegExp;
  /** Of those, the keys and tokens: held back while the client is signed in without them. */
  keyVars: string[];
  auth(env: NodeJS.ProcessEnv): Promise<HarnessAuth>;
}

export interface Harness extends EnvSpec {
  /** The product name, as the person knows it. */
  name: string;
  bin: string;
  /** The model each text class runs on unless a binding names another: `<id>/<alias>`. */
  classes: Record<TextClass, string>;
  version(env: NodeJS.ProcessEnv): Promise<string | null>;
  /**
   * What the inline terminal runs to sign the client in. `interactive`: the client's own app
   * opens and the person ends it — the terminal closes by itself once the sign-in is there.
   */
  login: { args: string[]; env?: Record<string, string>; interactive: boolean };
  model(alias: string, effort?: Effort): HarnessModel;
  /**
   * A client that also makes images on the sign-in: the alias the image class runs on unless a
   * binding names another, and the model for it. Video and speech no client makes.
   */
  image?: { alias: string; model(alias: string): HarnessImageModel };
  /** What to tell the person when the signed-in account cannot pay for the call. */
  exhausted?: RunNote;
}
