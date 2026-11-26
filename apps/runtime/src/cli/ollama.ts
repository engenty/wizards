import { ollamaAddress, ollamaState } from "@engenty/model-providers/ollama";
import { findOllama } from "@engenty/model-setup/server";
import { decisionModelIn } from "../decision-model.js";

/** The first Ollama that answers decision questions at /v1/systemone. */
const DECISIONS_SINCE = [0, 35, 0];

/** What Clef-flash takes on disk, and about as much memory while it answers, in GB. */
export const DECISION_MODEL_GB = 11;

export interface LocalOllamaState {
  /** The `ollama` command; null where Ollama is not installed. */
  path: string | null;
  /** The version of the server that answers; null where none does. */
  version: string | null;
  /** The decision model it holds, as Ollama names it. */
  model: string | null;
}

/** Ollama on this computer: its command, the server that answers at OLLAMA_URL, and its decision model. */
export async function localOllama(env: NodeJS.ProcessEnv = process.env): Promise<LocalOllamaState> {
  const { version, models } = await ollamaState(ollamaAddress(env));
  return { path: findOllama(env), version, model: decisionModelIn(models) };
}

/** Whether this Ollama is new enough to answer decision questions. */
export function servesDecisions(version: string): boolean {
  const parts = version.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  for (const [i, wanted] of DECISIONS_SINCE.entries()) {
    const have = parts[i] ?? 0;
    if (have !== wanted) {
      return have > wanted;
    }
  }
  return true;
}

/**
 * Whether Ollama runs the model: one question it has to answer. Null when it does; otherwise
 * Ollama's reason, such as a newer Ollama that no longer runs a model in the format it was pulled
 * in. The model is loaded for it, which takes some seconds the first time.
 */
export async function decisionModelProblem(
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  try {
    const res = await fetch(`${ollamaAddress(env)}/v1/systemone`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        state: "The setup checks the decision model.",
        questions: { check: { type: "noul", instructions: "Is this a check?" } },
      }),
      signal: AbortSignal.timeout(180_000),
    });
    if (res.ok) {
      return null;
    }
    const text = (await res.text()).trim();
    try {
      return (JSON.parse(text) as { error?: string }).error ?? text;
    } catch {
      return text || `Ollama answered ${res.status}.`;
    }
  } catch (error) {
    return (error as Error).message;
  }
}
