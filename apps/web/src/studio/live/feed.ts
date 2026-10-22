import type { LiveChange } from "@engenty/wizards-shared/live";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { withBase } from "../../lib/base";
import { useFeature } from "../../lib/features";
import { keys } from "../../lib/keys";
import { createPatcher, refetchShown } from "./patch";

/**
 * The studio's live stream (docs/plans/live-changes.md, 4): one per browser, not per tab. The
 * tab that holds the lock `wz-live:<tenant>` opens `GET /api/studio/live` and passes every event
 * on over a BroadcastChannel; the others listen. When that tab closes, the next one takes the
 * lock and goes on from the last number it heard.
 */

type Heard =
  | { event: "hello" | "reset"; seq: number }
  | { event: "changes"; seq: number; items: LiveChange[] }
  | { event: "sync" }
  | { event: "ping" };

const COALESCE_MS = 100;
/** No event (pings come every 20 s) this long: the stream is dead, open it again. */
const WATCHDOG_MS = 45_000;
const BUSY_WAIT_MS = 30_000;

export function useLiveFeed(tenantId: string) {
  const on = useFeature("liveChanges");
  const qc = useQueryClient();
  useEffect(() => {
    if (!on) {
      console.info("[live] off: the liveChanges switch is off");
      return;
    }
    return startLiveFeed(qc, tenantId);
  }, [on, qc, tenantId]);
}

export function startLiveFeed(qc: QueryClient, tenantId: string): () => void {
  const name = `wz-live:${tenantId}`;
  const stop = new AbortController();
  const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel(name) : null;
  const apply = createPatcher(qc);
  let seq: number | null = null;
  let pending = new Map<string, LiveChange>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    timer = null;
    const batch = [...pending.values()];
    pending = new Map();
    void apply(batch);
  };

  const hear = (e: Heard) => {
    if ("seq" in e) {
      seq = e.seq;
    }
    if (e.event === "changes") {
      for (const item of e.items) {
        const key = `${item.kind}|${item.item}`;
        pending.delete(key);
        pending.set(key, item);
      }
      timer ??= setTimeout(flush, COALESCE_MS);
    } else if (e.event === "reset") {
      pending.clear();
      refetchShown(qc);
    } else if (e.event === "sync") {
      void qc.invalidateQueries({ queryKey: keys.cloudSync() });
    }
  };

  if (channel) {
    channel.onmessage = (m: MessageEvent<Heard>) => hear(m.data);
  }

  const lead = async () => {
    await follow(
      () => seq,
      (e) => {
        hear(e);
        channel?.postMessage(e);
      },
      stop.signal,
    );
  };

  if (typeof navigator !== "undefined" && navigator.locks) {
    void navigator.locks.request(name, { signal: stop.signal }, lead).catch((err: unknown) => {
      if (!stop.signal.aborted) {
        console.warn("[live]", err);
      }
    });
  } else {
    // No Web Locks: every tab streams on its own.
    void lead();
  }

  return () => {
    stop.abort();
    channel?.close();
    if (timer) {
      clearTimeout(timer);
    }
  };
}

/** Holds the stream open until `signal` ends it, reconnecting after drops. */
async function follow(
  since: () => number | null,
  hear: (e: Heard) => void,
  signal: AbortSignal,
): Promise<void> {
  let wait = 1000;
  while (!signal.aborted) {
    const once = new AbortController();
    const end = () => once.abort();
    signal.addEventListener("abort", end, { once: true });
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    const alive = () => {
      if (watchdog) {
        clearTimeout(watchdog);
      }
      watchdog = setTimeout(() => once.abort(), WATCHDOG_MS);
    };
    try {
      const last = since();
      const res = await fetch(withBase("/api/studio/live"), {
        credentials: "include",
        headers: {
          accept: "text/event-stream",
          "x-wizards-client": "web",
          ...(last === null ? {} : { "last-event-id": String(last) }),
        },
        signal: once.signal,
      });
      if (res.status === 404) {
        console.info("[live] off: this runtime has no live stream");
        return;
      }
      if (res.status === 429) {
        console.info("[live] waiting: too many studio windows are open");
        await pause(BUSY_WAIT_MS, signal);
        continue;
      }
      if (!res.ok || !res.body) {
        throw new Error(`live stream answered ${res.status}`);
      }
      wait = 1000;
      alive();
      await readEvents(res.body, (e) => {
        alive();
        hear(e);
      });
    } catch (err) {
      if (signal.aborted) {
        return;
      }
      if (!once.signal.aborted) {
        console.info("[live] dropped, reconnecting:", (err as Error).message);
      }
    } finally {
      if (watchdog) {
        clearTimeout(watchdog);
      }
      signal.removeEventListener("abort", end);
    }
    await pause(wait, signal);
    wait = Math.min(wait * 2, 30_000);
  }
}

/** Waits `ms`, cut short when the page comes back into view or goes online again. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((done) => {
    const finish = () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", seen);
      window.removeEventListener("online", finish);
      signal.removeEventListener("abort", finish);
      done();
    };
    const seen = () => {
      if (document.visibilityState === "visible") {
        finish();
      }
    };
    const timer = setTimeout(finish, ms);
    document.addEventListener("visibilitychange", seen);
    window.addEventListener("online", finish);
    signal.addEventListener("abort", finish);
  });
}

async function readEvents(body: ReadableStream<Uint8Array>, hear: (e: Heard) => void) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return;
    }
    buffer += decoder.decode(value, { stream: true });
    let cut = buffer.indexOf("\n\n");
    while (cut >= 0) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      let event = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) {
          event = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          data += line.slice(5).replace(/^ /, "");
        }
      }
      hear({ event, ...(data ? JSON.parse(data) : {}) } as Heard);
      cut = buffer.indexOf("\n\n");
    }
  }
}
