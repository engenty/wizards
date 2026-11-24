/** Who answers, as a failure names it. */
export interface ClientMeta {
  id: string;
  /** The product name, as the person knows it. */
  name: string;
}

/**
 * Why a client did not answer: its account cannot pay (`exhausted`), the vendor no longer serves
 * that account with this client (`not_served`), it is not signed in (`signed_out`), it is not
 * installed (`not_installed`), or anything else (`failed`). Each host words them itself.
 */
export type FailureCode = "exhausted" | "not_served" | "signed_out" | "not_installed" | "failed";

/** A client's failure, with what the client itself said. */
export class ClientFailure extends Error {
  readonly code: FailureCode;
  readonly client: ClientMeta;
  /** What the client said, as it said it. */
  readonly detail: string;
  /** The client's whole last output, where it says more than `detail`. */
  readonly raw?: string;

  constructor(code: FailureCode, client: ClientMeta, detail: string, raw?: string) {
    super(`${client.name}: ${detail}`.slice(0, 500));
    this.code = code;
    this.client = client;
    this.detail = detail;
    this.raw = raw;
  }
}

/** The kind of failure a client's own words describe. */
export function failureCode(detail: string): FailureCode {
  if (
    /credit balance|billing|too low|usage limit|quota|insufficient|rate.?limit|\b429\b/i.test(
      detail,
    )
  ) {
    return "exhausted";
  }
  // Signed in, but the vendor no longer serves that account with this client: signing in again
  // with the same account changes nothing.
  if (/IneligibleTier|no longer supported|UNSUPPORTED_CLIENT|not eligible/i.test(detail)) {
    return "not_served";
  }
  if (
    /authenticat|log ?in|logged in|oauth|credential|unauthori[sz]ed|\b401\b|api key/i.test(detail)
  ) {
    return "signed_out";
  }
  return "failed";
}

/** The failure a client reports, sorted by what it says. */
export function clientFailure(client: ClientMeta, detail: string, raw?: string): ClientFailure {
  return new ClientFailure(failureCode(detail), client, detail, raw);
}
