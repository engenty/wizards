import {
  ApiError,
  api,
  configureRunner,
  type Lang,
  RunnerBody,
  type RunSource,
} from "@engenty/wizards-runner";
import type { RunView } from "@engenty/wizards-shared/run";
import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

/**
 * The run page of a wizard Worker: the runner the studio and the WordPress plugin draw runs with,
 * over this Worker's page routes. A new run starts on `/`, and the page moves to `/r/<id>`.
 */
configureRunner({
  lang: (document.documentElement.lang || "en") as Lang,
  runBase: (runId) => `/runs/${runId}/page`,
  withBase: (path) => path,
  asset: (path) => `/${path}`,
  Mascot: () => null,
  standalone: true,
});

const ENDED = new Set(["done", "failed", "cancelled"]);

/** One run as the runner drives it: its view, read again while it works or sleeps. */
function useWorkerRun(runId: string): RunSource {
  const [view, setView] = useState<RunView | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const base = `/runs/${runId}/page`;

  const refresh = useCallback(async () => {
    try {
      setView(await api.get<RunView>(base));
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setNotFound(true);
    }
  }, [base]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  // A run that waits for a time or a signal goes on by itself: the page looks again now and then.
  useEffect(() => {
    if (!view || ENDED.has(view.status) || view.status === "waiting_input") return;
    const timer = setTimeout(refresh, 2000);
    return () => clearTimeout(timer);
  }, [view, refresh]);

  const command = async (path: string, body?: unknown) => {
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      setView(await api.post<RunView>(`${base}/${path}`, body ?? {}));
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 422 && Array.isArray(err.body?.fields))
        setFieldErrors(
          Object.fromEntries(
            err.body.fields.map((f: { field: string; message: string }) => [f.field, f.message]),
          ),
        );
      setError((err as Error).message);
      await refresh();
      return false;
    } finally {
      setBusy(false);
    }
  };

  return {
    view,
    notFound,
    error,
    busy,
    fieldErrors,
    submitPage: (stepId, values) => command(`pages/${stepId}`, { values }),
    accept: (stepId, edits, note) => command(`reviews/${stepId}`, { type: "accept", edits, note }),
    decline: (stepId, note) => command(`reviews/${stepId}`, { type: "decline", note }),
    regenerate: (stepId, target, note) =>
      command(`reviews/${stepId}`, { type: "regenerate", target, note }),
    back: () => command("back"),
    retry: () => command("retry"),
  };
}

function Run({ runId }: { runId: string }) {
  const run = useWorkerRun(runId);
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "24px 16px" }}>
      <RunnerBody run={run} onRestart={() => location.assign("/")} />
    </main>
  );
}

function App() {
  const [runId, setRunId] = useState(location.pathname.match(/^\/r\/([^/]+)/)?.[1] ?? null);
  useEffect(() => {
    if (runId) return;
    void api.post<{ id: string }>("/runs", {}).then(({ id }) => {
      history.replaceState(null, "", `/r/${id}`);
      setRunId(id);
    });
  }, [runId]);
  return runId ? <Run runId={runId} /> : null;
}

createRoot(document.getElementById("page") as HTMLElement).render(<App />);
