import type { ProviderId } from "./provider.js";

/**
 * What a provider said to a key:
 * - `ok`: it knows the key. A key that may do only some things counts: it is still a key.
 * - `unknown`: it does not know the key.
 * - `error`: it answered with something else; `status` is the HTTP status.
 * - `unreachable`: it did not answer.
 */
export type KeyCheck =
  | { state: "ok" }
  | { state: "unknown" }
  | { state: "error"; status: number }
  | { state: "unreachable" };

/** The request that costs nothing, per provider: its address and the headers that carry the key. */
const REQUESTS: Record<ProviderId, (key: string) => [string, Record<string, string>]> = {
  openai: (key) => ["https://api.openai.com/v1/models", { authorization: `Bearer ${key}` }],
  anthropic: (key) => [
    "https://api.anthropic.com/v1/models?limit=1",
    { "x-api-key": key, "anthropic-version": "2023-06-01" },
  ],
  google: (key) => [
    "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1",
    { "x-goog-api-key": key },
  ],
  openrouter: (key) => ["https://openrouter.ai/api/v1/key", { authorization: `Bearer ${key}` }],
  gateway: (key) => ["https://ai-gateway.vercel.sh/v1/credits", { authorization: `Bearer ${key}` }],
  fal: (key) => [
    "https://api.fal.ai/v1/models?endpoint_id=fal-ai/flux/schnell",
    { authorization: `Key ${key}` },
  ],
  elevenlabs: (key) => ["https://api.elevenlabs.io/v1/models", { "xi-api-key": key }],
  replicate: (key) => ["https://api.replicate.com/v1/account", { authorization: `Bearer ${key}` }],
};

export interface CheckOptions {
  /** Another fetch, such as a test's. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Whether a provider takes a key: one authenticated request that generates nothing and costs
 * nothing. The answer is a state; each host words it for the person.
 */
export async function checkKey(
  provider: ProviderId,
  key: string,
  options: CheckOptions = {},
): Promise<KeyCheck> {
  const [url, headers] = REQUESTS[provider](key);
  try {
    const res = await (options.fetch ?? fetch)(url, {
      headers,
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
    if (res.ok) {
      return { state: "ok" };
    }
    const body = await res.text().catch(() => "");
    if (res.status === 403 || /missing_permissions/.test(body)) {
      return { state: "ok" };
    }
    return res.status === 401 ? { state: "unknown" } : { state: "error", status: res.status };
  } catch {
    return { state: "unreachable" };
  }
}
