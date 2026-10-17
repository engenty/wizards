import { useQuery } from "@tanstack/react-query";
import { Paperclip, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { lang, t } from "../../lib/i18n";
import { RunnerBody } from "../../runner/RunnerView";
import { Card, Chip, Empty, Input, Select } from "../../ui";
import { RunDrawer } from "../RunDrawer";
import { Section } from "./Section";

export interface SpaceResults {
  /** The space's wizards, with how many results each has; the one with the latest first. */
  wizards: { id: string; title: string; results: number; lastAt: string | null }[];
  /** Runs that reached their result, newest first: of one wizard, or of all. */
  runs: {
    id: string;
    wizardId: string;
    mode: "test" | "live";
    version: number | null;
    doneAt: string;
    credits: number;
    assets: number;
  }[];
}

/** What the list is narrowed to besides the wizard: words, live or test runs, the last days. */
export interface ResultsFilter {
  q: string;
  mode: "" | "live" | "test";
  days: number;
}

export const NO_FILTER: ResultsFilter = { q: "", mode: "", days: 0 };

/** The space's results, of one wizard (`wizardId`) or of all, narrowed by `filter`. */
export function useResults(
  projectId: string | undefined,
  wizardId: string | null,
  filter: ResultsFilter,
) {
  const query = new URLSearchParams();
  if (wizardId) {
    query.set("wizard", wizardId);
  }
  if (filter.q.trim()) {
    query.set("q", filter.q.trim());
  }
  if (filter.mode) {
    query.set("mode", filter.mode);
  }
  if (filter.days) {
    query.set("days", String(filter.days));
  }
  const search = query.toString();
  return useQuery({
    queryKey: ["results", projectId, search],
    queryFn: () =>
      api.get<SpaceResults>(`/api/studio/projects/${projectId}/results${search && `?${search}`}`),
    enabled: Boolean(projectId),
    placeholderData: (previous) => previous,
    refetchInterval: 15_000,
  });
}

/** Search, live or test, and the period, above the list. The words count after a short pause. */
function FilterBar({
  filter,
  onFilter,
}: {
  filter: ResultsFilter;
  onFilter: (next: ResultsFilter) => void;
}) {
  const [text, setText] = useState(filter.q);
  useEffect(() => {
    if (text === filter.q) {
      return;
    }
    const timer = setTimeout(() => onFilter({ ...filter, q: text }), 250);
    return () => clearTimeout(timer);
  }, [text, filter, onFilter]);
  return (
    <div className="flex flex-wrap gap-2">
      <div className="relative min-w-0 flex-1 basis-56">
        <Search className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-3 size-4 text-ink-3" />
        <Input
          type="search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t("space.resultsSearch")}
          aria-label={t("space.resultsSearch")}
          className="w-full pl-9"
        />
      </div>
      <Select
        value={filter.mode}
        onChange={(mode) => onFilter({ ...filter, mode: mode as ResultsFilter["mode"] })}
        options={[
          { value: "", label: t("space.resultsModeAll") },
          { value: "live", label: "Live" },
          { value: "test", label: "Test" },
        ]}
        className="w-32"
      />
      <Select
        value={String(filter.days)}
        onChange={(days) => onFilter({ ...filter, days: Number(days) })}
        options={[
          { value: "0", label: t("space.resultsAnyTime") },
          { value: "1", label: t("space.resultsDay") },
          { value: "7", label: t("space.resultsDays", { n: 7 }) },
          { value: "30", label: t("space.resultsDays", { n: 30 }) },
        ]}
        className="w-44"
      />
    </div>
  );
}

/**
 * Results: the runs of the space's wizards that reached their result, newest first. A run is
 * opened beside the list as the person saw it, with its files.
 */
export function Results({
  data,
  wizardId,
  filter,
  onFilter,
}: {
  data: SpaceResults;
  wizardId: string | null;
  filter: ResultsFilter;
  onFilter: (next: ResultsFilter) => void;
}) {
  const [open, setOpen] = useState<SpaceResults["runs"][number] | null>(null);
  const titleOf = (id: string) => data.wizards.find((w) => w.id === id)?.title ?? "";
  const fmt = new Intl.DateTimeFormat(lang, { dateStyle: "medium", timeStyle: "short" });
  return (
    <>
      <Section
        title={wizardId ? titleOf(wizardId) : t("space.resultsAll")}
        hint={t("space.resultsHint")}
        plain
      >
        <FilterBar filter={filter} onFilter={onFilter} />
        {data.runs.length ? (
          <Card className="flex flex-col p-1.5">
            {data.runs.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => setOpen(r)}
                className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-left transition hover:bg-accent"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[0.875rem]">
                    {wizardId ? fmt.format(new Date(r.doneAt)) : titleOf(r.wizardId)}
                  </div>
                  <div className="truncate text-[0.75rem] text-ink-3">
                    {wizardId ? null : `${fmt.format(new Date(r.doneAt))} · `}
                    {t("space.resultCredits", { n: r.credits })}
                  </div>
                </div>
                {r.assets ? (
                  <span
                    className="inline-flex items-center gap-1 text-[0.75rem] text-ink-3 tabular-nums"
                    title={t("space.resultFiles", { n: r.assets })}
                  >
                    <Paperclip className="size-3.5" />
                    {r.assets}
                  </span>
                ) : null}
                {r.mode === "test" ? (
                  <Chip>{t("run.testChip")}</Chip>
                ) : (
                  <Chip tone="live">Live v{r.version}</Chip>
                )}
              </button>
            ))}
          </Card>
        ) : (
          <Card>
            <Empty>
              {filter.q.trim() || filter.mode || filter.days
                ? t("space.resultsNone")
                : t("space.resultsEmpty")}
            </Empty>
          </Card>
        )}
      </Section>
      {open ? (
        <RunDrawer
          header={
            <>
              <span className="min-w-0 flex-1 truncate font-medium text-[0.875rem]">
                {titleOf(open.wizardId)}
              </span>
              {open.mode === "test" ? (
                <Chip>{t("run.testChip")}</Chip>
              ) : (
                <Chip tone="live">Live v{open.version}</Chip>
              )}
            </>
          }
          onClose={() => setOpen(null)}
        >
          <RunnerBody key={open.id} runId={open.id} compact studio />
        </RunDrawer>
      ) : null}
    </>
  );
}
