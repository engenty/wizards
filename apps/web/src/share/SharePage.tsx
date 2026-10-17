import { DownloadButtons, OutputView } from "@engenty-wizards/runner";
import type { ShareView } from "@engenty-wizards/shared/run";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { useEffect } from "react";
import { useParams } from "react-router";
import { BASE } from "@/lib/base";
import { BRAND, Mascot } from "../brand";
import { api, isOffline } from "../lib/api";
import { lang, t } from "../lib/i18n";
import { useStage } from "../lib/theme";
import { BrandHeader } from "../runner/PublicRunner";
import { useRunTheme } from "../runner/theme";
import { Button, Card, Spinner } from "../ui";

/** A shared result, read-only: the deliverables, their downloads, and a way to make your own. */
export function SharePage() {
  const { token } = useParams();
  const share = useQuery({
    queryKey: ["share", token],
    queryFn: () => api.get<ShareView>(`/api/shares/${token}`),
    retry: (count, err) => isOffline(err) && count < 3,
  });
  useRunTheme(share.data?.brand.theme);
  useStage(share.data?.wizard.avatar);
  useEffect(() => {
    if (share.data) {
      document.title = `${share.data.title} · ${share.data.wizard.title}`;
    }
  }, [share.data]);

  if (share.isLoading) {
    return (
      <div className="flex min-h-dvh items-center justify-center text-ink-4">
        <Spinner />
      </div>
    );
  }
  const view = share.data;
  if (!view) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
        <Mascot kind="pebble" size={80} />
        <p className="max-w-sm text-ink-3">
          {t(isOffline(share.error) ? "common.offline" : "sharePage.gone")}
        </p>
        {isOffline(share.error) ? (
          <Button variant="secondary" onClick={() => void share.refetch()}>
            {t("common.retry")}
          </Button>
        ) : null}
      </div>
    );
  }
  const base = `/api/shares/${view.token}`;
  const date = (iso: string) =>
    new Intl.DateTimeFormat(lang, { dateStyle: "long" }).format(new Date(iso));
  return (
    <div className="flex min-h-dvh flex-col">
      <BrandHeader brand={view.brand} />
      <main className="mx-auto w-full max-w-3xl flex-1 animate-rise px-4 pt-6 pb-12 sm:px-6">
        <div className="mb-8 flex flex-wrap items-center gap-4">
          <Mascot kind={view.wizard.avatar} size={64} />
          <div className="min-w-0 flex-1">
            <p className="text-[0.8125rem] text-ink-4">
              {view.expiresAt
                ? t("sharePage.until", { date: date(view.expiresAt) })
                : t("sharePage.shared", { date: date(view.createdAt) })}
            </p>
            <h1 className="font-display font-semibold text-[1.75rem] leading-tight tracking-tight sm:text-[2rem]">
              {view.title}
            </h1>
            {view.message ? (
              <p className="mt-1 text-[0.9375rem] text-ink-3">{view.message}</p>
            ) : null}
          </div>
        </div>
        <div className="flex flex-col gap-6">
          {view.shown.map(({ step, output, formats, label }) => (
            <Card key={step.id} className="p-4 sm:p-5">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <h2 className="font-display font-semibold text-[1.0625rem]">
                  {label ?? step.title}
                </h2>
                <DownloadButtons
                  base={base}
                  stepId={step.id}
                  formats={formats}
                  title={label ?? step.title}
                />
              </div>
              <OutputView base={base} step={step} output={output} />
            </Card>
          ))}
        </div>
        {view.wizardUrl ? (
          <a
            href={view.wizardUrl}
            className="mt-10 flex items-center gap-4 rounded-2xl bg-card p-5 shadow-soft ring-1 ring-border-soft transition hover:shadow-elevated"
          >
            <Mascot kind={view.wizard.avatar} size={44} interactive={false} />
            <div className="min-w-0 flex-1">
              <div className="font-display font-semibold text-[1rem]">{view.wizard.title}</div>
              {view.wizard.description ? (
                <div className="truncate text-[0.875rem] text-ink-3">{view.wizard.description}</div>
              ) : null}
            </div>
            <span className="inline-flex items-center gap-1.5 font-medium text-[0.875rem] text-ember-strong">
              {t("sharePage.own")} <ArrowRight className="size-4" />
            </span>
          </a>
        ) : null}
      </main>
      <footer className="safe-bottom pt-6 text-center text-[0.75rem] text-ink-4">
        <a href={`${BASE}/`} className="inline-block py-3.5 hover:text-ink-2">
          {t("run.madeWith").replace("engenty wizards", BRAND.name)}
        </a>
      </footer>
    </div>
  );
}
