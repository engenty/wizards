import { NotedError, noteOf } from "../model-errors.js";
import { SignInNeeded } from "./types.js";

/*
 * What a failed step's error means for the run, in one place. It reads the shapes the AI SDK and
 * the gateways really throw (test/failures.test.ts calls them against a real server), not words in
 * a message:
 *
 * - `@ai-sdk/gateway` wraps an `APICallError` in `cause` and keeps the status on both, but only the
 *   inner one has the headers. The Manage-App's 402 arrives as a `GatewayInternalServerError` that
 *   says neither "402" nor "insufficient_credits" in its message.
 * - A network error or a timeout through the gateway arrives with status 500, so what lies deeper
 *   in `cause` counts first.
 * - The SDK's own retries end in a `RetryError`; what happened is in its `lastError`.
 */

export type FailureClass =
  /** Short trouble at a provider: the step tries again later. */
  | "retry"
  /** Out of credits: it waits until someone tops up. */
  | "credits"
  /** A sign-in ran out: it waits until someone signs in. */
  | "sign_in"
  /** Nothing to wait for: `onFail`, or the run fails. */
  | "final";

export interface Failure {
  class: FailureClass;
  /** What the service asked for in `Retry-After`; null when it did not. */
  retryAfterMs: number | null;
  /** For wording and the log. */
  why:
    | "rate_limit"
    | "server"
    | "timeout"
    | "network"
    | "credits"
    | "provider_credits"
    | "sign_in"
    | "other";
}

const NOTE_CLASS: Record<string, FailureClass> = {
  wizardRunOutCredits: "credits",
  guestBudget: "credits",
  providerCreditLow: "credits",
  clientNoCredit: "credits",
  chatgptAccountCodexSigned: "credits",
  anthropicAccountClaudeCode: "credits",
  clientNotSignedIn: "sign_in",
  accountNoLongerSigned: "sign_in",
  creditsNotSignedIn: "sign_in",
};

/** An answer that came and is wrong: asking again is the step's own job, not the clock's. */
const INVALID_OUTPUT = new Set([
  "AI_NoObjectGeneratedError",
  "AI_NoOutputGeneratedError",
  "AI_TypeValidationError",
  "AI_JSONParseError",
  "AI_InvalidResponseDataError",
]);

/** The account behind a key is empty; a 429 can say this too (OpenAI's `insufficient_quota`). */
const ACCOUNT_EMPTY =
  /insufficient_quota|exceeded your current quota|insufficient_funds|credit balance|minimum balance|top up your credits|billing_hard_limit/i;

/** A refusal for this account or tier, whatever status it came with: time changes nothing. */
const REFUSED_ACCOUNT =
  /RestrictedModelsError|Free tier users do not have access|"type"\s*:\s*"(outside_tier|not_in_policy)"/i;

const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);
const TIMEOUT_CODES = /TIMEOUT|ETIMEDOUT/;
const NETWORK_WORDS = /fetch failed|socket hang up|Cannot connect to API/i;

type Link = {
  name?: string;
  message?: string;
  code?: unknown;
  status?: unknown;
  statusCode?: unknown;
  responseBody?: unknown;
  responseHeaders?: Record<string, string>;
  lastError?: unknown;
  cause?: unknown;
};

/** The error and what it wraps, outermost first; a RetryError stands for its last error. */
function chainOf(err: unknown): Link[] {
  const links: Link[] = [];
  let at = err as Link | null | undefined;
  while (at && typeof at === "object" && links.length < 10 && !links.includes(at)) {
    links.push(at);
    at = (at.name === "AI_RetryError" && at.lastError ? at.lastError : at.cause) as Link;
  }
  return links;
}

function statusOf(link: Link): number | null {
  for (const value of [link.statusCode, link.status]) {
    if (typeof value === "number" && value >= 100 && value < 600) {
      return value;
    }
  }
  return null;
}

/**
 * `Retry-After` as seconds or as a date, and the `retry-after-ms` some providers send beside it.
 * The SDK's headers are in lower case.
 */
export function retryAfterMs(links: Link[], now = Date.now()): number | null {
  for (const link of links) {
    const headers = link.responseHeaders;
    if (!headers) {
      continue;
    }
    const ms = Number(headers["retry-after-ms"]);
    if (headers["retry-after-ms"] && Number.isFinite(ms) && ms >= 0) {
      return ms;
    }
    const said = headers["retry-after"];
    if (said) {
      const seconds = Number(said);
      if (Number.isFinite(seconds)) {
        return seconds >= 0 ? seconds * 1000 : null;
      }
      const at = Date.parse(said);
      return Number.isNaN(at) ? null : Math.max(0, at - now);
    }
  }
  return null;
}

/**
 * An unclear error is not retried. A retry repeats the step for nothing at best and repeats what
 * it did at worst, and only what is known to be short trouble is worth that. So `retry` needs a
 * status or a network code that says so, and anything else lands on `final`.
 */
export function classifyFailure(err: unknown, opts: { managed: boolean }): Failure {
  const final = (why: Failure["why"] = "other"): Failure => ({
    class: "final",
    retryAfterMs: null,
    why,
  });
  if (err instanceof SignInNeeded) {
    return { class: "sign_in", retryAfterMs: null, why: "sign_in" };
  }
  // What the runtime itself says, it means: a step's own failure is never a provider's trouble.
  if (err instanceof NotedError) {
    const cls = NOTE_CLASS[noteOf(err)?.code ?? ""] ?? "final";
    return {
      class: cls,
      retryAfterMs: null,
      why: cls === "credits" ? "credits" : cls === "sign_in" ? "sign_in" : "other",
    };
  }
  const links = chainOf(err);
  if (links.some((l) => INVALID_OUTPUT.has(l.name ?? ""))) {
    return final();
  }
  // A stop is no trouble. It comes here only when the run was not stopped: nobody knows what it is.
  if (links[0]?.name === "AbortError") {
    return final();
  }
  const text = links
    .map((l) => `${l.message ?? ""} ${typeof l.responseBody === "string" ? l.responseBody : ""}`)
    .join(" ");
  if (REFUSED_ACCOUNT.test(text)) {
    return final();
  }
  const statuses = links.map(statusOf).filter((s): s is number => s !== null);
  if (statuses.includes(402)) {
    return { class: "credits", retryAfterMs: null, why: "credits" };
  }
  if (ACCOUNT_EMPTY.test(text)) {
    // A runtime that runs alone pays its provider itself, so its admin can top up. In the cloud it
    // is the platform's own account: nothing the run's people can do, and no use waiting for them.
    return opts.managed
      ? final("provider_credits")
      : { class: "credits", retryAfterMs: null, why: "provider_credits" };
  }
  // Deeper first: through the gateway a dropped connection looks like its status 500.
  for (const link of links) {
    const code = typeof link.code === "string" ? link.code : "";
    // `AbortSignal.timeout`'s; a browser's or a renderer's TimeoutError is no provider's trouble.
    if (link.name === "TimeoutError" && link instanceof DOMException) {
      return { class: "retry", retryAfterMs: null, why: "timeout" };
    }
    if (NETWORK_CODES.has(code)) {
      return {
        class: "retry",
        retryAfterMs: null,
        why: TIMEOUT_CODES.test(code) ? "timeout" : "network",
      };
    }
  }
  if (!statuses.length && links.some((l) => NETWORK_WORDS.test(l.message ?? ""))) {
    return { class: "retry", retryAfterMs: null, why: "network" };
  }
  // Only what a service says with its status counts. The innermost one is what it really answered.
  const status = statuses.at(-1);
  if (status === 429) {
    return { class: "retry", retryAfterMs: retryAfterMs(links), why: "rate_limit" };
  }
  if (status === 408) {
    return { class: "retry", retryAfterMs: null, why: "timeout" };
  }
  if (status !== undefined && status >= 500 && status !== 501 && status !== 505) {
    return { class: "retry", retryAfterMs: retryAfterMs(links), why: "server" };
  }
  return final();
}
