import type { BrandView, PublicWizard } from "@engenty-wizards/shared/run";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Bookmark, Smartphone, SquarePlus, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router";
import { BASE, withBase } from "@/lib/base";
import { BRAND, Mascot, ThemeToggle } from "../brand";
import { api, isOffline } from "../lib/api";
import { appLink, appTell, IN_APP } from "../lib/app";
import { closeEmbed, EMBED, EMBED_PAGE, useEmbed } from "../lib/embed";
import { t } from "../lib/i18n";
import { useStage } from "../lib/theme";
import { Button, cn, IconButton, Spinner } from "../ui";
import {
  ChatBody,
  ChatShell,
  Idle,
  type Line,
  Reply,
  replies,
  Thread,
  useVoiceState,
} from "./ChatView";
import { RunnerBody } from "./RunnerView";
import { PageLangSwitch, type PageLanguage, TranslatedNote, usePageLanguage } from "./translation";

/**
 * A run follows the page's language: switched during a run, the steps from then on speak it
 * (what is already made stays as it is); opened in another language, the run is told once.
 */
function useRunLang(runId: string | undefined, page: PageLanguage | null) {
  const told = useRef<string | null>(null);
  const lang = page && !page.translating ? (page.translated ? page.shown : null) : undefined;
  useEffect(() => {
    if (!runId || lang === undefined) {
      return;
    }
    const key = `${runId}:${lang}`;
    if (told.current === key) {
      return;
    }
    told.current = key;
    void api.post(`/api/runs/${runId}/lang`, { lang }).catch(() => undefined);
  }, [runId, lang]);
}

import { useRunTheme } from "./theme";

/**
 * A wizard's link is an app of its own: the browser's "add to home screen" then installs this
 * wizard — its name, its start address, its engenty as the icon — not the studio. A bookmark
 * keeps the engenty as its favicon.
 */
function useWizardApp(token: string | undefined, title: string | undefined) {
  useEffect(() => {
    if (!token || !title) {
      return;
    }
    const own = withBase(`/api/public/wizards/${token}`);
    const swaps = [
      { rel: "manifest", href: `${own}/manifest.webmanifest` },
      { rel: "apple-touch-icon", href: `${own}/icons/apple-touch-icon.png` },
      { rel: "icon", href: `${own}/icons/favicon.png`, type: "image/png" },
    ].flatMap(({ rel, href, type }) => {
      const link = document.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
      if (!link) {
        return [];
      }
      const before = { href: link.getAttribute("href"), type: link.getAttribute("type") };
      link.setAttribute("href", href);
      if (type) {
        link.setAttribute("type", type);
      }
      return [{ link, before }];
    });
    const name = document.createElement("meta");
    name.name = "apple-mobile-web-app-title";
    name.content = title;
    document.head.appendChild(name);
    return () => {
      for (const { link, before } of swaps) {
        for (const [attr, value] of Object.entries(before)) {
          if (value === null) {
            link.removeAttribute(attr);
          } else {
            link.setAttribute(attr, value);
          }
        }
      }
      name.remove();
    };
  }, [token, title]);
}

interface InstallPrompt extends Event {
  prompt(): Promise<unknown>;
}

declare global {
  interface Window {
    /** Chrome's offer to install, kept by the page's first script until the person asks for it. */
    wizardInstall?: InstallPrompt | null;
  }
}

/** iPadOS calls itself a Mac; its touch screen gives it away. */
const IOS =
  /iPhone|iPad|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const PHONE = IOS || /Android/.test(navigator.userAgent);

/**
 * On a phone "add to home screen", where the browser offers it, on an iPhone the way through the
 * share menu. On a computer a bookmark: a wizard is rarely worth a window of its own there.
 */
function InstallHint() {
  const [prompt, setPrompt] = useState(() => window.wizardInstall ?? null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const update = () => setPrompt(window.wizardInstall ?? null);
    window.addEventListener("wizard-install", update);
    return () => window.removeEventListener("wizard-install", update);
  }, []);
  const standalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as { standalone?: boolean }).standalone === true;
  if (standalone || (PHONE && !prompt && !IOS)) {
    return null;
  }
  const mac = /Mac/.test(navigator.platform);
  const hint = PHONE ? t("install.ios") : t(mac ? "install.bookmark.mac" : "install.bookmark.pc");
  return (
    <div className="mt-6 flex flex-col items-center gap-2 text-[0.8125rem] text-ink-3">
      <button
        type="button"
        onClick={() => {
          if (PHONE && prompt) {
            void prompt.prompt();
            window.wizardInstall = null;
            setPrompt(null);
          } else {
            setShown((s) => !s);
          }
        }}
        className="inline-flex items-center gap-1.5 underline-offset-4 hover:text-ink hover:underline coarse:min-h-11"
      >
        {PHONE ? <SquarePlus className="size-4" /> : <Bookmark className="size-4" />}
        {t(PHONE ? "install.add" : "install.bookmark")}
      </button>
      {shown ? <p className="max-w-xs leading-relaxed">{hint}</p> : null}
    </div>
  );
}

export function BrandHeader({
  brand,
  toggle = true,
  start,
}: {
  brand: BrandView;
  toggle?: boolean;
  /** What stands at the left: the language switch of a wizard's page. */
  start?: ReactNode;
}) {
  return (
    <header className="safe-top">
      <div className="relative flex h-14 items-center justify-center px-5">
        {start ? <div className="absolute left-3">{start}</div> : null}
        {brand.logoUrl ? (
          <img
            src={withBase(brand.logoUrl)}
            alt={brand.name}
            className="h-7 max-w-[160px] object-contain"
          />
        ) : brand.name ? (
          <span className="max-w-[60%] truncate font-display font-semibold text-[0.9375rem] text-ink-2 tracking-tight">
            {brand.name}
          </span>
        ) : null}
        {toggle ? (
          <div className="absolute right-3">
            <ThemeToggle />
          </div>
        ) : null}
      </div>
    </header>
  );
}

declare global {
  interface Window {
    turnstile?: {
      render: (
        el: HTMLElement,
        opts: { sitekey: string; callback: (token: string) => void; appearance?: string },
      ) => string;
    };
  }
}

function Turnstile({ siteKey, onToken }: { siteKey: string; onToken: (t: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const mount = () => {
      if (ref.current && window.turnstile && !ref.current.childElementCount) {
        window.turnstile.render(ref.current, {
          sitekey: siteKey,
          callback: onToken,
          appearance: "interaction-only",
        });
      }
    };
    if (window.turnstile) {
      mount();
      return;
    }
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
    script.async = true;
    script.onload = mount;
    document.head.appendChild(script);
  }, [siteKey, onToken]);
  return <div ref={ref} className="mt-4 flex justify-center" />;
}

/**
 * On a phone's browser: open the wizard in the mobile app instead. The phone's camera already
 * opens engenty.ai links there; this is for a runtime on another host, whose links it does not know.
 */
function OpenInApp({ token }: { token: string }) {
  const phone = /iPhone|iPad|iPod|Android/.test(navigator.userAgent);
  if (!phone || IN_APP || EMBED) {
    return null;
  }
  return (
    <a
      href={appLink(`${window.location.origin}${BASE}/w/${token}`)}
      className="mt-3 inline-flex items-center gap-1.5 text-[0.8125rem] text-ink-3 underline-offset-4 hover:text-ink hover:underline coarse:min-h-11"
    >
      <Smartphone className="size-4" /> {t("install.app")}
    </a>
  );
}

const lastRunKey = (token: string) => `wz.run.${token}`;

/** The app opens `/w/<token>?app=1&start=1` from its own start button: the run starts at once. */
const AUTOSTART = IN_APP && new URLSearchParams(window.location.search).get("start") === "1";

/** Inline in another website the wizard is as tall as its content; everywhere else it fills the screen. */
const PAGE = EMBED === "inline" ? "min-h-80" : "min-h-dvh";

/**
 * Starting a run of the wizard, or going back to the last one this browser had. `home` is the
 * runner's address: `/w/<token>` or `/w/<token>/chat`.
 */
function useStartRun(wizard: PublicWizard, home: string, lang?: string | null) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [captcha, setCaptcha] = useState<string | null>(null);
  const previous = (() => {
    try {
      return localStorage.getItem(lastRunKey(wizard.token));
    } catch {
      return null;
    }
  })();
  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const { runId } = await api.post<{ runId: string }>(
        `/api/public/wizards/${wizard.token}/runs`,
        {
          turnstileToken: captcha ?? undefined,
          embedded: EMBED !== null,
          origin: EMBED_PAGE ?? undefined,
          lang: lang ?? undefined,
        },
      );
      try {
        localStorage.setItem(lastRunKey(wizard.token), runId);
      } catch {
        // resuming is a convenience
      }
      navigate(`${home}/${runId}`, { replace: AUTOSTART });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  const resume = previous ? () => navigate(`${home}/${previous}`) : null;
  return { busy, error, captcha, setCaptcha, start, resume };
}

function StartScreen({ wizard, page }: { wizard: PublicWizard; page: PageLanguage | null }) {
  const { busy, error, captcha, setCaptcha, start, resume } = useStartRun(
    wizard,
    `/w/${wizard.token}`,
    page?.translated ? page.shown : null,
  );
  const auto = AUTOSTART && wizard.available && !wizard.turnstileSiteKey;
  const started = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on the app's start button
  useEffect(() => {
    if (auto && !started.current) {
      started.current = true;
      void start();
    }
  }, [auto]);
  if (auto && !error) {
    return (
      <div className="flex min-h-[60dvh] items-center justify-center text-ink-4">
        <Spinner />
      </div>
    );
  }
  return (
    <div className="mx-auto flex max-w-lg animate-rise flex-col items-center px-6 pt-6 pb-12 text-center sm:pt-16 sm:pb-16">
      <Mascot kind={wizard.avatar} size={190} fluffy />
      <h1 className="mt-2 text-balance font-display font-semibold text-[1.875rem] leading-[1.1] tracking-tight sm:text-[2.125rem]">
        {wizard.title}
      </h1>
      {wizard.description ? (
        <p className="mt-3 text-[1rem] text-ink-2 leading-relaxed">{wizard.description}</p>
      ) : null}
      <div className="mt-3">
        <TranslatedNote page={page} />
      </div>
      {wizard.available ? (
        <>
          <Button
            size="lg"
            className="mt-10 min-w-48"
            busy={busy}
            disabled={Boolean(wizard.turnstileSiteKey) && !captcha}
            onClick={start}
          >
            {t("run.start")} <ArrowRight className="size-4" />
          </Button>
          {wizard.turnstileSiteKey ? (
            <Turnstile siteKey={wizard.turnstileSiteKey} onToken={setCaptcha} />
          ) : null}
          {resume ? (
            <button
              type="button"
              onClick={resume}
              className="mt-4 text-[0.875rem] text-ink-3 underline-offset-4 hover:text-ink hover:underline coarse:min-h-11"
            >
              {t("run.resume")}
            </button>
          ) : null}
          <OtherRunners wizard={wizard} current="steps" />
          {EMBED || IN_APP ? null : <InstallHint />}
          <OpenInApp token={wizard.token} />
        </>
      ) : (
        <p className="mt-10 rounded-xl bg-paper-2 px-5 py-4 text-[0.9375rem] text-ink-2">
          {wizard.unavailableReason ?? t("run.unavailable")}
        </p>
      )}
      {error ? <p className="mt-4 text-[0.875rem] text-rose">{error}</p> : null}
    </div>
  );
}

/** The other ways the wizard is offered, under the start button: a link each. */
function OtherRunners({ wizard, current }: { wizard: PublicWizard; current: string }) {
  const others = wizard.runners.filter((r) => r.id !== current && r.kind === "page" && r.url);
  if (!others.length) {
    return null;
  }
  return (
    <p className="mt-4 flex flex-wrap justify-center gap-x-4 text-[0.875rem] text-ink-3">
      {others.map((r) => (
        <a
          key={r.id}
          href={r.url ?? undefined}
          className="underline-offset-4 hover:text-ink hover:underline coarse:min-h-11"
        >
          {t("run.orAs", { label: r.label })}
        </a>
      ))}
    </p>
  );
}

/** The chat's top: the wizard that talks, and in a popout the way to fold it away. */
function ChatHeader({ wizard, page }: { wizard: PublicWizard; page: PageLanguage | null }) {
  const voice = useVoiceState();
  return (
    <header className="safe-top shrink-0 border-border-soft border-b">
      <div className="mx-auto flex h-16 w-full max-w-[760px] items-center gap-3 pr-2 pl-4 sm:pr-4 sm:pl-6">
        <span className={cn(voice?.speaking && "animate-breathe")}>
          <Mascot kind={wizard.avatar} size={38} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-display font-semibold text-[1rem] leading-tight tracking-tight">
            {wizard.title}
          </div>
          {wizard.brand.name ? (
            <div className="truncate text-[0.75rem] text-ink-3">{wizard.brand.name}</div>
          ) : null}
          <TranslatedNote page={page} small />
        </div>
        {wizard.brand.logoUrl && EMBED !== "popout" ? (
          <img
            src={withBase(wizard.brand.logoUrl)}
            alt={wizard.brand.name}
            className="h-6 max-w-[120px] object-contain max-sm:hidden"
          />
        ) : null}
        <PageLangSwitch page={page} tone="surface" />
        {EMBED ? null : <ThemeToggle />}
        {EMBED === "popout" ? (
          <IconButton label={t("common.close")} onClick={closeEmbed}>
            <X className="size-5" />
          </IconButton>
        ) : null}
      </div>
    </header>
  );
}

/** Before a run: the wizard says what it does, the person starts with a tap. */
function ChatStart({
  door,
  wizard,
  page,
  header,
  footer,
}: {
  /** The address a run opens at: the chat, the conversation first, or the call screen. */
  door: "chat" | "talk" | "video";
  wizard: PublicWizard;
  page: PageLanguage | null;
  header: ReactNode;
  footer: ReactNode;
}) {
  const { busy, error, captcha, setCaptcha, start, resume } = useStartRun(
    wizard,
    `/w/${wizard.token}/${door}`,
    page?.translated ? page.shown : null,
  );
  const lines: Line[] = [{ key: "hello", who: "bot", node: wizard.description || wizard.title }];
  if (door !== "chat") {
    lines.push({
      key: door,
      who: "bot",
      node: t(door === "video" ? "video.hint" : "talk.joinHint"),
    });
  }
  if (!wizard.available) {
    lines.push({
      key: "unavailable",
      who: "bot",
      node: wizard.unavailableReason ?? t("run.unavailable"),
    });
  }
  if (error) {
    lines.push({ key: "error", who: "bot", node: error, tone: "error" });
  }
  if (wizard.available) {
    lines.push(
      replies(
        "start",
        <>
          <Reply
            primary
            busy={busy}
            disabled={Boolean(wizard.turnstileSiteKey) && !captcha}
            onClick={() => void start()}
          >
            {t("run.start")} <ArrowRight className="size-4" />
          </Reply>
          {resume ? <Reply onClick={resume}>{t("run.resume")}</Reply> : null}
          {wizard.turnstileSiteKey ? (
            <Turnstile siteKey={wizard.turnstileSiteKey} onToken={setCaptcha} />
          ) : null}
        </>,
      ),
    );
  }
  return (
    <ChatShell header={header} footer={footer}>
      <Thread avatar={wizard.avatar} lines={lines} />
      <Idle />
    </ChatShell>
  );
}

/** Under the chat's composer, small. */
function MadeWith({ className }: { className?: string }) {
  return (
    <footer className={cn("text-center text-ink-4", className)}>
      <a
        href={`${BASE}/`}
        target={EMBED ? "_blank" : undefined}
        rel="noreferrer"
        className="inline-block hover:text-ink-2"
      >
        {t("run.madeWith").replace("engenty wizards", BRAND.name)}
      </a>
    </footer>
  );
}

/**
 * A wizard's public page. Its link opens the runner the owner made the default; beside it,
 * `/w/<token>/steps` and `/w/<token>/chat` open the one named, where it is switched on.
 */
export function PublicRunner({
  chat: chatPath = false,
  steps: stepsPath = false,
  talk = false,
  video = false,
}: {
  chat?: boolean;
  steps?: boolean;
  /** The chat with a live conversation offered first: `/w/<token>/talk`. */
  talk?: boolean;
  /** The call screen, the chat beside it: `/w/<token>/video`. */
  video?: boolean;
}) {
  const { token, runId } = useParams();
  const navigate = useNavigate();
  const wizard = useQuery({
    queryKey: ["public", token],
    queryFn: () => api.get<PublicWizard>(`/api/public/wizards/${token}`),
    // A wizard that is gone stays gone; a phone without signal gets a few more tries.
    retry: (count, err) => isOffline(err) && count < 3,
  });
  const runners = wizard.data?.runners ?? [];
  const talkOn = !wizard.data || runners.some((r) => r.id === "talk");
  const videoOn = !wizard.data || runners.some((r) => r.id === "video");
  const chatOn =
    !wizard.data || runners.some((r) => r.id === "chat") || (talk && talkOn) || (video && videoOn);
  const first = runners[0]?.id;
  // A popout in a website is always a chat; the bare link opens the default runner.
  const chat =
    chatPath ||
    EMBED === "popout" ||
    (!stepsPath && !runId && chatOn && (first === "chat" || first === "talk" || first === "video"));
  // The call screen at /video, and on the link when it is the default.
  const calling = (video && videoOn) || (!stepsPath && !chatPath && !talk && first === "video");
  // The conversation is offered first at /talk, and on the link when it is the default.
  const talking = !calling && ((talk && talkOn) || (!stepsPath && !chatPath && first === "talk"));
  const door = calling ? "video" : talking ? "talk" : "chat";
  const page = usePageLanguage(wizard.data);
  useRunLang(runId, page);
  useRunTheme(wizard.data?.brand.theme);
  useStage(wizard.data?.avatar);
  useWizardApp(token, wizard.data?.title);
  useEmbed(chat);
  const title = page?.wizard.title ?? wizard.data?.title;
  useEffect(() => {
    if (title) {
      document.title = title;
    }
  }, [title]);
  // The app keeps every run it saw in its results, also one started or resumed in here.
  useEffect(() => {
    if (token && runId) {
      appTell("run", { token, runId });
    }
  }, [token, runId]);

  if (wizard.isLoading) {
    return (
      <div className={cn("flex items-center justify-center text-ink-4", PAGE)}>
        <Spinner />
      </div>
    );
  }
  // The chat's address for a wizard that does not offer the chat: the link itself answers.
  if (chatPath && wizard.data && !chatOn) {
    return <Navigate to={`/w/${token}`} replace />;
  }
  if (talk && wizard.data && !talkOn) {
    return <Navigate to={`/w/${token}`} replace />;
  }
  if (video && wizard.data && !videoOn) {
    return <Navigate to={`/w/${token}`} replace />;
  }
  if (!wizard.data) {
    const offline = isOffline(wizard.error);
    return (
      <div className={cn("flex flex-col items-center justify-center gap-4 px-6 text-center", PAGE)}>
        <Mascot kind="pebble" size={80} />
        <p className="max-w-xs text-ink-3">{t(offline ? "common.offline" : "run.notFound")}</p>
        {offline ? (
          <Button variant="secondary" onClick={() => void wizard.refetch()}>
            {t("common.retry")}
          </Button>
        ) : null}
      </div>
    );
  }
  const shown = page?.wizard ?? wizard.data;
  // The first viewer in a language waits while it is translated.
  const translating = page?.translating ? (
    <div className={cn("flex flex-col items-center justify-center gap-3 text-ink-3", PAGE)}>
      <Spinner />
      <p className="text-[0.875rem]">{t("translation.working")}</p>
    </div>
  ) : null;
  if (chat) {
    const header = <ChatHeader wizard={shown} page={page} />;
    const footer = IN_APP ? (
      <div className="safe-bottom" />
    ) : (
      <MadeWith className="pb-[max(0.375rem,env(safe-area-inset-bottom))] text-[0.6875rem]" />
    );
    return (
      <div className="flex h-dvh flex-col">
        {translating ??
          (runId ? (
            <ChatBody
              runId={runId}
              talk={talking}
              call={calling ? "video" : talking ? "audio" : false}
              onRestart={() => navigate(`/w/${token}/${door}`)}
              // A call's stage names the wizard itself.
              header={calling || talking ? undefined : header}
              footer={footer}
            />
          ) : (
            <ChatStart wizard={shown} page={page} header={header} footer={footer} door={door} />
          ))}
      </div>
    );
  }
  return (
    <div className={cn("flex flex-col", PAGE)}>
      {/* The website around an inline wizard carries the brand; in the window its close button takes the corner. */}
      {/* In the app its own top bar names the wizard. */}
      {EMBED === "inline" || IN_APP ? null : (
        <BrandHeader
          brand={wizard.data.brand}
          toggle={!EMBED}
          start={<PageLangSwitch page={page} />}
        />
      )}
      {EMBED === "inline" || IN_APP ? (
        <div className="flex justify-end px-3 pt-2">
          <PageLangSwitch page={page} tone="surface" />
        </div>
      ) : null}
      {runId && (page?.translated || page?.failed) ? (
        <div className="flex justify-center px-5">
          <TranslatedNote page={page} />
        </div>
      ) : null}
      <div className="flex-1">
        {translating ??
          (runId ? (
            <RunnerBody runId={runId} onRestart={() => navigate(`/w/${token}`)} />
          ) : (
            <StartScreen wizard={shown} page={page} />
          ))}
      </div>
      {IN_APP ? (
        <div className="safe-bottom" />
      ) : (
        <footer className="safe-bottom pt-6 text-center text-[0.75rem] text-ink-4">
          <a
            href={`${BASE}/`}
            // In a frame the link would load the studio into the website.
            target={EMBED ? "_blank" : undefined}
            rel="noreferrer"
            className="inline-block py-3.5 hover:text-ink-2"
          >
            {t("run.madeWith").replace("engenty wizards", BRAND.name)}
          </a>
        </footer>
      )}
    </div>
  );
}
