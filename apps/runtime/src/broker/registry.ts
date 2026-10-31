import type { ActionKind } from "./call.js";

/*
 * Every tool and share target that reaches outside says so here: which connection, which action,
 * what kind. The walk test (`test/broker-walk.test.ts`) fails on a file that reaches outside
 * without going through `brokerCall` and registering what it reaches.
 */

export interface OutsideReach {
  /** The connection's id, or what kind of connection: "mail", "share:slack", a wizard's connection. */
  connection: string;
  action: string;
  kind: ActionKind;
}

const reaches = new Map<string, OutsideReach[]>();

/** A tool or target (by its id) reaches outside through these actions. Registering twice is fine. */
export function reachesOutside(id: string, list: OutsideReach | OutsideReach[]): void {
  reaches.set(id, Array.isArray(list) ? list : [list]);
}

/** What is registered, for tests and the Protokoll page later. */
export function outsideReaches(): ReadonlyMap<string, OutsideReach[]> {
  return reaches;
}
