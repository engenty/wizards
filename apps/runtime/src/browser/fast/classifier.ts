// The System One wire format as the fast loop asks it (https://docs.typesafe.ai/api): one POST
// with a `state` and typed questions, every question answered in the same call. Instructions and
// criteria may be structured, unlike a wizard's decision questions. Ported from engenty-pro's
// `@engenty/typesafe-client`; the way to the model is wizards' own `systemOneAccess()`.

import { systemOneAccess } from "../../models.js";

/** Anything JSON: instructions and criteria may be strings or structured. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface ChoiceQuestion {
  /** Option id → what it covers. */
  criteria: Record<string, JsonValue>;
  instructions?: JsonValue;
  type: "choice";
}

export interface ChoiceAnswer {
  choice: string;
  /** 0–1, derived from how concentrated the distribution is. */
  confidence: number;
  probabilities: Record<string, number>;
  type: "choice";
}

export interface SystemOneRequest {
  model?: string;
  questions: Record<string, ChoiceQuestion>;
  state: JsonValue;
}

export interface SystemOneUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface SystemOneResponse {
  answers: Record<string, unknown>;
  model: string;
  usage?: SystemOneUsage;
}

/** Anything that answers System One questions. */
export interface ClassifierClient {
  systemOne(request: SystemOneRequest): Promise<SystemOneResponse>;
}

/** Probabilities are calibrated and must sum to one, within rounding. */
const SUM_TOLERANCE = 0.02;

function isUnitNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * A choice answer the caller may act on. Rejects anything that does not
 * name one of the offered ids, carries a distribution over exactly those
 * ids, sums to one, and puts the chosen id at the top — so a malformed or
 * truncated response can never become an action. Ported from jev-ultrafast
 * `validate_choice`.
 */
export function validateChoiceAnswer(answer: unknown, ids: Iterable<string>): ChoiceAnswer {
  const offered = new Set(ids);
  const invalid = (): never => {
    throw new Error("typesafe_invalid_choice: answer does not fit the question");
  };
  const a = answer as Partial<ChoiceAnswer> | undefined;
  if (a?.type !== "choice") {
    return invalid();
  }
  const { choice, confidence, probabilities } = a;
  if (
    typeof choice !== "string" ||
    !offered.has(choice) ||
    typeof probabilities !== "object" ||
    probabilities === null ||
    !isUnitNumber(confidence)
  ) {
    return invalid();
  }
  const keys = Object.keys(probabilities);
  if (keys.length !== offered.size || !keys.every((k) => offered.has(k))) {
    return invalid();
  }
  let sum = 0;
  let max = 0;
  for (const key of keys) {
    const p = probabilities[key];
    if (!isUnitNumber(p)) {
      return invalid();
    }
    sum += p;
    max = Math.max(max, p);
  }
  if (Math.abs(sum - 1) >= SUM_TOLERANCE) {
    return invalid();
  }
  if ((probabilities[choice] ?? 0) < max - 1e-6) {
    return invalid();
  }
  return a as ChoiceAnswer;
}

const RETRYABLE = new Set([429, 503, 529]);

/**
 * The run's way to a hosted decision model (credits, an AI Gateway key or a TypeSafe key), or
 * null when there is none — then the fast loop is not offered. Clef in the local Ollama is not
 * taken: a page's elements are more than its 26 options, and on a laptop one step took over a
 * minute (base M4), where the agent's own browser tools take seconds.
 */
export async function classifierClient(signal?: AbortSignal): Promise<ClassifierClient | null> {
  const access = await systemOneAccess().catch(() => null);
  if (!access || access.local) {
    return null;
  }
  return {
    async systemOne(request) {
      const body = JSON.stringify({
        ...request,
        ...(access.model && !request.model ? { model: access.model } : {}),
      });
      for (let attempt = 1; ; attempt++) {
        const res = await fetch(access.url, {
          method: "POST",
          headers: { ...access.headers, "content-type": "application/json" },
          body,
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(25_000)])
            : AbortSignal.timeout(25_000),
        });
        if (res.ok) {
          return (await res.json()) as SystemOneResponse;
        }
        if (!(RETRYABLE.has(res.status) && attempt < 2)) {
          const why = (await res.text().catch(() => "")).trim().slice(0, 300);
          throw new Error(`The decision model answered ${res.status}${why ? `: ${why}` : ""}`);
        }
      }
    },
  };
}
