import { ArrowRight } from "lucide-react";
import { useState } from "react";
import { Mascot } from "../brand";
import { t, useLang } from "../lib/i18n";
import { keepWish, pendingWish, signIn } from "../lib/session";
import { useDictation } from "../lib/speech";
import { Button, DictationButton, Textarea } from "../ui";
import { DoorBar } from "./DoorBar";
import { MarketplaceBrowser } from "./Marketplace";

/**
 * The cloud studio for someone not signed in: the new-wizard page without what needs an account.
 * "Build" keeps the wish and signs in; the account's sign-in page shows the wish, and the
 * new-wizard page builds it once the person is in (NewWizardPage). A template signs in and
 * opens there.
 */
/** The site's legal pages, at the root of the studio's own origin (engenty.ai). */
const LEGAL = {
  de: { imprint: "/de/impressum", privacy: "/de/datenschutz", terms: "/de/nutzungsbedingungen" },
  en: { imprint: "/imprint", privacy: "/privacy", terms: "/terms" },
} as const;

export function GuestStartPage({ failed }: { failed: boolean }) {
  const lang = useLang();
  const [prompt, setPrompt] = useState(() => pendingWish() ?? "");
  const [busy, setBusy] = useState(false);
  // Without an account nothing is written down on the server: the browser's own recognition.
  const speech = useDictation(prompt, setPrompt, { endpoint: null });

  const submit = () => {
    const wish = prompt.trim();
    if (!wish || busy) {
      return;
    }
    if (speech.listening) {
      speech.stop();
    }
    setBusy(true);
    keepWish(wish);
    signIn("/new", wish);
  };

  return (
    <div className="min-h-dvh px-6 pb-16 sm:px-10">
      <DoorBar
        className="pt-6 sm:pt-8"
        end={
          <Button variant="secondary" size="sm" onClick={() => signIn("/")}>
            {t("guest.signIn")}
          </Button>
        }
      />
      <div className="mx-auto max-w-2xl animate-rise pt-8 md:pt-12">
        <div className="flex flex-col items-center text-center">
          <div className="size-[84px] md:size-auto">
            <div className="origin-top-left scale-[0.56] md:scale-100">
              <Mascot kind="sprout" size={150} fluffy />
            </div>
          </div>
          <h1 className="mt-1 font-display font-semibold text-[1.5rem] leading-tight tracking-tight md:mt-2 md:text-[2.375rem]">
            {t("new.title")}
          </h1>
        </div>
        <div className="relative mt-6 rounded-2xl bg-card p-2 shadow-elevated ring-1 ring-border-soft focus-within:ring-focus md:mt-8">
          <Textarea
            autoFocus
            minRows={4}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                submit();
              }
            }}
            placeholder={speech.listening ? t("editor.listening") : t("new.placeholder")}
            className="border-0 bg-transparent text-[1rem] shadow-none focus:ring-0"
          />
          <div className="flex items-center gap-2 px-1 pb-1">
            {speech.supported ? <DictationButton speech={speech} labelled /> : null}
            <span className="flex-1" />
            <Button size="md" onClick={submit} busy={busy} disabled={!prompt.trim()}>
              {t("new.build")} <ArrowRight className="size-4" />
            </Button>
          </div>
        </div>
        {speech.error ? (
          <p className="mt-2 px-3 text-[0.75rem] text-rose">
            {speech.error === "denied" ? t("editor.micDenied") : speech.error}
          </p>
        ) : null}
        {failed ? (
          <p className="mt-3 text-center text-[0.875rem] text-rose">{t("auth.failed")}</p>
        ) : null}
        <p className="mt-3 text-center text-[0.875rem] text-ink-3">{t("guest.hint")}</p>
      </div>

      <section className="mx-auto max-w-5xl">
        <h2 className="mt-16 mb-5 text-center font-medium text-[0.8125rem] text-ink-3 uppercase tracking-[0.08em]">
          {t("new.orStarter")}
        </h2>
        <MarketplaceBrowser
          onGuestOpen={(entry) => signIn(`/new?starter=${encodeURIComponent(entry.id)}`)}
        />
      </section>
      {/* As on the landing page: the name and the legal pages, nothing more. */}
      <footer className="mt-16 flex flex-wrap justify-center gap-x-5 gap-y-1 text-[0.75rem] text-ink-3">
        <span>engenty.wizards</span>
        {(["imprint", "privacy", "terms"] as const).map((page) => (
          <a key={page} href={LEGAL[lang][page]} className="transition hover:text-ink-2">
            {t(`legal.${page}`)}
          </a>
        ))}
      </footer>
    </div>
  );
}
