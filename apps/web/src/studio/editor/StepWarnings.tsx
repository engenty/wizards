import type { StepWarning } from "@engenty/wizards-shared/connectors";
import { TriangleAlert } from "lucide-react";
import { Link } from "react-router";
import { t } from "../../lib/i18n";
import { useIsAdmin } from "../../lib/session";
import { cn } from "../../ui";
import { warningAdvice, warningLink, warningOfStep, warningText } from "./step-warnings";

/**
 * What the editor warns of (docs/plans/capabilities-next.md, 2b): steps that save and publish
 * and fail in a run as the space's rules are now. Each warning says which connection and which
 * rule, what the reader can do (an admin changes the rule, a member asks one) and leads to the
 * connection's page. On a step's panel the step is known; in the publish dialog (`steps`) each
 * line names its step.
 */
export function StepWarnings({
  warnings,
  steps,
  className,
}: {
  warnings: StepWarning[];
  /** The draft's steps: each warning then starts with its step's title. */
  steps?: { id: string; title: string }[];
  className?: string;
}) {
  const admin = useIsAdmin();
  if (!warnings.length) {
    return null;
  }
  return (
    <div
      role="note"
      className={cn(
        "flex flex-col gap-2.5 rounded-lg bg-amber-tint px-3 py-2.5 text-[0.8125rem] text-ink-2",
        className,
      )}
    >
      {steps ? <p className="font-medium text-ink">{t("live.warnings")}</p> : null}
      {warnings.map((warning) => (
        <div key={`${warning.stepId}:${warning.action.id}`} className="flex items-start gap-2.5">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber" aria-hidden="true" />
          <p className="min-w-0 leading-relaxed">
            {steps ? warningOfStep(warning, steps) : warningText(warning)} {warningAdvice(admin)}{" "}
            <Link
              to={warningLink(warning)}
              className="whitespace-nowrap font-medium text-ink underline underline-offset-2"
            >
              {t("stepWarning.openConnection")}
            </Link>
          </p>
        </div>
      ))}
    </div>
  );
}
