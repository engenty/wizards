import { setChoiceLabels } from "@engenty/wizards-runner";
import { nextInBrowser } from "@engenty/wizards-shared/definition";
import type { RunView } from "@engenty/wizards-shared/run";
import { useCallback, useEffect, useRef, useState } from "react";
import { withBase } from "@/lib/base";
import { ApiError, api } from "../lib/api";
import { answerDevice, offerDevice } from "./phone";

/** Two missed pings: the stream is taken for dead. */
const STALE_MS = 45_000;
/** How often an open page says the run is in view (engine/notices.ts counts on it). */
const SEEN_MS = 30_000;
/** A page not confirmed after this long says it is still being saved. */
const SLOW_MS = 2000;
/** The longest wait between two tries of a page the server cannot be reached for. */
const RETRY_MAX_MS = 10_000;

/** A page on its way to the server: one at a time, in order, with its number (`seq`). */
interface InFlight {
  stepId: string;
  values: Record<string, unknown>;
  seq: number;
  settle: (ok: boolean) => void;
}

/** Answers the server cannot be reached for right now: tried again, not refused. */
const unreachable = (err: unknown) =>
  err instanceof ApiError &&
  (err.status === 0 || err.status === 502 || err.status === 503 || err.status === 504);

/**
 * The page the browser shows ahead of the server (`RunView.ahead`): the next plain page, with the
 * answers so far. No result and no AI step is ever shown this way.
 */
function aheadView(shown: RunView, next: string, values: Record<string, unknown>): RunView {
  const entry = shown.ahead?.[next];
  if (!entry) {
    return shown;
  }
  return {
    ...shown,
    step: entry.step,
    values,
    unsent: undefined,
    known: values,
    prefill: {},
    pageData: undefined,
    options: undefined,
    cards: undefined,
    decidedFields: undefined,
    closed: {},
    progress: entry.progress,
    // Back while pages are on their way would cross them.
    canBack: false,
    answered: shown.step ? [...shown.answered, shown.step] : shown.answered,
    ask: null,
    question: null,
    shown: [],
    lists: [],
    error: null,
  };
}

/** Live view of one run: a server-sent stream of the whole view, plus the commands a person can give. */
export function useRun(runId: string | null) {
  const [view, setView] = useState<RunView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  // The page shown ahead of the server, while pages are on their way; null: the server's view.
  const [local, setLocal] = useState<RunView | null>(null);
  // A page not confirmed for a while ("slow"), or the server out of reach ("offline").
  const [saving, setSaving] = useState<"slow" | "offline" | null>(null);
  const queue = useRef<InFlight[]>([]);
  // This tab, for the server: a retry of a page is this tab's, another tab's answer is not.
  const tab = useRef(Math.random().toString(36).slice(2, 12));
  const pumping = useRef(false);
  // The `rev` of the last page the server confirmed: a view older than it is late.
  const confirmedRev = useRef(0);
  const lastSeq = useRef(0);
  // The server's latest view, kept apart while pages are on their way.
  const server = useRef<RunView | null>(null);
  /** A view from the server: dropped when late, held while pages are on their way, else shown. */
  const receive = useRef((fresh: RunView) => {
    if (fresh.rev < confirmedRev.current) {
      return;
    }
    server.current = fresh;
    if (queue.current.length) {
      return;
    }
    setLocal(null);
    setView(fresh);
  });

  useEffect(() => {
    setView(null);
    setLocal(null);
    setNotFound(false);
    queue.current = [];
    confirmedRev.current = 0;
    lastSeq.current = 0;
    server.current = null;
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
          receive.current(fresh);
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
        receive.current(JSON.parse((e as MessageEvent).data));
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
    // Only while in view: a tab in the background is nobody looking, and they should be told.
    const seen = () => {
      if (!stopped && document.visibilityState === "visible") {
        void api.post(`/api/runs/${runId}/seen`).catch(() => undefined);
      }
    };
    const seenTimer = setInterval(seen, SEEN_MS);
    seen();
    open();
    document.addEventListener("visibilitychange", seen);
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("pageshow", wake);
    window.addEventListener("online", wake);
    return () => {
      stopped = true;
      clearTimeout(timer);
      clearInterval(watchdog);
      clearInterval(seenTimer);
      document.removeEventListener("visibilitychange", seen);
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

  /** Sends one page until the server confirms or refuses it; false: refused. */
  const send = useCallback(
    async (item: InFlight): Promise<boolean> => {
      const slow = setTimeout(() => setSaving((s) => s ?? "slow"), SLOW_MS);
      let delay = 1000;
      try {
        for (;;) {
          try {
            const res = await api.post<{ rev?: number }>(
              `/api/runs/${runId}/pages/${item.stepId}`,
              {
                values: item.values,
                seq: item.seq,
                tab: tab.current,
              },
            );
            confirmedRev.current = Math.max(confirmedRev.current, res.rev ?? 0);
            setSaving((s) => (s === "offline" ? "slow" : s));
            return true;
          } catch (err) {
            if (unreachable(err)) {
              setSaving("offline");
              await new Promise((r) => setTimeout(r, delay));
              delay = Math.min(delay * 2, RETRY_MAX_MS);
              continue;
            }
            if (err instanceof ApiError && err.status === 422 && Array.isArray(err.body?.fields)) {
              setFieldErrors(
                Object.fromEntries(
                  err.body.fields.map((f: { field: string; message: string }) => [
                    f.field,
                    f.message,
                  ]),
                ),
              );
            }
            setError((err as Error).message);
            // The server's page wins; what was typed for it stays, and that page starts from it.
            await api
              .put(`/api/runs/${runId}/pages/${item.stepId}/unsent`, { values: item.values })
              .catch(() => undefined);
            const fresh = await api.get<RunView>(`/api/runs/${runId}`).catch(() => null);
            if (fresh) {
              server.current = fresh;
            }
            return false;
          }
        }
      } finally {
        clearTimeout(slow);
      }
    },
    [runId],
  );

  /** Sends what is on its way, one page at a time; when all is in, the server's view shows. */
  const pump = useCallback(async () => {
    if (pumping.current) {
      return;
    }
    pumping.current = true;
    try {
      while (queue.current.length) {
        const item = queue.current[0];
        if (!(await send(item))) {
          // Refused: what came after it is refused with it.
          const rest = queue.current;
          queue.current = [];
          for (const later of rest) {
            later.settle(false);
          }
          break;
        }
        queue.current.shift();
        item.settle(true);
      }
    } finally {
      pumping.current = false;
    }
    setSaving(null);
    const fresh = server.current;
    if (fresh && fresh.rev >= confirmedRev.current) {
      setLocal(null);
      setView(fresh);
    }
  }, [send]);

  /**
   * A page answered: the next one shows at once when `ahead` says which (the answers go on in the
   * background); otherwise the person waits for the server, as before.
   */
  const submitPage = useCallback(
    async (stepId: string, values: Record<string, unknown>) => {
      const shown = local ?? view;
      if (!runId || !shown) {
        return false;
      }
      const merged = { ...shown.values, ...values };
      const next =
        shown.ahead && shown.status === "waiting_input"
          ? nextInBrowser(shown.ahead, stepId, merged)
          : null;
      lastSeq.current =
        Math.max(lastSeq.current, server.current?.pagesSent ?? shown.pagesSent ?? 0) + 1;
      let settle: (ok: boolean) => void = () => undefined;
      const confirmed = new Promise<boolean>((resolve) => {
        settle = resolve;
      });
      queue.current.push({ stepId, values, seq: lastSeq.current, settle });
      setError(null);
      setFieldErrors({});
      if (next) {
        setLocal(aheadView(shown, next, merged));
        void pump();
        return true;
      }
      setBusy(true);
      void pump();
      const ok = await confirmed;
      setBusy(false);
      return ok;
    },
    [runId, local, view, pump],
  );

  // A translated run's choices show their labels, in the chat as on the page.
  setChoiceLabels(view?.translation?.labels);
  return {
    view: local ?? view,
    notFound,
    error,
    busy,
    fieldErrors,
    saving,
    submitPage,
    accept: (
      stepId: string,
      edits?: Record<string, string | Record<string, unknown>>,
      note?: string,
    ) => command(`reviews/${stepId}`, { type: "accept", edits, note }),
    decline: (stepId: string, note?: string) =>
      command(`reviews/${stepId}`, { type: "decline", note }),
    regenerate: (stepId: string, target: string, note: string, items?: number[]) =>
      command(`reviews/${stepId}`, {
        type: "regenerate",
        target,
        note,
        items: items?.length ? items : undefined,
      }),
    back: () => command("back"),
    withdraw: () => command("cancel"),
    retry: () => command("retry"),
    translateResult: (stepId: string) => command("translate-result", { stepId }),
    /** The language the run is read in from now on; null: the wizard's own. */
    setLang: (lang: string | null) => command("lang", { lang }),
  };
}
