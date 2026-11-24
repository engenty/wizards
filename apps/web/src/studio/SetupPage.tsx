import {
  Choice,
  ClientPanel,
  ModelTest,
  SETUP_GROUND,
  SETUP_GROUND_INK,
  SETUP_ON_GROUND,
  SETUP_ON_PAPER,
  type SetupChoice,
  SetupColumns,
  SetupReady,
  useClientChoices,
  useClientStage,
} from "@engenty/model-setup/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Check, Cloud } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { Mascot } from "../brand";
import { EngentyLogoMark } from "../engenty/logo";
import { api } from "../lib/api";
import { useConfig, useFeature } from "../lib/features";
import { lang, t } from "../lib/i18n";
import {
  type AppleStatus,
  type LocalModels,
  type Me,
  useCurrentSpace,
  useMe,
  withoutApple,
} from "../lib/session";
import { useGround, usePreferredTheme } from "../lib/theme";
import { Button, cn } from "../ui";
import { LinkStatus, useAccountLink } from "./Account";
import { StudioSetup } from "./Harness";
import { LangSwitch } from "./LangSwitch";
import { OwnModels, openExternal } from "./LocalRuntime";
import { ThemeSwitch } from "./ThemeSwitch";

type Source = LocalModels["source"];
/** What the setup offers: a source, or Apple Intelligence — the short classes bound on this Mac. */
type Pick = Source | "apple";

/** The colour of a step reached. */
const STEP_DONE = "var(--step-done)";

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
 * Between the setup and the studio, for someone without an account: sign in or create one, or go
 * on with this computer alone. A sign-in that comes back opens the studio by itself.
 */
function AccountAsk({
  source,
  signedIn,
  onLocal,
}: {
  source: string;
  signedIn: boolean;
  onLocal: () => void;
}) {
  const linking = useAccountLink(signedIn);
  const { link } = linking;
  useEffect(() => {
    if (signedIn) {
      onLocal();
    }
  }, [signedIn, onLocal]);
  return (
    <section className="mx-auto flex w-full max-w-[32rem] animate-rise flex-col items-center text-center">
      <Mascot kind="drop" size={132} fluffy coat="fur" />
      <span
        className="mt-4 inline-flex items-center gap-1.5 rounded-full px-3 py-1 font-medium text-[0.75rem]"
        style={{
          color: STEP_DONE,
          background: "color-mix(in oklab, var(--step-done) 20%, transparent)",
        }}
      >
        <Check className="size-3.5" strokeWidth={3} />
        {t("setup.connected", { name: source })}
      </span>
      <h1 className="mt-3 font-display font-semibold text-[1.75rem] leading-[1.08] tracking-[-0.02em]">
        {t("setup.accountAsk")}
      </h1>
      <p className="mt-2.5 text-balance text-(color:--on)/75 text-[0.9375rem] leading-relaxed">
        {t("setup.accountAskText")}
      </p>
      <div className="mt-7 flex w-full flex-col gap-4 rounded-2xl bg-(color:--panel) p-5 text-left ring-(color:--panel-ring) ring-1">
        <div className="flex items-center gap-3.5">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-(color:--pick) text-(color:--pick-ink)">
            <Cloud className="size-4.5" />
          </span>
          <div className="min-w-0">
            <p className="font-medium text-[0.9375rem]">{t("setup.account")}</p>
            <p className="text-(color:--on)/75 text-[0.8125rem] leading-snug">
              {t("setup.accountText")}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2.5">
          <Button
            // White on the ground, like a picked choice; the theme's accent would clash with the blue.
            style={{ background: "var(--pick)", color: "var(--pick-ink)" }}
            busy={link.isPending && !link.variables?.signup}
            onClick={() => link.mutate({})}
          >
            {t("account.signIn")}
          </Button>
          <Button
            variant="secondary"
            busy={link.isPending && Boolean(link.variables?.signup)}
            onClick={() => link.mutate({ signup: true })}
          >
            {t("account.create")}
          </Button>
        </div>
        <LinkStatus {...linking} />
      </div>
      <button
        type="button"
        onClick={onLocal}
        className="group mt-7 inline-flex items-center gap-1.5 font-medium text-[0.9375rem] underline decoration-(color:--on)/40 underline-offset-4 transition hover:decoration-(color:--on)"
      >
        {t("setup.localContinue")}
        <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
      </button>
      <p className="mt-2 max-w-[44ch] text-balance text-(color:--on)/65 text-[0.8125rem] leading-snug">
        {t("setup.localContinueNote")}
      </p>
    </section>
  );
}

/**
 * Setup of a runtime that runs alone, as a wizard of its own (@engenty/model-setup): the question
 * what the app thinks with, and beside it what the picked way needs. It stays in front until a
 * test has worked; everything here is in the settings too.
 */
export function SetupPage() {
  const me = useMe();
  return me.data?.models ? (
    <StudioSetup>
      <Setup me={me.data} models={me.data.models} />
    </StudioSetup>
  ) : null;
}

function Setup({ me, models }: { me: Me; models: LocalModels }) {
  const siteOn = useFeature("site");
  // Dark stands on the vivid ground, light on the theme's paper.
  const onGround = usePreferredTheme() !== "light";
  useGround(onGround ? SETUP_GROUND : null);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const config = useConfig();
  const accountOn = useFeature("account");
  const { space } = useCurrentSpace();
  // The account: signed in during the install, or here; its credits are a way to think too.
  const signedIn = Boolean(me.account?.signedIn);
  const linking = useAccountLink(signedIn);
  const [picked, setPicked] = useState(ownPicked);
  // Without an account, the way to the studio asks once whether to sign in first.
  const [asking, setAsking] = useState(false);
  const choose = useMutation({
    // Apple Intelligence is the short classes bound on this Mac; the source stays and keeps Standard
    // and High. Another choice after it unbinds them.
    mutationFn: (pick: Pick) =>
      api.put(
        "/api/studio/local/models",
        pick === "apple"
          ? { bindings: { classifier: "apple:default", low: "apple:default" } }
          : pick === "own"
            ? { source: "own", bindings: { classifier: "", low: "" } }
            : { source: pick, bindings: withoutApple(models.bindings) },
      ),
    onSuccess: async (_saved, source) => {
      // First what the server now says, then the move: the choice opens on its own state,
      // never for a moment on the source it replaced.
      await qc.invalidateQueries({ queryKey: ["me"] });
      setPicked(true);
      rememberOwn(source === "own");
    },
  });
  const rescan = useMutation({
    mutationFn: () =>
      Promise.all(me.harnesses.map((h) => api.post(`/api/studio/local/harness/${h.id}/detect`))),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }),
  });
  const clients = useClientChoices(me.harnesses);
  const installed = me.harnesses.some((h) => h.version !== null);
  // A first start has nothing chosen yet; a source picked earlier (here or in the settings) stays picked.
  const apple = me.apple;
  const appleChosen = models.bindings.low?.startsWith("apple:");
  const selected: Pick | null = appleChosen
    ? "apple"
    : picked || me.setupDone || models.source !== "own"
      ? models.source
      : null;
  const client = me.harnesses.find((h) => h.id === selected);
  // Beside Apple the source stays: Standard and High think on the client or the credits picked before.
  const keeps =
    models.source === "account"
      ? t("models.creditsName")
      : (me.harnesses.find((h) => h.id === models.source)?.name ?? null);
  const works = me.setupDone;
  const hasKey = Object.values(models.keys).some(Boolean);
  // Connect, test, done: where the chosen source stands. Apple has nothing to connect.
  const standing = useClientStage(client, works);
  const { stage, heading } =
    selected === "own" && !works && !hasKey ? { stage: 0, heading: t("setup.h.keys") } : standing;
  const site = siteOn ? config.data?.site : null;
  const sourceName =
    client?.name ??
    (selected === "apple"
      ? t("models.optApple")
      : selected === "account"
        ? t("setup.creditsChoice")
        : t("local.sourceOwn"));
  const toStudio = () => navigate("/", { replace: true });
  const credits = me.account?.credits ?? null;
  const choices: SetupChoice[] = [
    ...clients,
    ...(apple?.supported
      ? [
          {
            id: "apple",
            title: t("models.optApple"),
            description: t("setup.appleDesc"),
            note: appleNote(apple),
          },
        ]
      : []),
    { id: "own", title: t("local.sourceOwn"), description: t("setup.ownDesc") },
  ];
  /** The row that is lit: the one just clicked, at once; else the one in effect. */
  const marked = choose.isPending ? (choose.variables ?? selected) : selected;
  const account = (pick: (id: string) => void) => (
    <>
      {accountOn ? (
        <div className="mt-5 flex items-center gap-3.5 rounded-2xl bg-(color:--panel) px-4 py-3.5 ring-(color:--panel-ring) ring-1">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-(color:--pick) font-semibold text-(color:--pick-ink) text-[0.9375rem]">
            {me.account?.signedIn ? (
              (me.account.name || me.account.email).slice(0, 1).toUpperCase()
            ) : (
              <Cloud className="size-4.5" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            {me.account?.signedIn ? (
              <>
                <p className="font-medium text-[0.9375rem]">
                  {t("setup.accountLinked", { name: me.account.name || me.account.email })}
                </p>
                <p className="text-(color:--on)/75 text-[0.8125rem]">
                  {[
                    me.account.organization,
                    credits === null
                      ? null
                      : t("setup.accountCredits", { credits: credits.toLocaleString(lang) }),
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
          {signedIn ? null : (
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
      {signedIn ? (
        <div className="mt-2.5">
          <Choice
            selected={marked === "account"}
            choice={{
              id: "account",
              title: t("setup.creditsChoice"),
              description: t("setup.creditsDesc"),
              ...(credits === null
                ? {}
                : {
                    note: t("setup.accountCredits", { credits: credits.toLocaleString(lang) }),
                  }),
            }}
            onPick={() => pick("account")}
          />
        </div>
      ) : null}
    </>
  );
  return (
    <div
      className="flex min-h-dvh flex-col px-6 text-(color:--on) sm:px-10"
      style={onGround ? SETUP_ON_GROUND : SETUP_ON_PAPER}
    >
      <header className="flex items-center justify-between pt-6 sm:pt-8">
        <Wordmark />
        <span className="flex items-center gap-2">
          <ThemeSwitch tone={onGround ? "ground" : "surface"} />
          <LangSwitch tone={onGround ? "ground" : "surface"} ink={SETUP_GROUND_INK} />
        </span>
      </header>
      <main className="relative mx-auto flex w-full max-w-6xl flex-1 flex-col pt-6 pb-10 lg:pt-[6vh]">
        {/* While it asks about the account, the choices step out; the start's host is already gone. */}
        {asking ? <AccountAsk source={sourceName} signedIn={signedIn} onLocal={toStudio} /> : null}
        <SetupColumns
          hidden={asking}
          eyebrow={t("setup.title")}
          title={t("setup.source")}
          sub={t("setup.sub")}
          figure={<Mascot kind="drop" size={HOST} fluffy coat="fur" />}
          top={account}
          // The account works in the cloud too; what follows works on this computer only.
          divider={
            accountOn ? { label: t("setup.localDivider"), note: t("setup.localNote") } : undefined
          }
          choices={choices}
          selected={selected}
          marked={marked}
          onPick={(id) => choose.mutateAsync(id as Pick)}
          recheck={{
            busy: rescan.isPending,
            run: () => rescan.mutate(),
            note: installed ? null : t("setup.noHarness"),
          }}
          panel={
            selected
              ? {
                  name: sourceName,
                  heading,
                  stage,
                  works,
                  // This choice's host stands on the box's corner; it comes and goes with the choice.
                  figure: <Mascot kind={HOSTS[selected]} size={120} fluffy coat="fur" />,
                  content: client ? (
                    <ClientPanel client={client} autoTest={!works} />
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
                  ),
                  footer: (
                    <>
                      {works ? <SetupReady /> : null}
                      <div className="flex flex-wrap items-center gap-4">
                        {/* Dim while the way is not open; in the colour of a reached step once it is. */}
                        <button
                          type="button"
                          disabled={!works}
                          onClick={() => {
                            if (accountOn && !signedIn) {
                              setAsking(true);
                              window.scrollTo({ top: 0 });
                            } else {
                              toStudio();
                            }
                          }}
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
                    </>
                  ),
                }
              : null
          }
        />
      </main>
      {/* One quiet line at the foot: whose app this is and where it runs. Its other end holds
          a place, marked with the wordmark's dot at its own size, for what belongs there later. */}
      <footer className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 pb-6 text-(color:--on)/55 text-[0.75rem] sm:pb-8">
        <span>
          engenty ·{" "}
          {me.account?.signedIn
            ? t("setup.thisComputer", {
                space: space?.name ?? "",
                organization: me.account.organization ?? me.account.name,
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
