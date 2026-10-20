import type { RunView } from "@engenty/wizards-shared/run";
import { Flag, ThumbsDown, ThumbsUp } from "lucide-react";
import { useState } from "react";
import { withBase } from "../lib/base";
import { useConfig } from "../lib/features";
import { t } from "../lib/i18n";
import { Button, Textarea } from "../ui";
import { openReport } from "./ReportDialog";

/**
 * What the run page shows at a run's end (the runner's `RunEnd`): "How did it go?" with good or
 * not good and a line of words, and "Report a problem". Both reach the Manage-App, so only a
 * managed runtime offers them.
 */
export function RunEnd({ view, failed }: { view: RunView; failed?: boolean }) {
  const config = useConfig();
  const [good, setGood] = useState<boolean | null>(null);
  const [comment, setComment] = useState("");
  const [sent, setSent] = useState(false);
  if (!config.data?.reports) {
    return null;
  }
  const report = (
    <Button
      variant="ghost"
      size="sm"
      onClick={() =>
        openReport({
          where: "run",
          runId: view.id,
          error: failed && view.error ? { message: view.error } : null,
        })
      }
    >
      <Flag className="size-4" /> {t("report.open")}
    </Button>
  );
  if (failed) {
    return <div className="mt-4 flex justify-center">{report}</div>;
  }
  const send = async (answer: boolean, words?: string) => {
    setGood(answer);
    await fetch(withBase(`/api/runs/${view.id}/feedback`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ good: answer, ...(words ? { comment: words } : {}) }),
    }).catch(() => undefined);
    if (words !== undefined) {
      setSent(true);
    }
  };
  return (
    <div className="mt-8 rounded-2xl border border-border bg-card p-4 sm:p-5">
      {sent ? (
        <p className="text-ink-2 text-sm">{t("feedback.thanks")}</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="mr-2 font-medium text-[0.9375rem]">{t("feedback.ask")}</span>
            <Button
              size="sm"
              variant={good === true ? "quiet" : "secondary"}
              onClick={() => void send(true)}
            >
              <ThumbsUp className="size-4" /> {t("feedback.good")}
            </Button>
            <Button
              size="sm"
              variant={good === false ? "quiet" : "secondary"}
              onClick={() => void send(false)}
            >
              <ThumbsDown className="size-4" /> {t("feedback.bad")}
            </Button>
            <span className="ml-auto">{report}</span>
          </div>
          {good !== null ? (
            <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
              <Textarea
                rows={2}
                value={comment}
                placeholder={t("feedback.more")}
                onChange={(e) => setComment(e.target.value)}
                className="flex-1"
              />
              <Button size="sm" onClick={() => void send(good, comment.trim())}>
                {t("feedback.send")}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
