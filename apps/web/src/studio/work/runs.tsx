import { FileQuestion, ShieldQuestion } from "lucide-react";
import { NavLink, useNavigate } from "react-router";
import { lang, t } from "../../lib/i18n";
import { Button, cn } from "../../ui";
import { useDecideRun, type WaitingRun } from "./waiting";

/** The runs that wait for a person, as the studio's start and the bell show them. */

export function greeting(name: string) {
  const hour = new Date().getHours();
  const key = hour < 11 ? "work.home.morning" : hour < 18 ? "work.home.day" : "work.home.evening";
  return t(key, { name });
}

/** Today at its time, yesterday as such, else the date. */
function when(iso: string) {
  const day = new Date(iso);
  const today = new Date();
  if (day.toDateString() === today.toDateString()) {
    return day.toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" });
  }
  if (day.toDateString() === new Date(today.getTime() - 86_400_000).toDateString()) {
    return t("work.yesterday");
  }
  return day.toLocaleDateString(lang, { day: "numeric", month: "short" });
}

const card = "grid content-start gap-3 rounded-2xl border border-border bg-card p-4";

/** Where Work opens a run. */
export const runLink = (run: Pick<WaitingRun, "runId">) => `/work/r/${run.runId}`;

/** Since when and until when a run waits, with whom it is about. */
export function runFacts(run: WaitingRun) {
  return [
    run.about,
    t("work.home.since", { when: when(run.since) }),
    run.until ? t("work.home.until", { when: when(run.until) }) : t("work.home.noDeadline"),
  ]
    .filter(Boolean)
    .join(" · ");
}

/** A run that waits for the person: answered in Work, an approval right here. */
export function RunCard({ run }: { run: WaitingRun }) {
  const decide = useDecideRun(run);
  const navigate = useNavigate();
  const Icon = run.kind === "approve" ? ShieldQuestion : FileQuestion;
  return (
    <div className={cn(card, run.kind === "approve" && "border-ember/40")}>
      <div className="flex items-start gap-2.5">
        <Icon className="mt-0.5 size-4 shrink-0 text-ember" />
        <div className="grid min-w-0 gap-0.5">
          <p className="truncate text-[0.75rem] text-ink-3">
            {run.wizard} · {run.step}
          </p>
          {run.detail ? (
            <p className="line-clamp-3 font-medium text-[0.9375rem] text-ink">{run.detail}</p>
          ) : null}
          <p className="truncate text-[0.75rem] text-ink-3">{runFacts(run)}</p>
        </div>
      </div>
      {decide.error ? (
        <p className="text-[0.8125rem] text-danger">{(decide.error as Error).message}</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {run.kind === "approve" ? (
          <>
            <Button size="sm" disabled={decide.isPending} onClick={() => decide.mutate(true)}>
              {t("run.approve")}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={decide.isPending}
              onClick={() => decide.mutate(false)}
            >
              {t("run.decline")}
            </Button>
          </>
        ) : (
          <Button size="sm" onClick={() => navigate(runLink(run))}>
            {t(run.kind === "review" ? "work.home.review" : "work.home.answer")}
          </Button>
        )}
        <NavLink to={runLink(run)} className="ml-auto text-[0.8125rem] text-ink-3 hover:text-ink">
          {t("work.home.open")}
        </NavLink>
      </div>
    </div>
  );
}
