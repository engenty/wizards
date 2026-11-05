import type { RunEvent, RunTimeline as Timeline } from "@engenty/wizards-shared/run";
import {
  type UseMutationResult,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Check, ChevronLeft, Copy, Hourglass, Play, Square } from "lucide-react";
import { useState } from "react";
import { api } from "../../lib/api";
import { eventText, type Key, lang, t } from "../../lib/i18n";
import { Button, Chip, cn, IconButton } from "../../ui";
import { askConfirm } from "../../ui/confirm";
import { KIND, logText, time } from "./RunLog";

export const STATUS: Record<string, Key> = {
  waiting_input: "runs.status.waiting_input",
  sleeping: "runs.status.sleeping",
  waiting_signal: "runs.status.waiting_signal",
  running: "runs.status.running",
  done: "runs.status.done",
  failed: "runs.status.failed",
  cancelled: "runs.status.cancelled",
};

const longTime = (at: string) =>
  new Intl.DateTimeFormat(lang, {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(at));

const dayOf = (at: string) =>
  new Intl.DateTimeFormat(lang, { weekday: "long", day: "numeric", month: "long" }).format(
    new Date(at),
  );

/** What a person reads of a line. A step's start says nothing the next lines don't. */
const shown = (ev: RunEvent) => ev.type !== "step_started";

const textOf = (ev: RunEvent) => (ev.type === "step_done" ? t("runs.status.done") : eventText(ev));

type Command = "wake-now" | "stop";

/** What a run that waits for something offers, and what it says while it does. */
function WaitBanner({
  run,
  command,
}: {
  run: Timeline;
  command: UseMutationResult<unknown, Error, Command>;
}) {
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
        {sleeping || listening ? (
          <div className="text-[0.8125rem] text-ink-2">{t("runs.waitsHint")}</div>
        ) : null}
      </div>
      {run.canAct ? (
        <div className="flex basis-full flex-wrap items-center gap-2">
          {run.wakeAt ? (
            <Button
              variant="secondary"
              size="sm"
              busy={command.isPending && command.variables === "wake-now"}
              disabled={command.isPending}
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
            disabled={command.isPending}
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

/** One run in the runs panel: where it stands, what it did, and what can be done while it waits. */
export function RunTimeline({
  runId,
  wizardId,
  onBack,
  onOpen,
  onFilter,
}: {
  runId: string;
  wizardId: string;
  onBack: () => void;
  onOpen: (runId: string) => void;
  /** Back to the list, narrowed to the runs with this label. */
  onFilter: (label: string) => void;
}) {
  const queryClient = useQueryClient();
  const [copied, setCopied] = useState(false);
  const query = useQuery({
    queryKey: ["run-timeline", runId],
    queryFn: () => api.get<Timeline>(`/api/runs/${runId}/timeline`),
    refetchInterval: 5000,
  });
  const command = useMutation({
    mutationFn: (which: Command) => api.post(`/api/runs/${runId}/${which}`),
    // A refusal means the run moved on: either way the timeline shows what is true now.
    onSettled: () => {
      void query.refetch();
      void queryClient.invalidateQueries({ queryKey: ["runs", wizardId] });
    },
  });
  const run = query.data;
  if (!run) {
    return null;
  }
  const lines = run.events.filter(shown);
  const titles = Object.fromEntries(run.steps.map((s) => [s.id, s.title]));
  const fmt = new Intl.DateTimeFormat(lang, { dateStyle: "medium", timeStyle: "short" });
  return (
    <div className="flex flex-col px-3 pt-2 pb-4">
      <div className="flex flex-wrap items-center gap-2">
        <IconButton label={t("runs.back")} onClick={onBack}>
          <ChevronLeft className="size-5" />
        </IconButton>
        <span className="text-[0.875rem]">{fmt.format(new Date(run.createdAt))}</span>
        {run.mode === "test" ? (
          <Chip>{t("run.testChip")}</Chip>
        ) : (
          <Chip tone="live">Live v{run.version}</Chip>
        )}
        <Chip
          tone={run.status === "sleeping" || run.status === "waiting_signal" ? "warn" : "neutral"}
        >
          {STATUS[run.status] ? t(STATUS[run.status]) : run.status}
        </Chip>
        <span className="flex-1" />
        <span className="text-[0.75rem] text-ink-4 tabular-nums">
          {t("nav.credits", { n: run.credits })}
        </span>
        <Button variant="ghost" size="sm" onClick={() => onOpen(run.id)}>
          {t("runs.open")}
        </Button>
      </div>
      {run.label || run.startedBy ? (
        <p className="pt-1 pb-3 pl-9 text-[0.75rem] text-ink-3">
          {run.label ? (
            <button
              type="button"
              title={t("runs.filterByLabel")}
              onClick={() => onFilter(run.label ?? "")}
              className="hover:text-ink hover:underline"
            >
              {run.label}
            </button>
          ) : null}
          {run.label && run.startedBy ? " · " : ""}
          {run.startedBy ? t("runs.startedByName", { name: run.startedBy }) : ""}
        </p>
      ) : (
        <div className="h-2" />
      )}
      {run.status === "sleeping" ||
      run.status === "waiting_signal" ||
      run.status === "waiting_input" ? (
        <WaitBanner run={run} command={command} />
      ) : null}
      {/* Outside the banner: a refusal says the run moved on, and the banner goes with that. */}
      {command.error ? (
        <p className="px-3 pt-2 text-[0.8125rem] text-rose">{command.error.message}</p>
      ) : null}
      <div className="mt-1 flex h-10 items-center gap-2 pr-1.5 pl-3">
        <span className="font-medium text-[0.75rem] text-ink-3 uppercase tracking-[0.07em]">
          {t("log.title")}
        </span>
        <span className="text-[0.75rem] text-ink-4 tabular-nums">
          {t("log.count", { count: lines.length })}
        </span>
        <span className="flex-1" />
        {lines.length ? (
          <IconButton
            label={t(copied ? "log.copied" : "log.copy")}
            onClick={() => {
              void navigator.clipboard
                .writeText(logText(lines, titles))
                .then(() => setCopied(true))
                .catch(() => {});
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? <Check className="size-4 text-moss" /> : <Copy className="size-4" />}
          </IconButton>
        ) : null}
      </div>
      {run.total > run.events.length ? (
        <p className="px-3 pb-1 text-[0.75rem] text-ink-3">
          {t("runs.olderLeftOut", { n: run.events.length, total: run.total })}
        </p>
      ) : null}
      <ol className="px-3 text-[0.75rem]">
        {lines.map((ev, i) => {
          const { Icon, tone } = KIND[ev.type];
          const day = dayOf(ev.at);
          return (
            <li key={ev.id}>
              {day !== (i ? dayOf(lines[i - 1].at) : null) ? (
                <div className="pt-3 pb-1 font-medium text-ink-3">{day}</div>
              ) : null}
              <div className="grid grid-cols-[4.25rem_1rem_minmax(0,1fr)] items-start gap-x-2 border-border-soft/60 border-t py-1.5">
                <span className="text-ink-4 tabular-nums leading-5">{time(ev.at)}</span>
                <Icon
                  className={cn("mt-1 size-3.5", tone)}
                  aria-label={t(`log.kind.${ev.type}` as Key)}
                />
                <span className="min-w-0 leading-5">
                  {ev.stepId ? (
                    <span className="mr-1.5 font-medium text-ink">
                      {titles[ev.stepId] ?? ev.stepId}
                    </span>
                  ) : null}
                  <span
                    className={cn(
                      "break-words",
                      ev.type === "error" ? "text-rose" : "text-ink-2",
                      ev.type === "tool" && "font-mono text-[0.6875rem]",
                    )}
                  >
                    {textOf(ev)}
                  </span>
                </span>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
