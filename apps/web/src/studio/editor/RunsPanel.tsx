import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useDeferredValue, useState } from "react";
import { api } from "../../lib/api";
import { useFeature } from "../../lib/features";
import { lang, t } from "../../lib/i18n";
import { Chip, Empty, Input } from "../../ui";
import { RunTimeline, STATUS } from "./RunTimeline";

interface RunRow {
  id: string;
  mode: "test" | "live";
  status: string;
  label: string | null;
  wakeAt: string | null;
  /** A person has to act first when this is `credits` or `sign_in`. */
  pause: "retry" | "credits" | "sign_in" | null;
  version: number | null;
  createdAt: string;
  credits: number;
  assets: number;
  stepTitle: string | null;
}

export function RunsPanel({
  wizardId,
  onOpen,
}: {
  wizardId: string;
  onOpen: (runId: string) => void;
}) {
  // With runs that last for days a run opens on its timeline here; the timeline opens the run.
  const timelines = useFeature("durableRuns");
  const [shown, setShown] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const q = useDeferredValue(filter.trim());
  const runs = useQuery({
    queryKey: ["runs", wizardId, q],
    queryFn: () =>
      api.get<RunRow[]>(
        `/api/studio/wizards/${wizardId}/runs${q ? `?q=${encodeURIComponent(q)}` : ""}`,
      ),
    refetchInterval: 10_000,
    placeholderData: keepPreviousData,
  });
  if (timelines && shown) {
    return (
      <RunTimeline
        runId={shown}
        wizardId={wizardId}
        onBack={() => setShown(null)}
        onOpen={onOpen}
        onFilter={(label) => {
          setFilter(label);
          setShown(null);
        }}
      />
    );
  }
  if (runs.data && !runs.data.length && !filter) {
    return <Empty>{t("editor.noRuns")}</Empty>;
  }
  const fmt = new Intl.DateTimeFormat(lang, { dateStyle: "short", timeStyle: "short" });
  return (
    <div className="flex flex-col p-2">
      {/* Only where there is something to tell apart. */}
      {timelines && (filter || runs.data?.some((r) => r.label)) ? (
        <div className="px-1 pb-2">
          <Input
            type="search"
            aria-label={t("runs.filter")}
            placeholder={t("runs.filterExample")}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
      ) : null}
      {filter && runs.data && !runs.data.length ? (
        <p className="px-3 py-3 text-[0.8125rem] text-ink-3">{t("runs.noMatch")}</p>
      ) : null}
      {runs.data?.map((r) => (
        <button
          key={r.id}
          type="button"
          onClick={() => (timelines ? setShown(r.id) : onOpen(r.id))}
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
            {timelines && r.label ? (
              <div className="truncate text-[0.8125rem] text-ink-2">{r.label}</div>
            ) : null}
            <div className="truncate text-[0.75rem] text-ink-3">
              {r.pause === "credits"
                ? t("runs.status.waitsCredits")
                : r.pause === "sign_in"
                  ? t("runs.status.waitsSignIn")
                  : r.status === "sleeping" && r.wakeAt
                    ? t("runs.status.sleepingUntil", { time: fmt.format(new Date(r.wakeAt)) })
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
      ))}
    </div>
  );
}
