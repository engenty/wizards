/**
 * What a failed step means for the run, by class: the table `transition()` reads as
 * `FlowFailure`. The runtime's engine/failures.ts tells the class of an error it caught.
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

/** The class of a failure the runtime or a step says itself, by its note. */
export const NOTE_CLASS: Record<string, FailureClass> = {
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
