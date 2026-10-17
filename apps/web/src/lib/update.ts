import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "./api";
import { t } from "./i18n";

/**
 * A runtime that runs alone: the release it is, the newest one out, and the update it can run
 * itself (an install made by install.sh). The banner at the top and the About dialog both read
 * it; the runtime asks GitHub at most once an hour, and so does the page ask the runtime.
 */

export interface UpdateStatus {
  current: string;
  /** The newest release, or null when it is not known (no network, or the check is off). */
  latest: string | null;
  newer: boolean;
  /** How this copy got here: only an install made by install.sh can update itself. */
  kind: "script" | "checkout" | "npm";
  /** Where the release is described. */
  url: string | null;
  canApply: boolean;
  /** After an update the runtime starts the new version by itself; else the person restarts it. */
  restarts: boolean;
  applying: "idle" | "running" | "done" | "failed";
  /** When GitHub was last asked, found or not. */
  checkedAt: number | null;
  /** False where the runtime was told not to ask. */
  enabled: boolean;
  /** Downloaded beside this version; used from the next start. */
  pending: { version: string; notes: string } | null;
  /** The update this version came with, for two weeks after it. */
  updated: { from: string; to: string; at: string; notes: string } | null;
}

const KEY = ["update"];
const HOUR = 60 * 60_000;

export function useUpdate(enabled = true) {
  const qc = useQueryClient();
  const [waiting, setWaiting] = useState<string | null>(null);
  const status = useQuery({
    queryKey: KEY,
    queryFn: () => api.get<UpdateStatus>("/api/studio/update"),
    staleTime: HOUR,
    refetchInterval: HOUR,
    retry: false,
    enabled,
  });
  /** Asks GitHub now, whatever the hour. */
  const check = useMutation({
    mutationFn: () => api.get<UpdateStatus>("/api/studio/update?fresh=1"),
    onSuccess: (next) => qc.setQueryData(KEY, next),
  });
  const apply = useMutation({
    mutationFn: () => api.post<UpdateStatus>("/api/studio/update"),
    onSuccess: (next) => qc.setQueryData(KEY, next),
  });
  const data = status.data;
  const latest = data?.latest ?? null;
  const restarting = data?.restarts && (data.applying === "running" || data.applying === "done");
  const from = data?.current;
  // While it installs and restarts, ask until another version answers, then load it.
  useEffect(() => {
    if (!(restarting || data?.applying === "running") || !latest) {
      return;
    }
    const timer = setInterval(async () => {
      try {
        const next = await api.get<UpdateStatus>("/api/studio/update");
        if (next.current !== from) {
          window.location.reload();
          return;
        }
        qc.setQueryData(KEY, next);
        if (next.applying === "done" && next.restarts) {
          setWaiting(latest);
        }
      } catch {
        // Down between the old version and the new one.
        setWaiting(latest);
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [restarting, data?.applying, latest, from, qc]);

  const busy = data?.applying === "running" || waiting !== null;
  /** What the update is doing, once it was started; null while nothing runs. */
  const progress =
    !data || !latest
      ? null
      : waiting !== null
        ? t("about.update.restarting", { v: latest })
        : data.applying === "running"
          ? t("about.update.installing", { v: latest })
          : data.applying === "done"
            ? t("about.update.done", { v: latest })
            : data.applying === "failed"
              ? t("about.update.failed")
              : null;
  return { status, data, latest, check, apply, busy, progress };
}
