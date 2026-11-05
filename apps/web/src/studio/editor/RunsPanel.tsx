import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { type Key, lang, t } from "../../lib/i18n";
import { Button, Chip, Empty } from "../../ui";

interface RunRow {
  id: string;
  mode: "test" | "live";
  status: string;
  wakeAt: string | null;
  version: number | null;
  createdAt: string;
  credits: number;
  assets: number;
  stepTitle: string | null;
}

const STATUS: Record<string, Key> = {
  waiting_input: "runs.status.waiting_input",
  sleeping: "runs.status.sleeping",
  waiting_signal: "runs.status.waiting_signal",
  running: "runs.status.running",
  done: "runs.status.done",
  failed: "runs.status.failed",
  cancelled: "runs.status.cancelled",
};

export function RunsPanel({
  wizardId,
  onOpen,
}: {
  wizardId: string;
  onOpen: (runId: string) => void;
}) {
  const qc = useQueryClient();
  const runs = useQuery({
    queryKey: ["runs", wizardId],
    queryFn: () => api.get<RunRow[]>(`/api/studio/wizards/${wizardId}/runs`),
    refetchInterval: 10_000,
  });
  const testSignal = useMutation({
    mutationFn: (runId: string) =>
      api.post(`/api/studio/wizards/${wizardId}/runs/${runId}/test-signal`),
    // The answer comes before any step runs: asked again a moment later, the run has gone on.
    onSettled: () => {
      setTimeout(() => qc.invalidateQueries({ queryKey: ["runs", wizardId] }), 1500);
    },
  });
  if (runs.data && !runs.data.length) {
    return <Empty>{t("editor.noRuns")}</Empty>;
  }
  const fmt = new Intl.DateTimeFormat(lang, { dateStyle: "short", timeStyle: "short" });
  return (
    <div className="flex flex-col p-2">
      {testSignal.error ? (
        <p className="px-3 py-1 text-[0.8125rem] text-rose">
          {(testSignal.error as Error).message}
        </p>
      ) : null}
      {runs.data?.map((r) => (
        <div key={r.id} className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onOpen(r.id)}
            className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-3 py-3 text-left hover:bg-accent"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-[0.875rem]">
                {fmt.format(new Date(r.createdAt))}
                {r.mode === "test" ? (
                  <Chip>{t("run.testChip")}</Chip>
                ) : (
                  <Chip tone="live">Live v{r.version}</Chip>
                )}
              </div>
              <div className="truncate text-[0.75rem] text-ink-3">
                {r.status === "sleeping" && r.wakeAt
                  ? t("runs.status.sleepingUntil", { time: fmt.format(new Date(r.wakeAt)) })
                  : r.status === "waiting_signal" && r.wakeAt
                    ? t("runs.status.waiting_signalUntil", { time: fmt.format(new Date(r.wakeAt)) })
                    : STATUS[r.status]
                      ? t(STATUS[r.status])
                      : r.status}
                {r.stepTitle && r.status !== "done" ? ` · ${r.stepTitle}` : ""}
              </div>
            </div>
            <span className="text-[0.75rem] text-ink-4 tabular-nums">
              {t("nav.credits", { n: r.credits })}
            </span>
          </button>
          {r.status === "waiting_signal" && r.mode === "test" ? (
            <Button
              size="sm"
              variant="secondary"
              busy={testSignal.isPending && testSignal.variables === r.id}
              onClick={() => testSignal.mutate(r.id)}
            >
              {t("runs.testSignal")}
            </Button>
          ) : null}
        </div>
      ))}
    </div>
  );
}
