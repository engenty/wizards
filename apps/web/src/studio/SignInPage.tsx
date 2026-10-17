import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { APP_VERSION } from "../about/AboutLinks";
import { Mascot } from "../brand";
import { EngentyWordmark } from "../engenty/logo";
import { ApiError, api } from "../lib/api";
import { t } from "../lib/i18n";
import { signIn } from "../lib/session";
import { Button } from "../ui";
import { DoorBar } from "./DoorBar";
import { GuestStartPage } from "./GuestStartPage";

const SIGNED_IN = /(?:^|;\s*)engenty_signed_in=1(?:;|$)/;

function hasDesktop() {
  return Boolean((window as { engentyDesktop?: unknown }).engentyDesktop);
}

/**
 * The studio's front door. A runtime of a Manage-App sends the person there to sign in (or to
 * create an account); a runtime that runs alone is entered through the link it printed at start.
 * Where the dev login is the only way in, there is nothing to choose: the door opens by itself.
 */
/** A text one sentence per line: a line never breaks after a sentence's first word. */
function Sentences({ text }: { text: string }) {
  return text.split(/(?<=[.!?])\s+/).map((sentence) => (
    <span key={sentence} className="block">
      {sentence}
    </span>
  ));
}

/** Why the studio does not open here, and what helps. */
function Note({
  title,
  children,
  className = "mt-8",
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`${className} w-full rounded-xl bg-card px-5 py-4 text-left text-[0.875rem] text-ink-2 leading-relaxed shadow-soft ring-1 ring-border-soft`}
    >
      <div className="mb-1.5 font-medium text-ink">{title}</div>
      {children}
    </div>
  );
}

export function SignInPage() {
  const config = useQuery({
    queryKey: ["config"],
    queryFn: () => api.get<{ mode: "managed" | "local"; devLogin: boolean }>("/api/config"),
    // A runtime that restarts answers again in a moment: the page asks until it does.
    refetchInterval: (query) =>
      query.state.status === "error" &&
      !(query.state.error instanceof ApiError && query.state.error.body?.code === "host")
        ? 2000
        : false,
    retry: false,
  });
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const failed = new URLSearchParams(window.location.search).get("signin") === "failed";
  const auto = config.data?.mode === "local" && config.data.devLogin;
  const [autoFailed, setAutoFailed] = useState(false);
  // Someone signed in at the Manage-App (its cookie for the site, `engenty_signed_in`) but not
  // yet here: the sign-in goes through without a question, so it starts by itself. Everyone
  // else sees this page, on the start page as on any other.
  const account =
    config.data?.mode === "managed" && !failed && !hasDesktop() && SIGNED_IN.test(document.cookie);

  useEffect(() => {
    if (account) {
      signIn();
    }
  }, [account]);

  useEffect(() => {
    if (!auto || autoFailed) {
      return;
    }
    let alive = true;
    api
      .post("/api/dev/login")
      .then(() => qc.invalidateQueries())
      .catch(() => {
        if (alive) {
          setAutoFailed(true);
        }
      });
    return () => {
      alive = false;
    };
  }, [auto, autoFailed, qc]);

  // Nothing to decide yet, or nothing to decide at all: the engenty alone, until the studio is there.
  if (config.isLoading || account || (auto && !autoFailed)) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Mascot kind="round" size={56} />
      </div>
    );
  }

  // Someone not signed in, in a browser, on the cloud studio: the start page, where a wish can
  // be typed before signing in. The desktop app and the dev login keep the door.
  if (config.data?.mode === "managed" && !config.data.devLogin && !hasDesktop()) {
    return <GuestStartPage failed={failed} />;
  }

  const local = config.data?.mode === "local" && !config.data.devLogin;
  // Opened under a name the app does not answer to (127.0.0.1 for localhost, the machine's IP).
  const refusal =
    config.error instanceof ApiError && config.error.body?.code === "host" ? config.error : null;
  const ownAddress = refusal ? String(refusal.body.appUrl ?? "") : null;
  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center px-6 py-16">
      <DoorBar className="absolute inset-x-6 top-6 sm:inset-x-10 sm:top-8" />
      <div className="flex w-full max-w-md animate-rise flex-col items-center text-center">
        <Mascot kind="round" size={local || config.isError ? 140 : 200} fluffy />
        {/* The product's whole name: "wizards" alone is other companies' too. */}
        <span className="mt-2 font-display font-semibold text-[0.9375rem] text-ink-3 tracking-tight">
          <EngentyWordmark />
          <span className="font-normal">wizards</span>
        </span>
        <h1 className="mt-3 text-balance font-display font-semibold text-[2.125rem] leading-[1.1] tracking-tight">
          <Sentences text={t("brand.tagline")} />
        </h1>
        <p className="mt-4 text-balance text-[1rem] text-ink-2 leading-relaxed">
          <Sentences text={t("brand.sub")} />
        </p>
        {ownAddress ? (
          <Note title={t("auth.wrongHost")}>
            <p>{t("auth.wrongHostWhy")}</p>
            <a
              href={`${ownAddress}${window.location.pathname}`}
              className="mt-1.5 block break-all font-medium text-ember-strong underline-offset-2 hover:underline"
            >
              {ownAddress}
            </a>
          </Note>
        ) : config.isError ? (
          <Note title={t("auth.unreachable")}>
            {t("auth.unreachableWhy", { address: window.location.host })}
          </Note>
        ) : null}
        <div className="mt-10 flex w-full flex-col gap-3">
          {failed ? <p className="text-[0.875rem] text-rose">{t("auth.failed")}</p> : null}
          {config.data?.mode === "managed" ? (
            <Button
              size="lg"
              busy={busy}
              className="w-full"
              onClick={async () => {
                setBusy(true);
                const desktop = (window as { engentyDesktop?: { open(url: string): void } })
                  .engentyDesktop;
                if (!desktop) {
                  // Back to the studio page that asked: the host's root is the landing page.
                  signIn();
                  return;
                }
                // In the desktop app the sign-in runs in the person's own browser and comes
                // back to this window as a link.
                const { url } = await api.post<{ url: string }>("/api/auth/desktop/start");
                desktop.open(url);
                setWaiting(true);
                setBusy(false);
              }}
            >
              {waiting ? t("local.accountWaiting") : t("auth.signIn")}
            </Button>
          ) : null}
          {config.data?.devLogin ? (
            <Button
              size="lg"
              busy={busy}
              className="w-full"
              onClick={async () => {
                setBusy(true);
                await api.post("/api/dev/login");
                await qc.invalidateQueries();
                setBusy(false);
              }}
            >
              {t("auth.dev")}
            </Button>
          ) : null}
          {local ? (
            <Note title={t("auth.localTitle")} className="-mt-2">
              <p>{t("auth.localWhy")}</p>
              <p className="mt-3">{t("auth.localLink")}</p>
              <code className="mt-1.5 block select-all rounded-lg bg-paper-2 px-3 py-2 font-mono text-[0.8125rem] text-ink">
                wizards open
              </code>
              <p className="mt-3 text-ink-3">{t("auth.localStartLink")}</p>
              <code className="mt-1.5 block select-all rounded-lg bg-paper-2 px-3 py-2 font-mono text-[0.8125rem] text-ink">
                wizards open --print
              </code>
            </Note>
          ) : null}
        </div>
        {config.data?.mode === "managed" ? (
          <p className="mt-6 text-[0.8125rem] text-ink-3">{t("auth.legal")}</p>
        ) : null}
      </div>
      <footer className="absolute inset-x-0 bottom-6 text-center text-[0.75rem] text-ink-3 sm:bottom-8">
        © engenty · {t("about.version", { v: APP_VERSION })}
      </footer>
    </div>
  );
}
