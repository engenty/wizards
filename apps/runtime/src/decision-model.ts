/**
 * A decision model on the person's own machine: Cloudflare's Clef-flash (open weights, Apache
 * 2.0), which Ollama 0.35 and newer serves at /v1/systemone with the same questions and answers
 * as TypeSafe's Jev. The setup offers to pull it; the runtime asks it where no hosted decision
 * model is set up.
 */

/** The model the setup pulls. Clef, its larger sibling, is taken as well where it is there. */
export const LOCAL_DECISION_MODEL = "clef-flash";

/** Ollama's own address from the one the runtime uses for its OpenAI-style API (…/v1). */
export function ollamaRoot(url: string): string {
  return url.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
}

/** The decision model among the models Ollama lists: Clef-flash, else Clef. */
export function decisionModelIn(names: string[]): string | null {
  const named = (base: string) => names.find((n) => n === base || n.startsWith(`${base}:`));
  return named(LOCAL_DECISION_MODEL) ?? named("clef") ?? null;
}

/** The decision model the Ollama at `url` holds; null where it does not run or has none. */
export async function ollamaDecisionModel(url: string, timeoutMs = 1500): Promise<string | null> {
  try {
    const res = await fetch(`${ollamaRoot(url)}/api/tags`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      return null;
    }
    const { models } = (await res.json()) as { models?: { name: string }[] };
    return decisionModelIn((models ?? []).map((m) => m.name));
  } catch {
    return null;
  }
}
