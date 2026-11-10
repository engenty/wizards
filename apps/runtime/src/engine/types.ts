import { StepError } from "@engenty/wizards-engine/types";
import type { RunNote } from "@engenty/wizards-shared/run";

export type { RunRow } from "./run-store.js";

/** A fixed step's connection isn't signed in, or the service turned the sign-in down. */
export class SignInNeeded extends StepError {
  constructor(
    readonly service: string,
    said: RunNote,
  ) {
    super(said);
  }
}
