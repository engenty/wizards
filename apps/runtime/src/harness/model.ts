import { join } from "node:path";
import {
  type ClientFailure,
  type ClientMeta,
  type ClientModelOptions,
  clientFailure,
} from "@engenty/local-models/clients";
import type { RunNote } from "@engenty/wizards-shared/run";
import { note } from "@engenty/wizards-shared/run";
import { env } from "../env.js";
import { openBridge } from "../mcp/bridge.js";
import { ModelUnavailableError } from "../model-errors.js";
import { CLIENT_WORDS } from "./prompt.js";

/**
 * What the runtime adds to an installed client as a model (@engenty/local-models/clients): a
 * folder for each call under the data folder, the call's tools served over MCP (../mcp/bridge.ts),
 * the prompt's sentences from prompts/, and a failure as the note the person reads.
 */

/** Who answers, as a failure names it: an installed client, or Apple Intelligence (./apple.ts). */
export interface HarnessMeta extends ClientMeta {
  exhausted?: RunNote;
}

export const signedOut = (h: HarnessMeta) => note("clientNotSignedIn", { name: h.name });
export const notInstalled = (h: HarnessMeta) => note("clientNotInstalled", { name: h.name });
export const notServed = (h: HarnessMeta) => note("clientAccountNotServed", { name: h.name });
export const exhausted = (h: HarnessMeta) =>
  h.exhausted ?? note("clientNoCredit", { name: h.name });

/** A client's failure as the person should read it. */
export function clientError(h: HarnessMeta, failure: ClientFailure): Error {
  if (failure.code === "not_installed") {
    return new ModelUnavailableError(notInstalled(h));
  }
  // The client's own words stay in the log: the note sums them up for the person.
  if (failure.raw) {
    console.warn(`[${h.id}] the client failed:`, failure.raw);
  }
  console.warn(`[${h.id}] ${failure.detail.replace(/\s+/g, " ").trim().slice(0, 1500)}`);
  switch (failure.code) {
    case "exhausted":
      return new ModelUnavailableError(exhausted(h));
    case "not_served":
      return new ModelUnavailableError(notServed(h));
    case "signed_out":
      return new ModelUnavailableError(signedOut(h));
    default:
      return failure;
  }
}

/** The failure a client reports, as the person should read it. */
export function failureOf(h: HarnessMeta, detail: string): Error {
  return clientError(h, clientFailure(h, detail));
}

/** How the runtime runs a client as a model. */
export function modelOptions(h: HarnessMeta): ClientModelOptions {
  return {
    workDir: join(env.dataDir, "harness"),
    bridge: openBridge,
    words: CLIENT_WORDS,
    error: (failure) => clientError(h, failure),
  };
}
