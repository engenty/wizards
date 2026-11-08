// The `local` way: a decision model an Ollama holds (Cloudflare's Clef-flash,
// or its larger sibling Clef), served at /v1/systemone like Jev, no key.

import { TypeSafeError } from "./client.js";
import type { DecisionEnv, DecisionModel, DecisionOptions, Way } from "./ways.js";

export const DEFAULT_OLLAMA_URL = "http://localhost:11434";
/** Open weights; the setup pulls it. */
export const LOCAL_DECISION_MODEL = "clef-flash";
const LOCAL_FALLBACK_MODEL = "clef";
/** What Ollama holds is looked up at most this often. */
const LOOK_MS = 60_000;
/** A model Ollama refused is left out this long. */
export const REST_MS = 10 * 60_000;
const LOOK_TIMEOUT_MS = 1500;
const ASK_TIMEOUT_MS = 25_000;

const looks = new Map<string, { until: number; models: Set<string> }>();
const resting = new Map<string, number>();

/** The root of an Ollama, whether given as `host:11434` or `host:11434/v1`. */
export function ollamaRoot(url: string | undefined): string {
  return (url?.trim() || DEFAULT_OLLAMA_URL).replace(/\/+$/, "").replace(/\/(v1|api)$/, "");
}

/** Forgets what Ollama held and any rest: after the settings changed. */
export function forgetLocalDecision(): void {
  looks.clear();
  resting.clear();
}

function isResting(root: string): boolean {
  return Date.now() < (resting.get(root) ?? 0);
}

/**
 * Ollama refused the model itself, not the question: it is gone, wants to be
 * downloaded again, or does not fit into memory. Nothing else is worth a rest.
 */
function cannotRun(status: number, body: string): boolean {
  return (
    status === 404 ||
    status >= 500 ||
    /no longer supported|re-?download|ollama pull|not found/i.test(body)
  );
}

async function heldModels(root: string, fetchImpl: typeof fetch): Promise<Set<string>> {
  const hit = looks.get(root);
  if (hit && Date.now() < hit.until) {
    return hit.models;
  }
  const models = new Set<string>();
  try {
    const res = await fetchImpl(`${root}/api/tags`, {
      signal: AbortSignal.timeout(LOOK_TIMEOUT_MS),
    });
    if (res.ok) {
      const body = (await res.json()) as { models?: { name: string }[] };
      for (const m of body.models ?? []) {
        models.add(m.name);
        if (m.name.endsWith(":latest")) {
          models.add(m.name.slice(0, -":latest".length));
        }
      }
    }
  } catch {
    // Not running: no local way.
  }
  looks.set(root, { models, until: Date.now() + LOOK_MS });
  return models;
}

/** The one named, else Clef-flash, else Clef, as the Ollama holds them. */
async function pickModel(
  root: string,
  named: string | undefined,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  const held = await heldModels(root, fetchImpl);
  if (named?.trim()) {
    return held.has(named.trim()) ? named.trim() : null;
  }
  const find = (head: string) => [...held].find((n) => n === head || n.startsWith(`${head}:`));
  return find(LOCAL_DECISION_MODEL) ?? find(LOCAL_FALLBACK_MODEL) ?? null;
}

export const localWay: Way = {
  way: "local",
  async open(env: DecisionEnv, options: DecisionOptions = {}): Promise<DecisionModel | null> {
    const root = ollamaRoot(env.ollamaUrl);
    if (isResting(root)) {
      return null;
    }
    const fetchImpl = options.fetchImpl ?? fetch;
    const model = await pickModel(root, env.localModel, fetchImpl);
    if (!model) {
      return null;
    }
    return {
      way: "local",
      model,
      async systemOne(request) {
        let res: Response;
        try {
          res = await fetchImpl(`${root}/v1/systemone`, {
            body: JSON.stringify({
              model: request.model ?? model,
              questions: request.questions,
              state: request.state,
            }),
            headers: { "content-type": "application/json" },
            method: "POST",
            signal: AbortSignal.timeout(options.timeoutMs ?? ASK_TIMEOUT_MS),
          });
        } catch (error) {
          throw new TypeSafeError(
            `local_decision_unreachable: ${error instanceof Error ? error.message : String(error)}`,
            null,
          );
        }
        if (!res.ok) {
          const body = (await res.text().catch(() => "")).trim().slice(0, 300);
          if (cannotRun(res.status, body)) {
            resting.set(root, Date.now() + REST_MS);
            looks.delete(root);
          }
          throw new TypeSafeError(
            `local_decision_http_${res.status}${body ? `: ${body}` : ""}`,
            res.status,
          );
        }
        return (await res.json()) as Awaited<ReturnType<DecisionModel["systemOne"]>>;
      },
    };
  },
};
