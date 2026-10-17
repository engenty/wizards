import type { RunnerTable } from "@engenty-wizards/runner";
import { isLang } from "@engenty-wizards/shared/definition";
import type { PublicWizard, UiTexts } from "@engenty-wizards/shared/run";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { api } from "../lib/api";
import { showLang, t, viewerLang } from "../lib/i18n";
import { LangPill } from "../studio/LangSwitch";
import { cn } from "../ui";

/**
 * A wizard's page opens in the wizard's own language; where the viewer reads another, it offers
 * that one, translated on request (docs/plans/wizard-translation.md). The pick is kept in this
 * browser for every wizard.
 */
const PICK_KEY = "wizards.runner.translate";

const pickListeners = new Set<() => void>();

function readPick(): boolean {
  try {
    return localStorage.getItem(PICK_KEY) === "on";
  } catch {
    return false;
  }
}

function writePick(on: boolean) {
  try {
    localStorage.setItem(PICK_KEY, on ? "on" : "off");
  } catch {
    // the pick only lasts this page then
  }
  for (const listener of pickListeners) {
    listener();
  }
}

function usePick(): boolean {
  return useSyncExternalStore((listener) => {
    pickListeners.add(listener);
    return () => pickListeners.delete(listener);
  }, readPick);
}

export interface PageLanguage {
  /** The wizard's own language. */
  own: string;
  /** The viewer's language where the page offers it; null: no switch. */
  other: string | null;
  /** The language the page is in once ready. */
  shown: string;
  /** The wizard's texts in `shown` (the original where that is its own language). */
  wizard: PublicWizard;
  /** The translation is being made: the first viewer in a language waits a few seconds. */
  translating: boolean;
  /** Making it failed: the page stays in the original and says so. */
  failed: boolean;
  /** Read in another language than its own: "Machine-translated · Show original". */
  translated: boolean;
  machine: boolean;
  pick(code: string): void;
}

/** The language a wizard's page is in, with what it needs to speak it. */
export function usePageLanguage(wizard: PublicWizard | undefined): PageLanguage | null {
  const pickOn = usePick();
  const [viewer] = useState(() => viewerLang());
  const own = wizard?.lang ?? "en";
  const other = wizard?.translatable && viewer && viewer !== own ? viewer : null;
  const wanted = other && pickOn ? other : own;
  const token = wizard?.token;

  const texts = useQuery({
    queryKey: ["public-translation", token, wanted],
    enabled: Boolean(token && wanted !== own),
    queryFn: () =>
      api.post<PublicWizard>(`/api/public/wizards/${token}/translation`, { lang: wanted }),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  // The runner's own words, wherever the page's language is one engenty's strings lack: a
  // viewer's, or the language the wizard is written in.
  const words = useQuery({
    queryKey: ["public-texts", token, wanted],
    enabled: Boolean(token && !isLang(wanted)),
    queryFn: () => api.get<UiTexts>(`/api/public/wizards/${token}/texts/${wanted}`),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  const needsWords = !isLang(wanted);
  const ready = wanted === own || (texts.data && (!needsWords || words.data));
  const failed = wanted !== own && (texts.isError || (needsWords && words.isError));
  const shown = ready && !failed ? wanted : own;
  const table = useMemo<RunnerTable | null>(
    () =>
      !isLang(shown) && words.data?.lang === shown
        ? { lang: words.data.lang, runner: words.data.runner, notes: words.data.notes }
        : null,
    [shown, words.data],
  );

  useEffect(() => {
    if (!wizard) {
      return;
    }
    showLang(shown, table);
  }, [wizard, shown, table]);
  useEffect(() => () => showLang(null), []);

  if (!wizard) {
    return null;
  }
  const translated = shown !== own && texts.data ? texts.data : null;
  return {
    own,
    other,
    shown,
    wizard: translated ?? wizard,
    translating: wanted !== own && !ready && !failed,
    failed: Boolean(failed),
    translated: Boolean(translated),
    machine: translated?.translation?.machine ?? false,
    pick: (code) => writePick(code !== own),
  };
}

/** The two languages of a wizard's page: its own and the viewer's. Nothing where there is one. */
export function PageLangSwitch({
  page,
  tone = "ground",
}: {
  page: PageLanguage | null;
  tone?: "ground" | "surface";
}) {
  if (!page?.other) {
    return null;
  }
  // While the first translation is made the switch already stands on the language picked.
  const value = page.translating ? page.other : page.shown;
  return <LangPill langs={[page.own, page.other]} value={value} onPick={page.pick} tone={tone} />;
}

/** Under a translated page's title: who wrote it, and the way back to the original. */
export function TranslatedNote({ page, small }: { page: PageLanguage | null; small?: boolean }) {
  if (!page) {
    return null;
  }
  const size = small ? "truncate text-[0.75rem]" : "text-[0.8125rem]";
  if (page.failed) {
    return <p className={cn("text-ink-3", size)}>{t("translation.failed")}</p>;
  }
  if (!page.translated) {
    return null;
  }
  return (
    <p className={cn("text-ink-3", size)}>
      {page.machine ? <>{t("translation.machine")} · </> : null}
      <button
        type="button"
        className="underline-offset-4 hover:text-ink hover:underline coarse:min-h-11"
        onClick={() => page.pick(page.own)}
      >
        {t("translation.showOriginal")}
      </button>
    </p>
  );
}
