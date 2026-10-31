import { AsyncLocalStorage } from "node:async_hooks";
import type { Where, Who } from "./call.js";

/*
 * Who is calling, carried to code the runtime does not call directly: a plugin's tool runs in a
 * step or a Work chat and calls `server.connections.call`, which asks the broker. The runtime
 * sets the caller where it hands the plugin the call; a plugin cannot name another one.
 */

export interface Caller {
  who: Who;
  where: Where;
}

const current = new AsyncLocalStorage<Caller>();

/** Runs `fn` as this caller: every broker call inside carries it. */
export function withCaller<T>(caller: Caller, fn: () => Promise<T>): Promise<T> {
  return current.run(caller, fn);
}

/** The caller the code runs for, or null outside any run or chat (a plugin's own job). */
export function currentCaller(): Caller | null {
  return current.getStore() ?? null;
}
