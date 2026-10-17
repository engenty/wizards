import { defineStudioPlugin } from "@engenty/wizards/plugin/studio";
import { Button, Card, Chip, Empty, Spinner } from "@engenty-wizards/web/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ListChecks } from "lucide-react";
import { Link } from "react-router";
import { messages } from "./messages";

interface Entry {
  id: number;
  title: string;
  mode: "test" | "live";
  status: "done" | "failed" | "cancelled";
  endedAt: string;
}

interface Log {
  total: number;
  entries: Entry[];
}

const TONE = { done: "live", failed: "warn", cancelled: "neutral" } as const;

/**
 * The studio half of the example: a section of the space page under Results, which leads to
 * a page of the whole log, and a section of the settings. All read the plugin's own routes.
 */
export default defineStudioPlugin((studio) => {
  const t = studio.i18n.register(messages);
  const useLog = () => useQuery({ queryKey: ["run-log"], queryFn: () => studio.api.get<Log>("/") });

  function RunLogPage() {
    const log = useLog();
    return (
      <div className="animate-rise">
        <h1 className="font-display font-semibold text-[1.75rem] tracking-tight">{t("title")}</h1>
        <p className="mt-1 text-[0.9375rem] text-ink-3">{t("hint")}</p>
        <div className="mt-8 flex flex-col gap-2">
          {log.isLoading ? <Spinner className="mx-auto" /> : null}
          {log.data && !log.data.entries.length ? <Empty>{t("empty")}</Empty> : null}
          {log.data?.entries.map((entry) => (
            <Card key={entry.id} className="flex items-center gap-3 px-5 py-3.5">
              <span className="min-w-0 flex-1 truncate font-medium text-[0.9375rem]">
                {entry.title}
              </span>
              {entry.mode === "test" ? <Chip>{t("test")}</Chip> : null}
              <Chip tone={TONE[entry.status]}>{t(entry.status)}</Chip>
              <time className="w-36 shrink-0 text-right text-[0.8125rem] text-ink-3 tabular-nums max-sm:hidden">
                {new Date(entry.endedAt).toLocaleString(studio.i18n.lang())}
              </time>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  function RunLogSettings() {
    const log = useLog();
    const cache = useQueryClient();
    const clear = useMutation({
      mutationFn: () => studio.api.del("/"),
      onSuccess: () => cache.invalidateQueries({ queryKey: ["run-log"] }),
    });
    return (
      <section className="flex flex-col gap-2.5">
        <h2 className="px-1 font-display font-semibold text-lg leading-tight">{t("settings")}</h2>
        <Card className="flex items-center justify-between gap-4 p-5">
          <p className="text-[0.875rem] text-ink-2">{t("kept", { n: log.data?.total ?? 0 })}</p>
          <Button
            variant="danger"
            busy={clear.isPending}
            disabled={!log.data?.total}
            onClick={() => clear.mutate()}
          >
            {t("clear")}
          </Button>
        </Card>
      </section>
    );
  }

  /** The space's last runs, under the space's own sections; it follows the space picked. */
  function RunLogSpace() {
    const space = studio.useSpace();
    const log = useQuery({
      queryKey: ["run-log", space?.id],
      queryFn: () => studio.api.get<Log>(`/?space=${space?.id}`),
      enabled: Boolean(space),
    });
    if (!log.data) {
      return log.isLoading ? <Spinner className="mx-auto" /> : null;
    }
    if (!log.data.entries.length) {
      return <Empty>{t("spaceEmpty")}</Empty>;
    }
    return (
      <Card className="flex flex-col divide-y divide-border-soft px-5 py-1.5">
        {log.data.entries.map((entry) => (
          <div key={entry.id} className="flex items-center gap-3 py-2.5">
            <span className="min-w-0 flex-1 truncate text-[0.875rem]">{entry.title}</span>
            {entry.mode === "test" ? <Chip>{t("test")}</Chip> : null}
            <Chip tone={TONE[entry.status]}>{t(entry.status)}</Chip>
          </div>
        ))}
        <Link to="/run-log" className="py-2.5 text-[0.8125rem] text-ink-3 hover:text-ink">
          {t("all", { n: log.data.total })}
        </Link>
      </Card>
    );
  }

  studio.registerPage({ path: "/run-log", component: RunLogPage });
  studio.registerSettingsSection({
    id: "run-log",
    label: () => t("settings"),
    icon: ListChecks,
    component: RunLogSettings,
  });
  studio.registerSpaceSection({
    id: "run-log",
    group: "results",
    label: () => t("title"),
    hint: () => t("spaceHint"),
    component: RunLogSpace,
  });
});
