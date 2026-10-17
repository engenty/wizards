import type { VersionChange } from "@engenty-wizards/shared/changes";
import { useQuery } from "@tanstack/react-query";
import {
  Check,
  CircleAlert,
  CircleCheck,
  FileText,
  Info,
  Minus,
  Pencil,
  Play,
  Plus,
  Rows3,
} from "lucide-react";
import { useState } from "react";
import { api } from "../../lib/api";
import { type Key, lang, t } from "../../lib/i18n";
import type { PublishResult, WizardDetail } from "../../lib/session";
import { Button, cn, Dialog, Spinner } from "../../ui";

/**
 * "Änderungen live schalten": the draft becomes the version people run, from a dialog that
 * says first what changes, whether these changes were tested, and what goes on meanwhile.
 * The first version goes live by sharing; this is every one after it.
 */

/** What the studio asks before: the version that runs, what the draft changes, its last test. */
interface ChangesAnswer {
  version: number | null;
  changes: VersionChange[];
  tested: { runId: string; at: string; status: string } | null;
  /** Credits a run is expected to cost, now and with the draft; null where nothing is counted. */
  cost: { before: number; after: number } | null;
}

/** The parts of a step or of the wizard, by the definition's keys, in the owner's words. */
const PARTS: Record<string, Key> = {
  title: "live.part.title",
  description: "live.part.description",
  fields: "live.part.fields",
  groups: "live.part.fields",
  cta: "live.part.cta",
  instructions: "live.part.instructions",
  tools: "live.part.tools",
  mcp: "live.part.connections",
  connections: "live.part.connections",
  call: "live.part.tools",
  output: "live.part.output",
  model: "live.part.model",
  effort: "live.part.model",
  next: "live.part.next",
  each: "live.part.each",
  intro: "live.part.intro",
  avatar: "live.part.avatar",
  lists: "live.part.lists",
};

/** "Felder und Anweisung", "Titel, Felder und Ergebnis". */
function partsText(parts: string[] = []): string {
  const words = [...new Set(parts.map((p) => t(PARTS[p] ?? "live.part.other")))];
  const and = ` ${t("live.and")} `;
  return words.length <= 1
    ? (words[0] ?? t("live.part.other"))
    : `${words.slice(0, -1).join(", ")}${and}${words[words.length - 1]}`;
}

function changeText(c: VersionChange): string {
  const name = c.name ?? "";
  switch (c.kind) {
    case "wizard":
      return t("live.wizardChanged", { parts: partsText(c.parts) });
    case "order":
      return t("live.order");
    case "file":
      return t(
        c.change === "added"
          ? "live.fileAdded"
          : c.change === "removed"
            ? "live.fileRemoved"
            : "live.fileChanged",
        { name },
      );
    default:
      return c.change === "added"
        ? t("live.stepAdded", { name })
        : c.change === "removed"
          ? t("live.stepRemoved", { name })
          : t("live.stepChanged", { name, parts: partsText(c.parts) });
  }
}

function ChangeIcon({ change }: { change: VersionChange }) {
  const tone =
    change.change === "added"
      ? "bg-moss-tint text-moss"
      : change.change === "removed"
        ? "bg-rose-tint text-rose"
        : "bg-paper-2 text-ink-2";
  let Icon = change.change === "added" ? Plus : change.change === "removed" ? Minus : Pencil;
  if (change.kind === "file") {
    Icon = FileText;
  } else if (change.kind === "order") {
    Icon = Rows3;
  }
  return (
    <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-lg", tone)}>
      <Icon className="size-3.5" />
    </span>
  );
}

/** "gerade eben", "vor 4 Minuten", "vor 2 Stunden", "gestern". */
function ago(iso: string): string {
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
  const minutes = Math.round((new Date(iso).getTime() - Date.now()) / 60_000);
  if (minutes === 0) {
    return t("live.justNow");
  }
  if (Math.abs(minutes) < 60) {
    return rtf.format(minutes, "minute");
  }
  const hours = Math.round(minutes / 60);
  return Math.abs(hours) < 24
    ? rtf.format(hours, "hour")
    : rtf.format(Math.round(hours / 24), "day");
}

/** The editor's publishing, the test run beside it and the assistant that mends. */
export interface LiveActions {
  publish: () => Promise<PublishResult>;
  busy: boolean;
  /** The draft cannot be published as it is: it has issues, or it is being built. */
  disabled: boolean;
  /** Starts a test run of the draft; the run drawer shows it. */
  test: () => void;
  /** Shows a run in the run drawer. */
  openRun: (runId: string) => void;
  /** Asks the assistant to mend the draft's issues. */
  fix?: () => void;
  /** Opens the share dialog. */
  share: () => void;
}

function LivePanel({
  wizard,
  actions,
  cloud,
  onClose,
}: {
  wizard: WizardDetail;
  actions: LiveActions;
  cloud: boolean;
  onClose: () => void;
}) {
  const changes = useQuery({
    queryKey: ["wizard-changes", wizard.id, wizard.revision],
    queryFn: () => api.get<ChangesAnswer>(`/api/studio/wizards/${wizard.id}/changes`),
  });
  const [done, setDone] = useState<PublishResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const live = changes.data?.version ?? wizard.publishedVersion ?? 0;
  const next = live + 1;

  if (done) {
    return (
      <div className="flex flex-col">
        <div className="flex flex-col items-center gap-3 py-6 text-center">
          <span className="flex size-16 items-center justify-center rounded-full bg-moss-tint text-moss">
            <Check className="size-7" strokeWidth={2.25} />
          </span>
          <h3 className="font-display font-semibold text-xl">
            {t("live.done", { v: done.version })}
          </h3>
          <p className="max-w-sm text-[0.9375rem] text-ink-2">
            {t(cloud ? "live.doneCloud" : "live.doneHint", { v: done.version, was: live })}
          </p>
          {done.cloud?.error ? (
            <p className="max-w-sm rounded-lg bg-amber-tint px-3 py-2 text-[0.8125rem]">
              {done.cloud.error.message}
            </p>
          ) : null}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2 max-sm:flex-col-reverse max-sm:items-stretch">
          <Button variant="ghost" onClick={onClose}>
            {t("live.close")}
          </Button>
          <span className="flex-1 max-sm:hidden" />
          <Button onClick={actions.share}>{t("editor.share")}</Button>
        </div>
      </div>
    );
  }

  const issues = wizard.issues;
  const tested = changes.data?.tested ?? null;
  const cost = changes.data?.cost;
  const notes = [
    t("live.keepRunning", { v: live }),
    cost && Math.round(cost.after) !== Math.round(cost.before)
      ? t("live.cost", {
          before: Math.round(cost.before).toLocaleString(lang),
          after: Math.round(cost.after).toLocaleString(lang),
        })
      : null,
    cloud ? t("live.cloud", { v: next }) : null,
  ].filter((n): n is string => Boolean(n));

  return (
    <div className="flex flex-col gap-5">
      <p className="text-[0.9375rem] text-ink-2">{t("live.intro", { v: live, next })}</p>

      <section className="flex flex-col gap-1.5">
        <h3 className="font-medium text-[0.8125rem] text-ink-3">{t("live.changed")}</h3>
        {changes.data ? (
          changes.data.changes.length ? (
            <ul className="flex flex-col gap-0.5">
              {changes.data.changes.map((c, i) => (
                <li key={i} className="flex min-h-10 items-center gap-3 text-[0.875rem]">
                  <ChangeIcon change={c} />
                  <span className="min-w-0 flex-1">{changeText(c)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[0.875rem] text-ink-3">{t("live.nothing")}</p>
          )
        ) : changes.error ? (
          <p className="text-[0.8125rem] text-rose">{(changes.error as Error).message}</p>
        ) : (
          <Spinner className="size-4 text-ink-4" />
        )}
      </section>

      {issues.length ? (
        <div className="flex flex-col gap-2 rounded-xl bg-amber-tint px-3.5 py-3 text-[0.875rem]">
          <div className="flex items-start gap-3">
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-amber" />
            <span className="font-medium">{t("live.fixFirst")}</span>
          </div>
          <ul className="list-disc pl-12 text-[0.8125rem] text-ink-2">
            {issues.slice(0, 4).map((issue, i) => (
              <li key={i}>{issue.message}</li>
            ))}
          </ul>
          {actions.fix ? (
            <div className="pl-7">
              <Button size="sm" variant="secondary" onClick={actions.fix}>
                {t("editor.fixWithChat")}
              </Button>
            </div>
          ) : null}
        </div>
      ) : tested ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-moss-tint px-3.5 py-3 text-[0.875rem]">
          <CircleCheck className="size-4 shrink-0 text-moss" />
          <span className="min-w-0 flex-[1_1_14rem]">
            {t(tested.status === "failed" ? "live.testedFailed" : "live.tested", {
              when: ago(tested.at),
            })}
          </span>
          <button
            type="button"
            onClick={() => actions.openRun(tested.runId)}
            className="text-[0.8125rem] text-ink-2 underline underline-offset-2 hover:text-ink"
          >
            {t("live.seeRun")}
          </button>
        </div>
      ) : changes.data ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-paper-2 px-3.5 py-3 text-[0.875rem]">
          <Play className="size-4 shrink-0 text-ink-3" />
          <span className="min-w-0 flex-[1_1_14rem]">{t("live.untested")}</span>
          <Button size="sm" variant="secondary" onClick={actions.test}>
            {t("live.test")}
          </Button>
        </div>
      ) : null}

      <ul className="flex flex-col gap-1.5 text-[0.8125rem] text-ink-3">
        {notes.map((note) => (
          <li key={note} className="flex items-start gap-2.5">
            <Info className="mt-0.5 size-3.5 shrink-0" />
            <span>{note}</span>
          </li>
        ))}
      </ul>

      {error ? <p className="text-[0.8125rem] text-rose">{error}</p> : null}

      <div className="flex flex-wrap items-center gap-2 border-border-soft border-t pt-4 max-sm:flex-col-reverse max-sm:items-stretch">
        <Button variant="ghost" onClick={onClose}>
          {t("live.cancel")}
        </Button>
        <span className="flex-1 max-sm:hidden" />
        <Button
          busy={actions.busy}
          disabled={actions.disabled}
          onClick={() => {
            setError(null);
            actions
              .publish()
              .then(setDone)
              .catch((err: Error) => setError(err.message));
          }}
        >
          {actions.busy ? t("live.going") : t("live.go")}
        </Button>
      </div>
    </div>
  );
}

/** "Änderungen live schalten", from the editor's top bar and from the share dialog. */
export function LiveDialog({
  wizard,
  open,
  onClose,
  actions,
  cloud,
}: {
  wizard: WizardDetail;
  open: boolean;
  onClose: () => void;
  actions: LiveActions;
  /** A local install with an account: the version goes on to its cloud. */
  cloud: boolean;
}) {
  return (
    <Dialog open={open} onClose={onClose} title={t("live.title")}>
      <LivePanel wizard={wizard} actions={actions} cloud={cloud} onClose={onClose} />
    </Dialog>
  );
}
