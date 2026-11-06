import { signalNameOpen } from "@engenty/wizards-shared/definition";
import type { RunTimeline as Timeline } from "@engenty/wizards-shared/run";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Hourglass, Play, Radio, Square, Users } from "lucide-react";
import { useEffect } from "react";
import { api } from "../../lib/api";
import { lang, t } from "../../lib/i18n";
import { Button } from "../../ui";
import { askConfirm } from "../../ui/confirm";
import { waitSummary } from "./meta";

const longTime = (at: string) =>
  new Intl.DateTimeFormat(lang, {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(at));

/** Whether a run stands still now, for a time, for a signal or for a person. */
export const waitsNow = (status: string | null | undefined) =>
  status === "sleeping" || status === "waiting_signal" || status === "waiting_input";

type Command = "wake-now" | "stop";

/** What can be done with a run that waits. A refusal means it moved on: `error` says so. */
export function useRunActions(runId: string, wizardId: string, refetch: () => unknown) {
  const queryClient = useQueryClient();
  const settled = () => {
    void refetch();
    void queryClient.invalidateQueries({ queryKey: ["runs", wizardId] });
  };
  const command = useMutation({
    mutationFn: (which: Command) => api.post(`/api/runs/${runId}/${which}`),
    onSettled: settled,
  });
  const testEvent = useMutation({
    mutationFn: () => api.post(`/api/studio/wizards/${wizardId}/runs/${runId}/test-signal`),
    onSettled: settled,
  });
  return { command, testEvent, error: command.error ?? testEvent.error };
}

export type RunActions = ReturnType<typeof useRunActions>;

/** What a run that waits offers, and what it says while it does. */
export function WaitBanner({
  run,
  actions,
  hint,
}: {
  run: Timeline;
  actions: RunActions;
  /** Said in place of what waiting costs. */
  hint?: string;
}) {
  const { command, testEvent } = actions;
  const busy = command.isPending || testEvent.isPending;
  const sleeping = run.status === "sleeping";
  const listening = run.status === "waiting_signal";
  const stop = async () => {
    const yes = await askConfirm(t("runs.stopAsk"), {
      detail: t("runs.stopDetail"),
      action: t("runs.stop"),
    });
    if (yes) {
      command.mutate("stop");
    }
  };
  const canTest = listening && run.mode === "test" && run.canAct;
  return (
    <div className="flex flex-wrap items-start gap-3 rounded-xl bg-paper-2 p-3">
      <Hourglass className="mt-0.5 size-4 shrink-0 text-ink-3" />
      <div className="min-w-56 flex-1">
        <div className="font-medium text-[0.875rem] first-letter:uppercase">
          {run.pause === "credits"
            ? t("runs.status.waitsCredits")
            : run.pause === "sign_in"
              ? t("runs.status.waitsSignIn")
              : sleeping && run.wakeAt
                ? t("runs.waitsUntil", { time: longTime(run.wakeAt) })
                : listening
                  ? run.wakeAt
                    ? t("runs.status.waiting_signalUntil", { time: longTime(run.wakeAt) })
                    : t("runs.status.waiting_signal")
                  : run.wakeAt
                    ? t("runs.waitsForPersonUntil", {
                        step: run.stepTitle ?? "",
                        time: longTime(run.wakeAt),
                      })
                    : t("runs.waitsForPerson", { step: run.stepTitle ?? "" })}
        </div>
        {run.signal ? (
          <div className="text-[0.8125rem] text-ink-2">
            {waitSummary({
              id: "",
              title: "",
              type: "wait",
              signal: { name: run.signal.name, key: run.signal.key },
            })}
            {signalNameOpen(run.signal.name)
              ? ` · ${t("runs.eventName", { name: run.signal.name })}`
              : ""}
          </div>
        ) : null}
        {sleeping || listening ? (
          <div className="text-[0.8125rem] text-ink-2">{hint ?? t("runs.waitsHint")}</div>
        ) : null}
        {canTest && run.wakeAt ? (
          <div className="text-[0.8125rem] text-ink-2">{t("runs.wakeNowDeadline")}</div>
        ) : null}
      </div>
      {run.canAct ? (
        <div className="flex basis-full flex-wrap items-center gap-2">
          {canTest ? (
            <Button
              variant="secondary"
              size="sm"
              busy={testEvent.isPending}
              disabled={busy}
              onClick={() => testEvent.mutate()}
            >
              <Radio className="size-3.5" />
              {t("runs.testSignal")}
            </Button>
          ) : null}
          {run.wakeAt ? (
            <Button
              variant="secondary"
              size="sm"
              busy={command.isPending && command.variables === "wake-now"}
              disabled={busy}
              onClick={() => command.mutate("wake-now")}
            >
              <Play className="size-3.5" />
              {t("runs.wakeNow")}
            </Button>
          ) : null}
          <span className="flex-1" />
          <Button
            variant="danger"
            size="sm"
            busy={command.isPending && command.variables === "stop"}
            disabled={busy}
            onClick={() => void stop()}
          >
            <Square className="size-3.5" />
            {t("runs.stop")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Under a test run in the preview, while it stands still with something to try: its buttons, so
 * whoever tests need not go to the runs panel. A page with no deadline and nobody else to answer it
 * says nothing: filling it in is all there is.
 */
export function TestRunControls({
  runId,
  wizardId,
  status,
}: {
  runId: string;
  wizardId: string;
  /** What the run on screen says of itself: it moves on without this asking. */
  status: string | null;
}) {
  const waits = waitsNow(status);
  const query = useQuery({
    queryKey: ["run-timeline", runId],
    queryFn: () => api.get<Timeline>(`/api/runs/${runId}/timeline`),
    enabled: waits,
    refetchInterval: waits ? 5000 : false,
  });
  const { refetch } = query;
  // A step further on, the same status can mean another wait.
  useEffect(() => {
    if (status && waitsNow(status)) {
      void refetch();
    }
  }, [status, refetch]);
  const actions = useRunActions(runId, wizardId, refetch);
  const run = query.data;
  if (!(waits && run && waitsNow(run.status))) {
    return null;
  }
  const worthSaying = run.status !== "waiting_input" || run.teamStep || Boolean(run.wakeAt);
  if (!worthSaying) {
    return null;
  }
  return (
    <div className="grid gap-2 border-border-soft border-t px-3 py-2">
      {run.teamStep ? (
        <p className="flex items-center gap-2 text-[0.8125rem] text-ink-2">
          <Users className="size-3.5 shrink-0 text-ink-3" />
          {t("runs.teamNote")}
        </p>
      ) : null}
      {run.status !== "waiting_input" || run.wakeAt ? (
        <WaitBanner run={run} actions={actions} hint={t("runs.testNoWait")} />
      ) : null}
      {actions.error ? (
        <p className="px-1 text-[0.8125rem] text-rose">{actions.error.message}</p>
      ) : null}
    </div>
  );
}
