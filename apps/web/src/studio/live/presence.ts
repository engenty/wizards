import type { PresenceEntry, PresenceKind } from "@engenty/wizards-shared/live";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { api } from "../../lib/api";
import { withBase } from "../../lib/base";
import { useFeature } from "../../lib/features";
import { keys } from "../../lib/keys";
import type { LiveBinding } from "./patch";

/**
 * Who is in a wizard, page or table (docs/plans/live-changes.md, 8): people in an editor, the
 * studio assistant, MCP clients. A signal, never a lock. This tab reports itself while an editor
 * is open, and hears the others over the live stream.
 */

/** One id per tab: the same person in two tabs is two entries. */
export const TAB = Math.random().toString(36).slice(2, 10);

export const presenceLive: LiveBinding[] = [
  {
    id: "presence",
    kinds: ["presence"],
    patch: (c, { qc }) => {
      if (!c.parent) {
        return;
      }
      const item = c.item.slice(c.parent.length + 1);
      const now = (c.view as PresenceEntry[] | undefined) ?? [];
      qc.setQueryData(keys.presence(c.parent, item), now);
      qc.setQueryData<Record<string, PresenceEntry[]>>(keys.presentItems(c.parent), (all) => {
        if (!all) {
          return all;
        }
        const next = { ...all };
        if (now.length) {
          next[item] = now;
        } else {
          delete next[item];
        }
        return next;
      });
    },
    fallback: (c) =>
      c.parent
        ? [keys.presence(c.parent, c.item.slice(c.parent.length + 1)), keys.presentItems(c.parent)]
        : [],
  },
];

/** Who else is in the item: not this person, in this tab or another one. */
export function usePresence(kind: PresenceKind, item: string | undefined, me?: string) {
  const live = useFeature("liveChanges");
  const query = useQuery({
    queryKey: keys.presence(kind, item ?? ""),
    queryFn: () => api.get<PresenceEntry[]>(`/api/studio/presence/${kind}/${item}`),
    enabled: live && Boolean(item),
    // The stream keeps it fresh; this is for when it is down.
    refetchInterval: 60_000,
  });
  return (query.data ?? []).filter((e) => e.who !== me);
}

/** Who is in each item of a kind: a dot on a card while someone works in it. */
export function usePresentItems(kind: PresenceKind) {
  const live = useFeature("liveChanges");
  return useQuery({
    queryKey: keys.presentItems(kind),
    queryFn: () => api.get<Record<string, PresenceEntry[]>>(`/api/studio/presence/${kind}`),
    enabled: live,
    refetchInterval: 60_000,
  }).data;
}

const HEARTBEAT_MS = 20_000;

/**
 * This tab, in the item: reported when it opens, when the state or place changes (a second
 * later at most) and every 20 s; gone when the editor closes or the tab does.
 */
export function useReportPresence(
  kind: PresenceKind,
  item: string | undefined,
  now: { state: "viewing" | "editing"; place?: string | null; placeLabel?: string | null },
) {
  const live = useFeature("liveChanges");
  const latest = useRef(now);
  latest.current = now;
  const key = `${now.state}|${now.place ?? ""}`;

  useEffect(() => {
    if (!live || !item) {
      return;
    }
    const send = () =>
      api
        .put("/api/studio/presence", { kind, item, tab: TAB, ...latest.current })
        .catch(() => undefined);
    void send();
    const beat = setInterval(() => void send(), HEARTBEAT_MS);
    const gone = () =>
      navigator.sendBeacon?.(
        withBase("/api/studio/presence/leave"),
        new Blob([JSON.stringify({ kind, item, tab: TAB })], { type: "text/plain" }),
      );
    window.addEventListener("pagehide", gone);
    return () => {
      clearInterval(beat);
      window.removeEventListener("pagehide", gone);
      void api.post("/api/studio/presence/leave", { kind, item, tab: TAB }).catch(() => undefined);
    };
  }, [live, kind, item]);

  // A new state or place goes out within a second; the heartbeat carries the rest.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is the state and place that changed.
  useEffect(() => {
    if (!live || !item) {
      return;
    }
    const timer = setTimeout(
      () =>
        void api
          .put("/api/studio/presence", { kind, item, tab: TAB, ...latest.current })
          .catch(() => undefined),
      1000,
    );
    return () => clearTimeout(timer);
  }, [live, kind, item, key]);
}
