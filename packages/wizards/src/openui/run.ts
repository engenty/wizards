import { ApiError, api, type RunSource, runnerEnv, setChoiceLabels } from "@engenty-wizards/runner";
import type { RunView } from "@engenty-wizards/shared/run";
import { useCallback, useEffect, useMemo, useState } from "react";

/** Two missed pings: the stream is taken for dead. */
const STALE_MS = 45_000;

/**
 * One run, live: the runtime's stream of the whole view, plus the commands a person gives. The
 * same as the studio's `useRun` (apps/web/src/runner/useRun.ts), on the runner's own client, so
 * it talks to whichever runtime `configureWizards` named. `prefill` starts a page's fields with
 * answers the chat already knows; the person still sees and sends the page.
 */
export function useWizardRun(
  runId: string | null,
  prefill: Record<string, unknown> | undefined,
): RunSource {
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
    const { runBase, withBase } = runnerEnv();
    let stopped = false;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let es: EventSource | null = null;
    let lastHeard = Date.now();
    const refresh = async () => {
      try {
        const fresh = await api.get<RunView>(runBase(runId));
        if (!stopped) {
          setView(fresh);
        }
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          stopped = true;
          es?.close();
          setNotFound(true);
        }
      }
    };
    const open = () => {
      clearTimeout(timer);
      es?.close();
      if (stopped) {
        return;
      }
      const stream = new EventSource(withBase(`${runBase(runId)}/stream`), {
        withCredentials: true,
      });
      es = stream;
      lastHeard = Date.now();
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
    const watchdog = setInterval(() => {
      if (!stopped && es && Date.now() - lastHeard > STALE_MS) {
        retry = 0;
        open();
      }
    }, 15_000);
    open();
    return () => {
      stopped = true;
      clearTimeout(timer);
      clearInterval(watchdog);
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
        await api.post(`${runnerEnv().runBase(runId)}/${path}`, body);
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

  // The chat's answers start the page's fields, under what the run already holds.
  const shown = useMemo(() => {
    if (!view || !prefill || view.step?.type !== "page") {
      return view;
    }
    const known = Object.fromEntries(
      view.step.fields.filter((f) => f.id in prefill).map((f) => [f.id, prefill[f.id]]),
    );
    return Object.keys(known).length ? { ...view, prefill: { ...known, ...view.prefill } } : view;
  }, [view, prefill]);

  setChoiceLabels(view?.translation?.labels);
  return {
    view: shown,
    notFound,
    error,
    busy,
    fieldErrors,
    submitPage: (stepId, values) => command(`pages/${stepId}`, { values }),
    accept: (stepId, edits) => command(`reviews/${stepId}`, { type: "accept", edits }),
    regenerate: (stepId, target, note, items) =>
      command(`reviews/${stepId}`, {
        type: "regenerate",
        target,
        note,
        items: items?.length ? items : undefined,
      }),
    back: () => command("back"),
    retry: () => command("retry"),
    translateResult: (stepId) => command("translate-result", { stepId }),
  };
}
