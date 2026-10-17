import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { type Key, lang, t } from "../../lib/i18n";
import { Chip, Empty } from "../../ui";

interface RunRow {
  id: string;
  mode: "test" | "live";
  status: string;
  version: number | null;
  createdAt: string;
  credits: number;
  assets: number;
  stepTitle: string | null;
}

const STATUS: Record<string, Key> = {
  waiting_input: "runs.status.waiting_input",
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
  const runs = useQuery({
    queryKey: ["runs", wizardId],
    queryFn: () => api.get<RunRow[]>(`/api/studio/wizards/${wizardId}/runs`),
    refetchInterval: 10_000,
  });
  if (runs.data && !runs.data.length) {
    return <Empty>{t("editor.noRuns")}</Empty>;
  }
  const fmt = new Intl.DateTimeFormat(lang, { dateStyle: "short", timeStyle: "short" });
  return (
    <div className="flex flex-col p-2">
      {runs.data?.map((r) => (
        <button
          key={r.id}
          type="button"
          onClick={() => onOpen(r.id)}
          className="flex items-center gap-3 rounded-lg px-3 py-3 text-left hover:bg-accent"
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
              {STATUS[r.status] ? t(STATUS[r.status]) : r.status}
              {r.stepTitle && r.status !== "done" ? ` · ${r.stepTitle}` : ""}
            </div>
          </div>
          <span className="text-[0.75rem] text-ink-4 tabular-nums">
            {t("nav.credits", { n: r.credits })}
          </span>
        </button>
      ))}
    </div>
  );
}
