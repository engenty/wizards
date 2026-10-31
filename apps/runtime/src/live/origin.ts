import { subscribe } from "./hub.js";

/**
 * Which install wrote what (docs/plans/live-changes.md, 7): the feed numbers a push of an install
 * wrote. The cloud's live call leaves those out for that install, else every push would come
 * back to it as a pull of nothing. A change by someone else, even of the same item, has its own
 * number and goes through. Kept in memory for a minute.
 */
const KEEP_MS = 60_000;
const pushes = new Map<string, { install: string; from: number; to: number; at: number }[]>();

/**
 * A push of `install` starts writing after the feed's number `from`. Until `done` gives its last
 * number, everything after `from` counts as the push's: a tick in between can't send it back.
 */
export function notePush(tenant: string, install: string | null | undefined, from: number) {
  if (!install) {
    return { done: (_to: number) => undefined };
  }
  const now = Date.now();
  const entry = { install, from, to: Number.POSITIVE_INFINITY, at: now };
  const kept = (pushes.get(tenant) ?? []).filter((p) => now - p.at < KEEP_MS);
  kept.push(entry);
  pushes.set(tenant, kept);
  return {
    done: (to: number) => {
      entry.to = to;
    },
  };
}

/** Whether `install` itself wrote the change numbered `seq`. */
export function pushedBy(tenant: string, install: string, seq: number): boolean {
  return (pushes.get(tenant) ?? []).some(
    (p) => p.install === install && seq > p.from && seq <= p.to,
  );
}

/**
 * The cloud's live call for one install: the spaces with changes, without what the install
 * pushed itself. `hear` gets hello, reset and changes; the answer stops it.
 */
export async function followFor(
  tenantId: string,
  install: string,
  since: number | null,
  hear: (
    e:
      | { event: "hello" | "reset"; seq: number }
      | { event: "changes"; seq: number; spaces: string[] },
  ) => void,
): Promise<() => void> {
  return subscribe(tenantId, since, (e) => {
    if (e.event === "changes") {
      const spaces = new Set<string>();
      for (const x of e.items) {
        if (x.spaceId && !(x.seq !== undefined && pushedBy(tenantId, install, x.seq))) {
          spaces.add(x.spaceId);
        }
      }
      // Its own push only: the number moves on, nothing to pull.
      hear({ event: "changes", seq: e.seq, spaces: [...spaces] });
    } else if (e.event === "hello" || e.event === "reset") {
      hear(e);
    }
  });
}
