import { AsyncLocalStorage } from "node:async_hooks";
import type { Waiting } from "@engenty/local-models/mlx";

/** What a call of a model on this computer is told by whoever makes it. */
export interface LocalCall {
  /** What it waits for before its first word; null once it begins to answer. */
  onWaiting?: (waiting: Waiting | null) => void;
}

const calls = new AsyncLocalStorage<LocalCall>();

/** What the call being made now is told. */
export const localCall = (): LocalCall => calls.getStore() ?? {};

/** Runs `make`, and the calls of a local model in it with `call`. */
export const withLocalCall = <T>(call: LocalCall, make: () => T): T => calls.run(call, make);
