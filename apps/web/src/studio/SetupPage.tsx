import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Check, Cloud, RefreshCw } from "lucide-react";
import { type CSSProperties, useState } from "react";
import { useNavigate } from "react-router";
import { Mascot } from "../brand";
import { EngentyLogoMark } from "../engenty/logo";
import { api } from "../lib/api";
import { useConfig, useFeature } from "../lib/features";
import { lang, t } from "../lib/i18n";
import {
  type AppleStatus,
  type HarnessStatus,
  type LocalModels,
  useCurrentProject,
  useMe,
  withoutApple,
} from "../lib/session";
import { useGround, usePreferredTheme } from "../lib/theme";
import { Button, cn } from "../ui";
import { LinkStatus, useAccountLink } from "./Account";
import { HarnessPanel, ModelTest } from "./Harness";
import { LangSwitch } from "./LangSwitch";
import { OwnModels, openExternal } from "./LocalRuntime";
import { ThemeSwitch } from "./ThemeSwitch";

type Source = LocalModels["source"];
/** What the setup offers: a source, or Apple Intelligence — the short classes bound on this Mac. */
type Pick = Source | "apple";

/** The ground the setup stands on and the text on white, as on the landing page. */
const GROUND = "oklch(50% 0.2 262)";
const GROUND_INK = "oklch(32% 0.15 262)";
const CREAM = "oklch(90% 0.1 80)";

/** A step of the setup by its state: reached, the one to do now, still ahead. */
const STEP_DONE = "var(--step-done)";
const STEP_NOW = "var(--step-now)";
const STEP_LATER = "color-mix(in oklab, var(--on) 38%, transparent)";

/**
 * The page's own colours. Dark: on the vivid ground, white on it, and secondary text, checks and
 * errors a step brighter than the dark theme's. Light: on the theme's paper, the ground's blue
 * marks the pick.
 */
const ON_GROUND = {
  "--on": "white",
  "--tile": "rgb(255 255 255 / 0.1)",
  "--tile-hover": "rgb(255 255 255 / 0.15)",
  "--tile-ring": "rgb(255 255 255 / 0.15)",
  "--panel": "rgb(255 255 255 / 0.07)",
  "--panel-ring": "rgb(255 255 255 / 0.12)",
  "--pick": "white",
  "--pick-ink": GROUND_INK,
  "--pick-mark": GROUND_INK,
  "--dot": CREAM,
  "--step-done": "oklch(88% 0.17 150)",
  "--step-now": "oklch(88% 0.14 80)",
  "--ready-ink": "oklch(27% 0.09 150)",
  "--ink-2": "oklch(96% 0.02 262)",
  "--ink-3": "oklch(90% 0.035 262)",
  "--ink-4": "oklch(82% 0.05 262)",
  "--moss": "oklch(90% 0.14 150)",
  "--rose": "oklch(89% 0.09 45)",
} as CSSProperties;
const ON_PAPER = {
  "--on": "var(--ink)",
  "--tile": "var(--card)",
  "--tile-hover": "var(--paper-2)",
  "--tile-ring": "var(--border-soft)",
  "--panel": "var(--card)",
  "--panel-ring": "var(--border-soft)",
  "--pick": GROUND,
  "--pick-ink": "white",
  "--pick-mark": "white",
  "--dot": GROUND,
  "--step-done": "oklch(52% 0.15 150)",
  "--step-now": "oklch(60% 0.15 65)",
  "--ready-ink": "white",
} as CSSProperties;

const EASE = "ease-[cubic-bezier(0.3,0.7,0.2,1)]";

/** The host of the start, beside the choices; on a narrow page it is scaled down. */
const HOST = 220;

/** Each choice has a host of its own: a new choice brings a new face along with its content. */
const HOSTS: Record<Pick, string> = {
  codex: "dome",
  claude: "oval",
  antigravity: "wedge",
  cursor: "sprout",
  own: "bean",
  account: "drop",
  apple: "pebble",
};

/** What the Apple choice says at its end: ready, or why it waits. */
function appleNote(apple: AppleStatus): string {
  if (apple.available) {
    return t("models.optAppleNote");
  }
  switch (apple.reason) {
    case "off":
      return t("models.appleOff");
    case "loading":
      return t("models.appleLoading");
    default:
      return t("models.appleDevice");
  }
}

/**
 * A line of the list's heading: as wide as its text and shifted, not laid out, to the middle —
 * so it keeps the column's full width and can travel to the left edge.
 */
const LINE =
  "relative w-fit max-w-full transition-[left,translate] duration-700 ease-[cubic-bezier(0.3,0.7,0.2,1)] motion-reduce:transition-none";
const LINE_MIDDLE = "left-1/2 -translate-x-1/2 text-center";
/** Beside an opened choice the lines stand at the left edge; on a narrow page the list is alone again and they stay in the middle. */
const LINE_LEFT =
  "max-lg:left-1/2 max-lg:-translate-x-1/2 max-lg:text-center lg:left-0 lg:translate-x-0 lg:text-left";

/** On a narrow page the choices and the opened choice take turns; each starts at the top. */
function toTop() {
  if (window.matchMedia("(max-width: 1023px)").matches) {
    window.scrollTo({ top: 0 });
  }
}

/** "Own keys" has no trace on the server until a key is saved; the tab remembers the pick. */
const OWN_PICKED = "wizards.setup.own";

function ownPicked(): boolean {
  try {
    return sessionStorage.getItem(OWN_PICKED) === "1";
  } catch {
    return false;
  }
}

function rememberOwn(own: boolean) {
  try {
    if (own) {
      sessionStorage.setItem(OWN_PICKED, "1");
    } else {
      sessionStorage.removeItem(OWN_PICKED);
    }
  } catch {
    // the pick only lasts this page then
  }
}

function Wordmark() {
  return (
    <span className="inline-flex items-center gap-2.5">
      <EngentyLogoMark size={28} />
      <span className="font-display font-semibold text-[1.0625rem] tracking-tight">
        engenty
        <span className="mr-[0.09em] ml-[0.06em] text-(color:--dot)">.</span>
        <span className="font-normal text-(color:--on)/70">wizards</span>
      </span>
    </span>
  );
}

function Choice({
  selected,
  title,
  description,
  badge,
  note,
  onPick,
}: {
  selected: boolean;
  title: string;
  description: string;
  /** Set on the row's edge: the choice the setup recommends. */
  badge?: string;
  /** How the choice stands right now, at the row's end. */
  note?: string;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={selected}
      className={cn(
        "group relative flex w-full items-center gap-3 rounded-2xl px-4 py-3 text-left transition-[background-color,color,box-shadow] duration-300",
        selected
          ? "bg-(color:--pick) text-(color:--pick-ink) shadow-elevated"
          : "bg-(color:--tile) ring-(color:--tile-ring) ring-1 hover:bg-(color:--tile-hover)",
      )}
    >
      {badge ? (
        <span
          className="absolute -top-2.5 right-4 rounded-full px-2.5 py-[3px] font-semibold text-[0.6875rem] leading-none tracking-wide shadow-[0_2px_8px_oklch(0%_0_0/0.22)]"
          style={{ background: CREAM, color: GROUND_INK }}
        >
          {badge}
        </span>
      ) : null}
      <span
        className={cn(
          "flex size-5 shrink-0 items-center justify-center rounded-full border transition-colors duration-300",
          selected ? "border-transparent bg-(color:--pick-mark)" : "border-(color:--on)/40",
        )}
      >
        {selected ? <Check className="size-3.5 text-(color:--pick)" /> : null}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-medium text-[0.9375rem]">{title}</span>
        <span
          className={cn(
            "mt-0.5 block truncate text-[0.8125rem]",
            selected ? "opacity-70" : "text-(color:--on)/65",
          )}
        >
          {description}
        </span>
      </span>
      {note ? (
        <span
          className={cn(
            "shrink-0 text-[0.75rem]",
            selected ? "opacity-70" : "text-(color:--on)/65",
          )}
        >
          {note}
        </span>
      ) : null}
      <ArrowRight
        className={cn(
          "size-4 shrink-0 transition",
          selected
            ? "opacity-70"
            : "text-(color:--on)/40 group-hover:translate-x-0.5 group-hover:text-(color:--on)/80",
        )}
      />
    </button>
  );
}

/**
 * Where the setup stands: what is chosen, its steps by name, then one dash per step. A step
 * reached is green and checked, the one to do now amber, the ones ahead dim. The dashes fill
 * like a strength meter: as many as the step the setup is on, amber on the way, all green once
 * it works.
 */
function Stages({ name, at, done }: { name: string; at: number; done: boolean }) {
  const stages = [t("setup.stage.connect"), t("setup.stage.test"), t("setup.stage.done")];
  const level = done ? stages.length : at + 1;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 font-medium text-[0.75rem] uppercase tracking-[0.14em]">
      <span className="text-(color:--on)/70">{name}</span>
      <ol className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {stages.map((stage, i) => {
          const reached = done || i < at;
          return (
            <li
              key={stage}
              aria-current={!reached && i === at ? "step" : undefined}
              className="flex items-center gap-1 transition-colors duration-500"
              style={{ color: reached ? STEP_DONE : i === at ? STEP_NOW : STEP_LATER }}
            >
              {reached ? <Check className="size-3.5" strokeWidth={3} /> : null}
              {stage}
            </li>
          );
        })}
      </ol>
      <span aria-hidden="true" className="flex gap-1.5">
        {stages.map((stage, i) => (
          <span
            key={stage}
            className="h-[3px] w-5 rounded-full transition-colors duration-500"
            style={{
              background:
                i < level
                  ? done
                    ? STEP_DONE
                    : STEP_NOW
                  : "color-mix(in oklab, var(--on) 22%, transparent)",
            }}
          />
        ))}
      </span>
    </div>
  );
}

function FooterLink({ href, children }: { href: string; children: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="transition hover:text-(color:--on)"
      onClick={(e) => {
        // In the desktop app a page opens in the person's own browser.
        e.preventDefault();
        openExternal(href);
      }}
    >
      {children}
    </a>
  );
}

/**
 * Setup of a runtime that runs alone, as a wizard of its own: first only the question what the
 * app thinks with, in the middle of the page. A choice steps the list aside and opens what that
 * choice needs — the sign-in, the keys, the test call — its rows level with the list's. It stays
 * in front until a test has worked; everything here is in the settings too.
 */
export function SetupPage() {
  const siteOn = useFeature("site");
  // Dark stands on the vivid ground, light on the theme's paper.
  const onGround = usePreferredTheme() === "dark";
  useGround(onGround ? GROUND : null);
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const config = useConfig();
  const accountOn = useFeature("account");
  const { project } = useCurrentProject();
  // The account: signed in during the install, or here; its credits are a way to think too.
  const linking = useAccountLink(Boolean(me.data?.account?.signedIn));
  const [picked, setPicked] = useState(ownPicked);
  // A narrow page shows the opened choice alone; the person goes back to the choices from there.
  const [listOpen, setListOpen] = useState(false);
  const choose = useMutation({
    // Apple Intelligence is the short classes bound on this Mac; the source stays and keeps High
    // and Highest. Another choice after it unbinds them.
    mutationFn: (pick: Pick) =>
      api.put(
        "/api/studio/local/models",
        pick === "apple"
          ? { bindings: { classifier: "apple:default", standard: "apple:default" } }
          : pick === "own"
            ? { source: "own", bindings: { classifier: "", standard: "" } }
            : { source: pick, bindings: withoutApple(me.data?.models?.bindings ?? {}) },
      ),
    onSuccess: async (_saved, source) => {
      // First what the server now says, then the move: the choice opens on its own state,
      // never for a moment on the source it replaced.
      await qc.invalidateQueries({ queryKey: ["me"] });
      setPicked(true);
      setListOpen(false);
      toTop();
      rememberOwn(source === "own");
    },
  });
  const rescan = useMutation({
    mutationFn: () =>
      Promise.all(
        (me.data?.harnesses ?? []).map((h) => api.post(`/api/studio/local/harness/${h.id}/detect`)),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }),
  });
  if (!me.data?.models) {
    return null;
  }
  const models = me.data.models;
  // Installed clients first, and among each, the one whose app is on this computer: its
  // subscription is most likely already paid for. A missing one installs right here.
  const rank = (h: HarnessStatus) => (h.version === null ? 2 : 0) + (h.app ? 0 : 1);
  const clients = [...me.data.harnesses].sort((a, b) => rank(a) - rank(b));
  const installed = clients.filter((h) => h.version !== null);
  // A first start has nothing chosen yet; a source picked earlier (here or in the settings) stays picked.
  const apple = me.data.apple;
  const appleChosen = models.bindings.standard?.startsWith("apple:");
  const selected: Pick | null = appleChosen
    ? "apple"
    : picked || me.data.setupDone || models.source !== "own"
      ? models.source
      : null;
  const client = me.data.harnesses.find((h) => h.id === selected);
  // Beside Apple the source stays: High and Highest think on the client or the credits picked before.
  const keeps =
    models.source === "account"
      ? t("models.creditsName")
      : (me.data.harnesses.find((h) => h.id === models.source)?.name ?? null);
  const works = me.data.setupDone;
  const hasKey = Object.values(models.keys).some(Boolean);
  // Connect, test, done: where the chosen source stands. Apple has nothing to connect.
  const stage = works
    ? 2
    : client
      ? client.auth === "none"
        ? 0
        : 1
      : selected === "apple" || selected === "account" || hasKey
        ? 1
        : 0;
  const heading = works
    ? t("setup.h.done")
    : client
      ? client.version === null
        ? t("setup.h.install", { name: client.name })
        : client.auth === "none"
          ? t("setup.h.signIn", { name: client.name })
          : t("setup.h.test")
      : selected === "apple" || selected === "account" || hasKey
        ? t("setup.h.test")
        : t("setup.h.keys");
  const site = siteOn ? config.data?.site : null;
  /** On a narrow page: the opened choice is all there is to see. */
  const panelOnly = selected !== null && !listOpen;
  /** The row that is lit: the one just clicked, at once; else the one in effect. */
  const marked = choose.isPending ? (choose.variables ?? selected) : selected;
  return (
    <div
      className="flex min-h-dvh flex-col px-6 text-(color:--on) sm:px-10"
      style={onGround ? ON_GROUND : ON_PAPER}
    >
      <header className="flex items-center justify-between pt-6 sm:pt-8">
        <Wordmark />
        <span className="flex items-center gap-2">
          <ThemeSwitch tone={onGround ? "ground" : "surface"} />
          <LangSwitch tone={onGround ? "ground" : "surface"} ink={GROUND_INK} />
        </span>
      </header>
      <main className="relative mx-auto flex w-full max-w-6xl flex-1 flex-col pt-6 pb-10 lg:pt-[6vh]">
        {/* The host of the start takes no row of its own on a wide page: it stands large beside
            the choices. On a narrow page there is no room beside anything, so it stands small
            above them. A choice brings a host of its own, and this one steps out. */}
        <div
          aria-hidden="true"
          className={cn(
            "absolute top-6 left-1/2 z-10 origin-top -translate-x-1/2 transition-[opacity,scale,left] duration-500 motion-reduce:transition-none lg:top-[calc(6vh+5.25rem)] lg:origin-center lg:translate-x-0",
            EASE,
            selected
              ? "lg:pointer-events-none lg:left-[calc(50%-560px)] lg:scale-75 lg:opacity-0"
              : "lg:left-[calc(50%-508px)] lg:scale-100 lg:opacity-100",
            panelOnly
              ? "max-lg:pointer-events-none max-lg:scale-[0.4] max-lg:opacity-0"
              : "max-lg:scale-[0.6] max-lg:opacity-100",
          )}
        >
          <div className="animate-rise">
            <Mascot kind="drop" size={HOST} fluffy coat="fur" />
          </div>
        </div>
        <div
          aria-hidden="true"
          className={cn(
            "shrink-0 transition-[height] duration-500 motion-reduce:transition-none lg:h-0",
            EASE,
            panelOnly ? "max-lg:h-0" : "max-lg:h-[148px]",
          )}
        />
        <div className="flex flex-col gap-10 lg:flex-row lg:items-start lg:gap-14">
          <section
            className={cn(
              "flex w-full shrink-0 animate-rise flex-col lg:w-[32rem] lg:transition-[margin] lg:duration-700 motion-reduce:transition-none",
              EASE,
              selected ? "lg:ml-0" : "lg:ml-[calc(50%-16rem)]",
              panelOnly ? "max-lg:hidden" : "",
            )}
          >
            {/* Centred over the list while it stands alone; at the left edge, like the other
                column's lines, once a choice is open. */}
            <div className="flex flex-col lg:min-h-[6.5rem]">
              <p
                className={cn(
                  LINE,
                  "font-medium text-(color:--on)/70 text-[0.75rem] uppercase tracking-[0.16em]",
                  selected ? LINE_LEFT : LINE_MIDDLE,
                )}
              >
                {t("setup.title")}
              </p>
              <h1
                className={cn(
                  LINE,
                  "mt-2 font-display font-semibold text-[1.625rem] leading-[1.08] tracking-[-0.02em] sm:text-[1.75rem]",
                  selected ? LINE_LEFT : LINE_MIDDLE,
                )}
              >
                {t("setup.source")}
              </h1>
              <p
                className={cn(
                  LINE,
                  "mt-2.5 text-(color:--on)/75 text-[0.9375rem] leading-relaxed",
                  selected ? LINE_LEFT : LINE_MIDDLE,
                )}
              >
                {t("setup.sub")}
              </p>
            </div>
            {accountOn ? (
              <div className="mt-5 flex items-center gap-3.5 rounded-2xl bg-(color:--panel) px-4 py-3.5 ring-(color:--panel-ring) ring-1">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-(color:--pick) font-semibold text-(color:--pick-ink) text-[0.9375rem]">
                  {me.data.account?.signedIn ? (
                    (me.data.account.name || me.data.account.email).slice(0, 1).toUpperCase()
                  ) : (
                    <Cloud className="size-4.5" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  {me.data.account?.signedIn ? (
                    <>
                      <p className="font-medium text-[0.9375rem]">
                        {t("setup.accountLinked", {
                          name: me.data.account.name || me.data.account.email,
                        })}
                      </p>
                      <p className="text-(color:--on)/75 text-[0.8125rem]">
                        {[
                          me.data.account.team,
                          me.data.account.credits === null
                            ? null
                            : t("setup.accountCredits", {
                                credits: me.data.account.credits.toLocaleString(lang),
                              }),
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="font-medium text-[0.9375rem]">{t("setup.account")}</p>
                      <p className="text-(color:--on)/75 text-[0.8125rem] leading-snug">
                        {t("setup.accountText")}
                      </p>
                      <LinkStatus {...linking} />
                    </>
                  )}
                </div>
                {me.data.account?.signedIn ? null : (
                  <Button
                    variant="secondary"
                    size="sm"
                    busy={linking.link.isPending}
                    onClick={() => linking.link.mutate({})}
                  >
                    {t("account.signIn")}
                  </Button>
                )}
              </div>
            ) : null}
            <div className="mt-5 flex flex-col gap-2.5">
              {me.data.account?.signedIn ? (
                <Choice
                  selected={marked === "account"}
                  title={t("setup.creditsChoice")}
                  description={t("setup.creditsDesc")}
                  note={
                    me.data.account.credits === null
                      ? undefined
                      : t("setup.accountCredits", {
                          credits: me.data.account.credits.toLocaleString(lang),
                        })
                  }
                  onPick={() => choose.mutate("account")}
                />
              ) : null}
              {clients.map((h, i) => (
                <Choice
                  key={h.id}
                  selected={marked === h.id}
                  title={h.name}
                  description={t(`harness.desc.${h.id}`)}
                  badge={i === 0 ? t("setup.recommended") : undefined}
                  note={
                    h.version === null
                      ? t("harness.notInstalled")
                      : h.auth === "subscription"
                        ? t("harness.ready")
                        : undefined
                  }
                  onPick={() => choose.mutate(h.id)}
                />
              ))}
              {apple?.supported ? (
                <Choice
                  selected={marked === "apple"}
                  title={t("models.optApple")}
                  description={t("setup.appleDesc")}
                  note={appleNote(apple)}
                  onPick={() => choose.mutate("apple")}
                />
              ) : null}
              <Choice
                selected={marked === "own"}
                title={t("local.sourceOwn")}
                description={t("setup.ownDesc")}
                onPick={() => choose.mutate("own")}
              />
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-(color:--on)/60 text-[0.8125rem]">
              <span>{installed.length ? null : t("setup.noHarness")}</span>
              <Button
                variant="ghost"
                size="sm"
                busy={rescan.isPending}
                onClick={() => rescan.mutate()}
              >
                <RefreshCw className="size-3.5" /> {t("local.recheck")}
              </Button>
            </div>
          </section>
          {selected ? (
            <section
              key={selected}
              className={cn("min-w-0 flex-1 animate-settle", listOpen ? "max-lg:hidden" : "")}
            >
              {/* On a narrow page the opened choice stands alone: this leads back to the choices. */}
              <button
                type="button"
                onClick={() => {
                  setListOpen(true);
                  toTop();
                }}
                className="-ml-1.5 mb-5 inline-flex items-center gap-1.5 rounded-full px-1.5 py-1 text-(color:--on)/80 text-[0.875rem] transition hover:text-(color:--on) lg:hidden"
              >
                <ArrowLeft className="size-4" /> {t("run.back")}
              </button>
              <div className="relative">
                {/* This choice's host stands on the box's corner, under the line of steps; it
                  comes and goes with the choice. The heading keeps clear of it. */}
                <div aria-hidden="true" className="absolute top-6 right-2 z-10">
                  <Mascot kind={HOSTS[selected]} size={120} fluffy coat="fur" />
                </div>
                <div className="min-h-[6.5rem]">
                  <Stages
                    name={
                      client?.name ??
                      (selected === "apple"
                        ? t("models.optApple")
                        : selected === "account"
                          ? t("setup.creditsChoice")
                          : t("local.sourceOwn"))
                    }
                    at={stage}
                    done={works}
                  />
                  <h2
                    key={heading}
                    className="mt-2 animate-rise pr-32 font-display font-semibold text-[clamp(28px,3vw,40px)] leading-[1.06] tracking-[-0.03em]"
                  >
                    {heading}
                  </h2>
                </div>
                <div className="mt-5 rounded-2xl bg-(color:--panel) p-5 ring-(color:--panel-ring) ring-1 sm:p-6">
                  {client ? (
                    <HarnessPanel me={me.data} id={client.id} autoTest={!works} />
                  ) : selected === "apple" ? (
                    <div className="flex flex-col gap-5">
                      <p className="text-[0.875rem] text-ink-2 leading-relaxed">
                        {keeps ? t("setup.appleHintKeeps", { way: keeps }) : t("setup.appleHint")}
                      </p>
                      <ModelTest auto={!works && apple?.available === true} />
                    </div>
                  ) : selected === "account" ? (
                    <div className="flex flex-col gap-5">
                      <p className="text-[0.875rem] text-ink-2 leading-relaxed">
                        {t("setup.creditsDesc")}
                      </p>
                      <ModelTest auto={!works} />
                    </div>
                  ) : (
                    <OwnModels models={models} />
                  )}
                </div>
                <div className="mt-9">
                  {works ? (
                    <p
                      className="mb-3 flex animate-rise items-center gap-2 font-medium text-[0.9375rem]"
                      style={{ color: STEP_DONE }}
                    >
                      <Check className="size-4" strokeWidth={3} />
                      {t("setup.ready")}
                    </p>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-4">
                    {/* Dim while the way is not open; in the colour of a reached step once it is. */}
                    <button
                      type="button"
                      disabled={!works}
                      onClick={() => navigate("/", { replace: true })}
                      className={cn(
                        "group inline-flex h-12 items-center gap-2.5 rounded-full px-6 font-semibold text-[1rem] transition-[background-color,color,box-shadow,filter] duration-300",
                        works
                          ? "shadow-[0_6px_24px_oklch(88%_0.17_150/0.35)] hover:brightness-105"
                          : "cursor-not-allowed bg-(color:--on)/20 text-(color:--on)/65",
                      )}
                      style={
                        works ? { background: STEP_DONE, color: "var(--ready-ink)" } : undefined
                      }
                    >
                      {t("setup.done")}
                      <span
                        aria-hidden="true"
                        className="transition-transform group-enabled:group-hover:translate-x-0.5"
                      >
                        →
                      </span>
                    </button>
                    {works ? null : (
                      <span className="text-(color:--on)/65 text-[0.8125rem]">
                        {t("setup.untilWorks")}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </section>
          ) : null}
        </div>
      </main>
      {/* One quiet line at the foot: whose app this is and where it runs. Its other end holds
          a place, marked with the wordmark's dot at its own size, for what belongs there later. */}
      <footer className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 pb-6 text-(color:--on)/55 text-[0.75rem] sm:pb-8">
        <span>
          engenty ·{" "}
          {me.data.account?.signedIn
            ? t("setup.thisComputer", {
                space: project?.name ?? "",
                team: me.data.account.team ?? me.data.account.name,
              })
            : t("setup.local")}
        </span>
        <span className="flex items-center gap-5">
          {site ? <FooterLink href={site}>{new URL(site).host}</FooterLink> : null}
          <span aria-hidden="true" className="size-[3px] bg-(color:--dot)" />
        </span>
      </footer>
    </div>
  );
}
