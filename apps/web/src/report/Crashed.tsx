import { Component, type ReactNode } from "react";
import { t } from "../lib/i18n";
import { report } from "../lib/report";
import { Button } from "../ui";
import { openReport, ReportHost } from "./ReportDialog";

/**
 * Catches what a page throws while it draws: instead of a blank window, the crash in plain words,
 * a reload, and "Report a problem" with the error filled in.
 */
export class Crashed extends Component<
  { where: "run" | "studio" | "page"; children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    report("error", error.message, error.stack);
  }

  render() {
    const { error } = this.state;
    if (!error) {
      return this.props.children;
    }
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center p-6 text-center">
        <h1 className="font-display font-semibold text-[1.375rem]">{t("report.crashed")}</h1>
        <p className="mt-2 max-w-md text-[0.9375rem] text-ink-3">{t("report.crashedNote")}</p>
        <div className="mt-6 flex gap-3">
          <Button variant="secondary" onClick={() => window.location.reload()}>
            {t("report.reload")}
          </Button>
          <Button
            onClick={() =>
              openReport({
                where: this.props.where,
                error: { message: error.message, stack: error.stack },
              })
            }
          >
            {t("report.open")}
          </Button>
        </div>
        <ReportHost />
      </div>
    );
  }
}
