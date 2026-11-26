import { readFileSync } from "node:fs";

/** Google's APIs whose description is kept in this package, by the name Google gives each. */
export type GoogleApi = "gmail";

/**
 * Google's own description of one of its APIs (its discovery document), as Google served it: a
 * copy kept in `data/google/`, so neither a test nor a run fetches it. Executor turns it into
 * OpenAPI (`convertGoogleDiscoveryToOpenApi`); its `revision` says which day's it is.
 */
export function googleDescription(api: GoogleApi): string {
  return readFileSync(new URL(`./data/google/${api}-v1.json`, import.meta.url), "utf8");
}

/** Where Google's description of `api` says it is reached, as executor's `discoveryUrl` names it. */
export const googleDiscoveryUrl = (api: GoogleApi) =>
  `https://${api}.googleapis.com/$discovery/rest?version=v1`;
