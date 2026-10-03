import { AskPanel, Markdown } from "@engenty-wizards/runner";
import type { ShareJobView } from "@engenty-wizards/shared/sharing";
import { Check, ExternalLink, Sparkles, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { api } from "../lib/api";
import { t } from "../lib/i18n";
import { Button, cn, Spinner } from "../ui";

/**
 * A result on its way to a target: what happens, what it asks the person (a sign-in, leave to
 * publish), and where it ended up.
 */
export function ShareJob({
  runId,
  job,
  onAgain,
  onHome,
}: {
  runId: string;
  job: ShareJobView;
  /** Back to the target's form; null when the sheet no longer has it. */
  onAgain: (() => void) | null;
  onHome: () => void;
}) {
  const [stopping, setStopping] = useState(false);
  if (job.status === "running" && job.ask) {
    return <AskPanel key={job.ask.id} runId={runId} ask={job.ask} />;
  }
  if (job.status === "running") {
    const trail = job.events.slice(-5);
    return (
      <div className="animate-rise">
        <div className="flex flex-col items-center py-6 text-center">
          <Spinner className="size-7 text-ember" />
          <h3 className="mt-4 font-display font-semibold text-[1.125rem]">
            {t("shareRun.working")}
          </h3>
          <div className="mt-4 flex min-h-[5.5rem] w-full max-w-sm flex-col gap-1.5">
            {trail.map((ev, i) => (
              <div
                key={ev.at + ev.message}
                className={cn(
                  "flex items-center justify-center gap-2 text-[0.8125rem]",
                  i === trail.length - 1 ? "text-ink-2" : "text-ink-4",
                )}
              >
                {i === trail.length - 1 ? (
                  <Sparkles className="size-3.5 shrink-0 animate-breathe text-ember" />
                ) : null}
                <span className="truncate">{ev.message}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="flex justify-center">
          <Button
            variant="ghost"
            busy={stopping}
            onClick={() => {
              setStopping(true);
              void api
                .post(`/api/runs/${runId}/share/jobs/${job.id}/cancel`)
                .catch(() => undefined);
            }}
          >
            {t("common.cancel")}
          </Button>
        </div>
      </div>
    );
  }
  const done = job.status === "done";
  return (
    <div className="animate-rise">
      <div className="flex flex-col items-center py-4 text-center">
        <div
          className={cn(
            "flex size-12 items-center justify-center rounded-full",
            done ? "bg-moss-tint text-moss" : "bg-rose-tint text-rose",
          )}
        >
          {done ? <Check className="size-6" /> : <TriangleAlert className="size-6" />}
        </div>
        <h3 className="mt-4 font-display font-semibold text-[1.125rem]">
          {t(
            done
              ? "shareRun.done"
              : job.status === "cancelled"
                ? "shareRun.cancelled"
                : "shareRun.failed",
          )}
        </h3>
        {done && job.result ? (
          <Markdown
            text={job.result.summary}
            className="mt-2 max-w-md text-[0.875rem] text-ink-2"
          />
        ) : job.error ? (
          <p className="mt-2 max-w-md text-[0.875rem] text-ink-2 leading-relaxed">{job.error}</p>
        ) : null}
        {done && job.result?.url ? (
          <a
            href={job.result.url}
            target="_blank"
            rel="noreferrer"
            className="mt-4 inline-flex h-10 items-center gap-2 rounded-full bg-paper-2 px-4 font-medium text-[0.875rem] text-ink hover:bg-paper-3 coarse:h-11"
          >
            <ExternalLink className="size-4" /> {t("share.open")}
          </a>
        ) : null}
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        {onAgain ? (
          <Button variant="ghost" onClick={onAgain}>
            {t(done ? "shareRun.again" : "shareRun.backToForm")}
          </Button>
        ) : (
          <span />
        )}
        <Button onClick={onHome}>{t("shareRun.elsewhere")}</Button>
      </div>
    </div>
  );
}
