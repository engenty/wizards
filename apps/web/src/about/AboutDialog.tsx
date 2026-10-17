import { ChevronRight, X } from "lucide-react";
import { useEffect, useState } from "react";
import { EngentyLogoMark } from "../engenty/logo";
import { t } from "../lib/i18n";
import type { Me } from "../lib/session";
import { useUpdate } from "../lib/update";
import { stepClass, useStepDirection } from "../studio/settings-menu";
import { cn, Dialog, IconButton, Spinner, Tabs } from "../ui";
import { APP_VERSION } from "./AboutLinks";
import {
  type ChangelogRelease,
  loadReleases,
  ReleaseNotes,
  releaseDate,
  releaseLabel,
} from "./ChangelogDialog";
import { Credits } from "./Credits";
import { UpdateCheck } from "./UpdateCheck";

type Tab = "new" | "earlier" | "credits";
const TABS: Tab[] = ["new", "earlier", "credits"];
const label = (tab: Tab) =>
  tab === "new"
    ? t("about.tab.new")
    : tab === "earlier"
      ? t("about.tab.earlier")
      : t("about.credits");

/** `1 Änderung`, `12 Änderungen`. */
const changes = (n: number) => (n === 1 ? t("about.change") : t("about.changes", { n }));

/**
 * Behind the mark in the app bar: which release this is and how it got here; on a runtime that
 * runs alone, whether a newer one is out — checked now on a word, installed from here where it
 * can be — then three tabs: what is new in the newest release known, the earlier releases (each
 * unfolding to its changes), and the credits.
 */
export function AboutDialog({
  open,
  onClose,
  me,
}: {
  open: boolean;
  onClose: () => void;
  /** Without a session (a public page) the dialog says the version and what is new, no updates. */
  me?: Me | null;
}) {
  const local = me?.mode === "local";
  const { data, latest } = useUpdate(local && open);
  const [releases, setReleases] = useState<ChangelogRelease[] | null>(null);
  const [tab, setTab] = useState<Tab>("new");
  const step = useStepDirection(TABS.indexOf(tab));
  // The notes of the newest release known: the newer one from GitHub, else this build's own.
  const shown = data?.newer && latest ? latest : APP_VERSION;
  useEffect(() => {
    if (!open) {
      return;
    }
    let cancelled = false;
    setReleases(null);
    void loadReleases(shown === APP_VERSION ? undefined : shown).then((next) => {
      if (!cancelled) {
        setReleases(next);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [open, shown]);
  const newest = releases?.find((r) => r.version === `v${shown}`) ?? releases?.[0] ?? null;
  const earlier = releases?.filter((r) => r !== newest) ?? [];
  const kind = local ? (data?.kind ?? null) : "cloud";
  return (
    <Dialog open={open} onClose={onClose} wide height="tall">
      {/* No title: the mark says what this is. The close stays in the corner while it scrolls. */}
      <div className="-mt-2 -mr-2 sticky top-0 z-10 flex h-0 justify-end">
        <IconButton label={t("common.close")} onClick={onClose}>
          <X className="size-4" />
        </IconButton>
      </div>
      <div className="flex flex-col items-center pt-4 text-center">
        <EngentyLogoMark size={96} />
        <div className="mt-4 font-display font-semibold text-[1.5rem] tracking-tight">
          engenty<span className="text-ember">.</span>
          <span className="ml-1.5 font-normal text-ink-3">wizards</span>
        </div>
        <div className="mt-1 text-[0.9375rem] text-ink-3 tabular-nums">
          {t("about.version", { v: APP_VERSION })}
          {kind ? ` · ${t(`about.kind.${kind}`)}` : ""}
        </div>
      </div>

      {local ? (
        <div className="mt-5">
          <UpdateCheck enabled={open} />
        </div>
      ) : null}

      {/* One of the three at a time, sliding in from the side it stands on. */}
      <div className="mt-6 flex justify-center">
        <Tabs
          value={tab}
          onChange={setTab}
          options={TABS.map((id) => ({ id, label: label(id) }))}
          label={t("about.title")}
        />
      </div>
      <div key={tab} className={cn("mt-5", stepClass(step))}>
        {tab === "new" ? (
          releases === null ? (
            <div className="flex justify-center py-6 text-ink-3">
              <Spinner />
            </div>
          ) : newest ? (
            <>
              <h3 className="flex items-baseline gap-3 border-border-soft border-b pb-2 font-display font-semibold text-[1rem]">
                {releaseLabel(newest)}
                <span className="font-normal font-sans text-[0.8125rem] text-ink-3 tabular-nums">
                  {releaseDate(newest)}
                </span>
              </h3>
              <div className="mt-3">
                <ReleaseNotes release={newest} />
              </div>
            </>
          ) : (
            <p className="text-[0.875rem] text-ink-3">{t("about.changelogEmpty")}</p>
          )
        ) : null}
        {tab === "earlier" ? (
          <div className="flex flex-col divide-y divide-border-soft">
            {earlier.map((release) => (
              <details key={release.version ?? "unreleased"} className="group/r py-2">
                <summary className="flex cursor-pointer list-none items-baseline gap-3 text-[0.875rem] [&::-webkit-details-marker]:hidden">
                  <ChevronRight className="size-3.5 shrink-0 self-center text-ink-4 transition group-open/r:rotate-90" />
                  <span className="font-medium text-ink tabular-nums">{releaseLabel(release)}</span>
                  <span className="text-[0.8125rem] text-ink-3 tabular-nums">
                    {releaseDate(release)}
                  </span>
                  <span className="ml-auto text-[0.8125rem] text-ink-4">
                    {changes(release.commits.length)}
                  </span>
                </summary>
                <div className="mt-2 pl-6">
                  <ReleaseNotes release={release} />
                </div>
              </details>
            ))}
          </div>
        ) : null}
        {tab === "credits" ? <Credits active /> : null}
      </div>
    </Dialog>
  );
}
