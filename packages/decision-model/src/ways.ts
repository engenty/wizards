// The ways to a decision model. All of them take the same System One request
// and differ only in address, key and model name: Jev through the Vercel AI
// Gateway, Jev on TypeSafe's own API, or Clef-flash (or Clef) in Ollama.

import {
  AI_GATEWAY_API_KEY_ENV,
  DEFAULT_TYPESAFE_BASE_URL,
  DEFAULT_TYPESAFE_MODEL,
  TYPESAFE_API_KEY_ENV,
  TypeSafeClient,
  type TypeSafeClientOptions,
  VERCEL_JEV_MODEL,
  VERCEL_TYPESAFE_BASE_URL,
} from "./client.js";
import { localWay } from "./local.js";
import type { SystemOneRequest, SystemOneResponse } from "./types.js";

export const OLLAMA_BASE_URL_ENV = "OLLAMA_BASE_URL";

/** The ways, in the order `auto` tries them. */
export const DECISION_WAYS = ["gateway", "typesafe", "local"] as const;
export type DecisionWay = (typeof DECISION_WAYS)[number];
export const DECISION_CHOICES = ["auto", ...DECISION_WAYS, "off"] as const;
export type DecisionChoice = (typeof DECISION_CHOICES)[number];

export interface DecisionEnv {
  /** Vercel AI Gateway. */
  gatewayKey?: string;
  /** Ollama's model to use; default Clef-flash, else Clef. */
  localModel?: string;
  /** Ollama's address; default http://localhost:11434. */
  ollamaUrl?: string;
  /** TypeSafe's own API. */
  typesafeKey?: string;
}

export type DecisionOptions = Pick<TypeSafeClientOptions, "fetchImpl" | "retries" | "timeoutMs">;

export interface DecisionModel {
  /** The model as its way spells it: typesafe-ai/jev, jev-latest, clef-flash. */
  model: string;
  systemOne(request: SystemOneRequest): Promise<SystemOneResponse>;
  way: string;
}

/** A way a host adds to the built-in ones (wizards: its credits). */
export interface Way {
  open(env: DecisionEnv, options?: DecisionOptions): Promise<DecisionModel | null>;
  way: string;
}

/** The env slice the package reads, from a `process.env`-like reader. */
export function decisionEnvFrom(
  readEnv: (key: string) => string | undefined = (key) =>
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[key],
): DecisionEnv {
  return {
    gatewayKey: readEnv(AI_GATEWAY_API_KEY_ENV),
    ollamaUrl: readEnv(OLLAMA_BASE_URL_ENV),
    typesafeKey: readEnv(TYPESAFE_API_KEY_ENV),
  };
}

function keyed(way: string, key: string | undefined, baseUrl: string, model: string): Way["open"] {
  return (_env, options = {}) => {
    const apiKey = key?.trim();
    if (!apiKey) {
      return Promise.resolve(null);
    }
    const client = new TypeSafeClient({ apiKey, baseUrl, model, ...options });
    return Promise.resolve({
      way,
      model,
      systemOne: (request) => client.systemOne(request),
    });
  };
}

const gatewayWay: Way = {
  way: "gateway",
  open: (env, options) =>
    keyed("gateway", env.gatewayKey, VERCEL_TYPESAFE_BASE_URL, VERCEL_JEV_MODEL)(env, options),
};

const typesafeWay: Way = {
  way: "typesafe",
  open: (env, options) =>
    keyed(
      "typesafe",
      env.typesafeKey,
      DEFAULT_TYPESAFE_BASE_URL,
      DEFAULT_TYPESAFE_MODEL,
    )(env, options),
};

const BUILT_IN: Record<DecisionWay, Way> = {
  gateway: gatewayWay,
  local: localWay,
  typesafe: typesafeWay,
};

/** The decision model one way reaches; null where that way has none. */
export function decisionBy(
  way: DecisionWay,
  env: DecisionEnv,
  options?: DecisionOptions,
): Promise<DecisionModel | null> {
  return BUILT_IN[way].open(env, options);
}

/**
 * The decision model a choice names: `auto` is the first way that opens, the
 * built-in ones in order, then the host's `extra`; `off` and a way that has
 * none are null. What follows null is the host's.
 */
export async function decisionOf(
  choice: string,
  env: DecisionEnv,
  extra: Way[] = [],
  options?: DecisionOptions,
): Promise<DecisionModel | null> {
  if (choice === "off") {
    return null;
  }
  const ways = [...DECISION_WAYS.map((w) => BUILT_IN[w]), ...extra];
  for (const way of choice === "auto" ? ways : ways.filter((w) => w.way === choice)) {
    const found = await way.open(env, options);
    if (found) {
      return found;
    }
  }
  return null;
}

/** Which ways have a decision model now: for a settings page. */
export async function decisionReady(
  env: DecisionEnv,
  extra: Way[] = [],
  options?: DecisionOptions,
): Promise<Record<string, boolean>> {
  const ways = [...DECISION_WAYS.map((w) => BUILT_IN[w]), ...extra];
  const found = await Promise.all(
    ways.map(async (w) => [w.way, Boolean(await w.open(env, options))] as const),
  );
  return Object.fromEntries(found);
}
