import { setChoiceLabels } from "@engenty-wizards/runner";
import type { RunView } from "@engenty-wizards/shared/run";
import { useCallback, useEffect, useState } from "react";
import { withBase } from "@/lib/base";
import { ApiError, api } from "../lib/api";
import { answerDevice, offerDevice } from "./phone";

/** Two missed pings: the stream is taken for dead. */
const STALE_MS = 45_000;

/** Live view of one run: a server-sent stream of the whole view, plus the commands a person can give. */
export function useRun(runId: string | null) {
  const [view, setView] = useState<RunView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    setView(null);
    setNotFound(false);
    if (!runId) {
      return;
    }
    let stopped = false;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let es: EventSource | null = null;
    // The server sends the view or a ping at least every 20 s; silence means a dead stream.
    let lastHeard = Date.now();
    const gone = () => {
      stopped = true;
      es?.close();
      setNotFound(true);
    };
    const refresh = async () => {
      try {
        const fresh = await api.get<RunView>(`/api/runs/${runId}`);
        if (!stopped) {
          setView(fresh);
        }
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          gone();
        }
      }
    };
    const open = () => {
      clearTimeout(timer);
      es?.close();
      if (stopped) {
        return;
      }
      const stream = new EventSource(withBase(`/api/runs/${runId}/stream`), {
        withCredentials: true,
      });
      es = stream;
      lastHeard = Date.now();
      // The phone around the runner may think for the run: said on every connect.
      offerDevice(runId);
      stream.addEventListener("device", (e) => {
        lastHeard = Date.now();
        void answerDevice(runId, JSON.parse((e as MessageEvent).data));
      });
      stream.addEventListener("view", (e) => {
        retry = 0;
        lastHeard = Date.now();
        setView(JSON.parse((e as MessageEvent).data));
      });
      stream.addEventListener("ping", () => {
        lastHeard = Date.now();
      });
      stream.onerror = () => {
        stream.close();
        if (stopped || es !== stream) {
          return;
        }
        es = null;
        void refresh();
        retry = Math.min(retry + 1, 6);
        timer = setTimeout(open, 500 * 2 ** retry);
      };
    };
    // A phone that slept, a tab that was in the background, a train in a tunnel: the stream can
    // be dead without an error. Back in view, the run is read afresh and a stale stream reopened.
    const wake = () => {
      if (stopped || document.visibilityState !== "visible") {
        return;
      }
      if (!es || es.readyState === EventSource.CLOSED || Date.now() - lastHeard > STALE_MS) {
        retry = 0;
        open();
      } else {
        void refresh();
      }
    };
    // In the background too: a done run still has to reach the page for its notification.
    const watchdog = setInterval(() => {
      if (!stopped && es && Date.now() - lastHeard > STALE_MS) {
        retry = 0;
        open();
      }
    }, 15_000);
    open();
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("pageshow", wake);
    window.addEventListener("online", wake);
    return () => {
      stopped = true;
      clearTimeout(timer);
      clearInterval(watchdog);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("pageshow", wake);
      window.removeEventListener("online", wake);
      es?.close();
    };
  }, [runId]);

  const command = useCallback(
    async (path: string, body?: unknown) => {
      if (!runId) {
        return false;
      }
      setBusy(true);
      setError(null);
      setFieldErrors({});
      try {
        await api.post(`/api/runs/${runId}/${path}`, body);
        return true;
      } catch (err) {
        if (err instanceof ApiError && err.status === 422 && Array.isArray(err.body?.fields)) {
          setFieldErrors(
            Object.fromEntries(
              err.body.fields.map((f: { field: string; message: string }) => [f.field, f.message]),
            ),
          );
        }
        setError((err as Error).message);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [runId],
  );

  // A translated run's choices show their labels, in the chat as on the page.
  setChoiceLabels(view?.translation?.labels);
  return {
    view,
    notFound,
    error,
    busy,
    fieldErrors,
    submitPage: (stepId: string, values: Record<string, unknown>) =>
      command(`pages/${stepId}`, { values }),
    accept: (stepId: string, edits?: Record<string, string | Record<string, unknown>>) =>
      command(`reviews/${stepId}`, { type: "accept", edits }),
    regenerate: (stepId: string, target: string, note: string, items?: number[]) =>
      command(`reviews/${stepId}`, {
        type: "regenerate",
        target,
        note,
        items: items?.length ? items : undefined,
      }),
    back: () => command("back"),
    retry: () => command("retry"),
    translateResult: (stepId: string) => command("translate-result", { stepId }),
    /** The language the run is read in from now on; null: the wizard's own. */
    setLang: (lang: string | null) => command("lang", { lang }),
  };
}
