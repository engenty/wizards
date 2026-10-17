import type { RunnerFit, RunnerInfo, RunnerSettings } from "@engenty-wizards/shared/runners";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  CircleAlert,
  CircleCheck,
  Cloud,
  Code,
  Copy,
  Download,
  Settings as Gear,
  Globe,
  Laptop,
  Link2,
  Lock,
  Printer,
  Puzzle,
  QrCode,
  RefreshCw,
  X,
} from "lucide-react";
import {
  type CSSProperties,
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate } from "react-router";
import { api } from "../../lib/api";
import { withBase } from "../../lib/base";
import { useFeature } from "../../lib/features";
import { type Key, lang, t } from "../../lib/i18n";
import {
  type CloudAnswer,
  type CloudState,
  type PublishResult,
  type ServerProblem,
  useCloud,
  useMe,
  type WizardDetail,
} from "../../lib/session";
import { PluginFrame, type StudioPlugins, useStudioPlugins } from "../../plugins/host";
import { Button, cn, Dialog, IconButton, Input, Spinner, Switch } from "../../ui";
import { LinkStatus, useAccountLink } from "../Account";
import { openExternal } from "../LocalRuntime";
import {
  CHANNEL_GROUPS,
  type ChannelGroup,
  ChannelIcon,
  ChannelList,
  channelOfRunner,
  channelsOfRunners,
  runnerSettingsOf,
} from "../NewWizardChannels";
import { FitChip, NeedList, useStandalone } from "../StandaloneNeeds";
import { sharedLink, type WhereItRuns, whereItRuns } from "../where";
import { useEstimate } from "./estimate";
import { TranslationsSection } from "./Translations";
import { printQr, QrImage, qrSvg, saveQrPng, spacedCode } from "./WizardQr";

/**
 * Hands a published wizard out: who may open it, and the ways others reach it — the channels it
 * was made for, each with its link or number — then the link to copy. The QR code, the website,
 * the settings and the channels open in the dialog itself, with a way back.
 */

/** Where the WordPress plugin is downloaded: the latest release of its own repository. */
const WORDPRESS_ZIP =
  "https://github.com/engenty/engenty-wizards-wp-plugin/releases/latest/download/engenty-wizards.zip";

/**
 * The editor's publishing: a wizard shared for the first time goes live as it opens; later
 * changes go live through "Änderungen live schalten".
 */
interface Publish {
  run: () => Promise<PublishResult>;
  busy: boolean;
  /** The draft cannot be published as it is: it has issues, or it is being built. */
  disabled: boolean;
  /** Asks the assistant to mend the draft's issues. */
  fix?: () => void;
  /** Opens "Änderungen live schalten". */
  goLive: () => void;
}

/** Where a channel's plugin says a person reaches the wizard. */
interface RunnerAddress {
  number?: string | null;
  keyword?: string | null;
  link?: string | null;
}

/** What the studio asks about a wizard's runners: each with its fit and address, and how the wizard is offered. */
interface RunnersAnswer {
  runners: (RunnerInfo & { fit: RunnerFit; address: RunnerAddress | null })[];
  settings: RunnerSettings;
}

/** A way in, as a row: a channel that is on, and what its button copies. */
interface Way {
  id: string;
  group: ChannelGroup;
  name: string;
  icon: ReactNode;
  /** Under the name: the keyword with its number, the number, or why it cannot run this wizard. */
  note: string | null;
  /** What the row's button copies: a link, or the number to call. */
  copy: { text: string; number: boolean } | null;
  /** A link a phone's camera opens, for the QR code. */
  link: string | null;
  /** Not set up here, in the runner's words. */
  problem: string | null;
  /** `setup`: to set up here; `waiting`: asked for, nothing to do; `plan`: not in the plan. */
  problemKind: NonNullable<RunnerInfo["problemKind"]>;
  /** What the row says about the problem, from the runner. */
  problemNote: string | null;
  /** `plan`: the plan that has it. */
  problemPlan: string | null;
  plugin?: string;
}

type View = "main" | "qr" | "website" | "package" | "settings" | "channels" | "setup";

const HEADINGS: Record<Exclude<View, "main" | "setup">, Key> = {
  qr: "share.qr",
  website: "share.onWebsite",
  package: "share.wpLocal",
  settings: "share.settings",
  channels: "new.where",
};

/** The channels that are on, as rows, by kind: the browser's (with `base`, the link), the phone's, the messages'. */
function waysOf(answer: RunnersAnswer, base: string | null): Way[] {
  const { settings } = answer;
  const order = CHANNEL_GROUPS.map((g) => g.id);
  return answer.runners
    .filter((r) => settings.enabled.includes(r.id))
    .map((r): Way => {
      const channel = channelOfRunner(r.id);
      const group: ChannelGroup = channel?.group ?? (r.kind === "page" ? "web" : "message");
      const cannot =
        r.fit.outcome === "no"
          ? t("share.fit.no", { steps: r.fit.steps.map((s) => s.title).join(", ") })
          : null;
      const way = {
        id: r.id,
        group,
        name: channel ? t(channel.label) : r.label[lang],
        icon: channel ? <ChannelIcon channel={channel} /> : <Puzzle className="size-4" />,
        problem: r.problem ?? null,
        problemKind: r.problemKind ?? "setup",
        problemNote: r.problemNote?.[lang] ?? null,
        problemPlan: r.problemPlan ?? null,
        plugin: r.plugin,
      };
      if (r.kind === "page") {
        // The link opens the default; every other page answers below it.
        const url = base ? (r.id === settings.default ? base : `${base}/${r.id}`) : null;
        return {
          ...way,
          note: cannot,
          copy: url ? { text: url, number: false } : null,
          link: url,
        };
      }
      const a = r.address;
      const at =
        a?.keyword && a.number
          ? t("share.keywordTo", { keyword: a.keyword, number: a.number })
          : (a?.number ?? null);
      let copy: Way["copy"] = null;
      if (a?.link) {
        copy = { text: a.link, number: false };
      } else if (a?.number) {
        copy = { text: a.number, number: true };
      }
      return { ...way, note: cannot ?? at, copy, link: a?.link ?? null };
    })
    .sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
}

/** What a runner's setup says when it goes back to the main view. */
interface SetupBanner {
  title: string;
  text?: string;
  tone?: "done" | "waiting";
}

/** Puts a text on the clipboard; `copied` names what arrived there last, for a moment. */
function useCopy() {
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = (key: string, text: string) => {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(key);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(null), 1500);
      })
      // Refused (no focus, no permission): nothing says it was copied.
      .catch(() => setCopied(null));
  };
  return { copied, copy };
}

function Body({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("min-h-0 flex-1 overflow-y-auto px-4 pt-2 pb-5 sm:px-6", className)}>
      {children}
    </div>
  );
}

function Footer({ children }: { children: ReactNode }) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-border-soft border-t px-4 py-3.5 sm:px-5">
      {children}
    </div>
  );
}

const heading = "text-[0.8125rem] font-medium text-ink-3";

/** A line on top of the dialog: what keeps others out, or what to do first. */
function Banner({
  warn,
  done,
  title,
  children,
  action,
}: {
  warn?: boolean;
  /** It went well: the first version is live. */
  done?: boolean;
  title?: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl px-3.5 py-3 text-[0.875rem]",
        warn ? "bg-amber-tint" : done ? "bg-moss-tint" : "bg-paper-2",
      )}
    >
      {warn ? <CircleAlert className="size-4 shrink-0 self-start text-amber sm:mt-0.5" /> : null}
      {done ? <CircleCheck className="size-4 shrink-0 self-start text-moss sm:mt-0.5" /> : null}
      <div className="min-w-0 flex-[1_1_14rem]">
        {title ? <div className="font-medium">{title}</div> : null}
        {children ? (
          <div className={cn(title && "text-[0.8125rem] text-ink-2")}>{children}</div>
        ) : null}
      </div>
      {action}
    </div>
  );
}

const PROBLEM_TEXT: Record<ServerProblem["code"], Key> = {
  sandbox: "cloud.problem.sandbox",
  mcp: "cloud.problem.mcp",
  model: "cloud.problem.model",
  connector: "cloud.problem.connector",
  invalid: "cloud.problem.invalid",
};

/**
 * What the cloud lacks for a wizard, in the studio's words: the steps by their titles, one
 * sentence per kind of problem; the server's own text folds out where it says more.
 */
function Problems({ problems }: { problems: ServerProblem[] }) {
  return (
    <ul className="flex flex-col gap-2 text-[0.8125rem] text-ink-2">
      {problems.map((problem, i) => (
        <li key={i}>
          {problem.steps.length ? (
            <span className="font-medium text-ink">
              {problem.steps.map((s) => t("cloud.stepName", { title: s.title })).join(", ")}:{" "}
            </span>
          ) : null}
          {t(PROBLEM_TEXT[problem.code] ?? "cloud.problem.invalid", { detail: problem.detail })}
          {/* The MCP sentence names the servers itself; a missing sandbox has nothing to add. */}
          {problem.detail && problem.code !== "mcp" && problem.code !== "sandbox" ? (
            <details className="mt-0.5">
              <summary className="cursor-pointer text-[0.75rem] text-ink-4 hover:text-ink-3">
                {t("share.details")}
              </summary>
              <span className="mt-0.5 block break-words font-mono text-[0.6875rem] text-ink-4">
                {problem.detail}
              </span>
            </details>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

const shortTime = () => new Intl.DateTimeFormat(lang, { timeStyle: "short" });

/** A project of a local install the account's cloud holds. */
interface CloudSpace {
  id: string;
  name: string;
}

/**
 * Why the last try did not arrive. Where the account's cloud holds another install's project,
 * that one can be replaced from here: its wizards and their links go.
 */
function CloudError({ error }: { error: NonNullable<CloudState["error"]> }) {
  const qc = useQueryClient();
  const full = error.reason === "space_limit";
  const spaces = useQuery({
    queryKey: ["cloud-spaces"],
    queryFn: () => api.get<{ spaces: CloudSpace[] }>("/api/studio/cloud/spaces"),
    enabled: full,
    retry: false,
  });
  const replace = useMutation({
    mutationFn: () => api.post<{ sent: number; failed: number }>("/api/studio/cloud/replace"),
    // Every wizard of this install was sent again: each one's state is asked anew.
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ["cloud"] }),
        qc.invalidateQueries({ queryKey: ["cloud-spaces"] }),
        qc.invalidateQueries({ queryKey: ["wizards"] }),
      ]),
  });
  if (!full) {
    return (
      <p>
        {error.message}{" "}
        {error.reason === "signed_out" ? (
          <Link to="/settings/account" className="font-medium underline underline-offset-2">
            {t("local.toAccount")}
          </Link>
        ) : null}
        {error.again ? (
          <span className="text-ink-3">
            {t("cloud.again", { when: shortTime().format(new Date(error.again)) })}
          </span>
        ) : null}
      </p>
    );
  }
  const names = (spaces.data?.spaces ?? []).map((space) => space.name);
  return (
    <div className="flex flex-col gap-2">
      <p>{error.message}</p>
      <p className="text-ink-2">{t("cloud.spaceLimit")}</p>
      {names.length ? (
        <ul className="list-disc pl-5">
          {names.map((name, i) => (
            <li key={i}>{name}</li>
          ))}
        </ul>
      ) : null}
      <div>
        <Button
          variant="secondary"
          size="sm"
          busy={replace.isPending}
          onClick={() => window.confirm(t("cloud.replaceConfirm")) && replace.mutate()}
        >
          {t("cloud.replace")}
        </Button>
      </div>
      {replace.error ? <p className="text-rose">{(replace.error as Error).message}</p> : null}
    </div>
  );
}

/**
 * A local install with an account, where its cloud does not run this version: why, what it
 * lacks, and — where sending again helps — the offer to.
 */
function CloudProblem({
  wizard,
  where,
  cloud,
}: {
  wizard: WizardDetail;
  where: WhereItRuns;
  cloud: CloudAnswer | undefined;
}) {
  const qc = useQueryClient();
  const send = useMutation({
    mutationFn: () => api.post<CloudAnswer>(`/api/studio/wizards/${wizard.id}/cloud`),
    onSuccess: (state) => {
      qc.setQueryData(["cloud", wizard.id], state);
      void qc.invalidateQueries({ queryKey: ["wizards"] });
    },
  });
  if (where.kind !== "missing" && where.kind !== "sending") {
    return null;
  }
  const copy = cloud?.copy ?? null;
  const error = cloud?.error ?? null;
  const blocking = copy && !copy.runnable ? copy.problems.filter((p) => p.blocking) : [];
  /** Sent by publishing; by hand after a try that failed or was never made — not after a refusal only the person mends. */
  const resend =
    (!copy || copy.version < (wizard.publishedVersion ?? 0) || error) &&
    error?.reason !== "space_limit" &&
    error?.reason !== "signed_out";
  return (
    <Banner
      warn
      action={
        resend ? (
          <Button variant="secondary" size="sm" busy={send.isPending} onClick={() => send.mutate()}>
            {copy || error ? t("cloud.resend") : t("cloud.send")}
          </Button>
        ) : null
      }
    >
      <div className="flex flex-col gap-2">
        {error ? (
          <CloudError error={error} />
        ) : where.kind === "missing" ? (
          <p>{where.why}</p>
        ) : null}
        {error && where.runs !== null ? (
          <p className="text-[0.8125rem] text-ink-3">
            {t("cloud.keepsRunning", { v: where.runs })}
          </p>
        ) : null}
        {blocking.length ? <Problems problems={blocking} /> : null}
        {send.error ? (
          <p className="text-[0.8125rem] text-rose">{(send.error as Error).message}</p>
        ) : null}
      </div>
    </Banner>
  );
}

/** A local install without an account: its link answers here only; an account shares it. */
function LocalOffer({ account }: { account: boolean }) {
  const navigate = useNavigate();
  const linking = useAccountLink(false);
  if (!account) {
    return <Banner>{t("where.hereHint")}</Banner>;
  }
  return (
    <div className="flex flex-col gap-3 rounded-xl bg-paper-2 px-3.5 py-3">
      <div className="flex items-start gap-3">
        <Cloud className="mt-0.5 size-4 shrink-0 text-ink-3" />
        <div className="min-w-0">
          <div className="font-medium text-[0.875rem]">{t("share.others")}</div>
          <p className="text-[0.8125rem] text-ink-2">{t("share.localHint")}</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 pl-7">
        <Button size="sm" busy={linking.link.isPending} onClick={() => linking.link.mutate({})}>
          {t("account.signIn")}
        </Button>
        <Button size="sm" variant="secondary" onClick={() => navigate("/settings/account")}>
          {t("account.create")}
        </Button>
      </div>
      <LinkStatus {...linking} />
    </div>
  );
}

/** Who may open the link: anyone who has it, or nobody but the owner, in the studio. */
function Access({
  wizard,
  here,
  onChange,
}: {
  wizard: WizardDetail;
  here: boolean;
  onChange: (on: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) {
      return;
    }
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  const on = wizard.shareEnabled;
  const options = [
    { on: true, label: t("share.anyone"), hint: t("share.anyoneMenu"), Icon: Globe },
    { on: false, label: t("share.onlyYou"), hint: t("share.onlyYouHint"), Icon: Lock },
  ];
  let Icon = on ? Globe : Lock;
  let label = on ? t("share.anyone") : t("share.onlyYou");
  let hint = on
    ? t("share.anyoneHint", { n: wizard.dailyRunLimit.toLocaleString(lang) })
    : t("share.onlyYouHint");
  if (here) {
    Icon = Laptop;
    label = t("share.thisComputer");
    hint = t("share.thisComputerHint");
  }
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <h3 id={id} className={heading}>
        {t("share.access")}
      </h3>
      <div ref={box} className="relative flex items-center gap-3">
        <span
          className={cn(
            "flex size-10 shrink-0 items-center justify-center rounded-full",
            on && !here ? "bg-moss-tint text-moss" : "bg-paper-2 text-ink-2",
          )}
        >
          <Icon className="size-[1.125rem]" />
        </span>
        <div className="min-w-0 flex-1">
          {here || wizard.readOnly ? (
            <div className="font-medium text-[0.9375rem]">{label}</div>
          ) : (
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
              className="-ml-1 inline-flex min-h-7 items-center gap-1 rounded-md px-1 font-medium text-[0.9375rem] hover:bg-accent"
            >
              {label}
              <ChevronDown className="size-4 text-ink-3" />
            </button>
          )}
          <p className="text-[0.8125rem] text-ink-3">{hint}</p>
        </div>
        {open ? (
          <div
            role="menu"
            aria-label={t("share.access")}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                // The menu closes, the dialog stays.
                e.preventDefault();
                e.stopPropagation();
                setOpen(false);
              }
            }}
            className="absolute top-full left-10 z-10 mt-1 flex w-[min(21rem,calc(100%-2.5rem))] origin-top-left animate-unfold flex-col gap-0.5 rounded-xl bg-card p-1.5 shadow-overlay ring-1 ring-border"
          >
            {options.map((o) => (
              <button
                key={o.label}
                type="button"
                role="menuitemradio"
                aria-checked={o.on === on}
                onClick={() => {
                  setOpen(false);
                  if (o.on !== on) {
                    onChange(o.on);
                  }
                }}
                className={cn(
                  "flex min-h-14 items-center gap-3 rounded-lg px-2.5 py-2 text-left transition hover:bg-accent",
                  o.on === on && "bg-paper-2",
                )}
              >
                <o.Icon className="size-4 shrink-0 text-ink-3" />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium text-[0.875rem]">{o.label}</span>
                  <span className="block text-[0.8125rem] text-ink-3">{o.hint}</span>
                </span>
                <span className="flex w-4 shrink-0 justify-center">
                  {o.on === on ? <Check className="size-4" /> : null}
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}

/** The channels that are on, by kind, each with its link or number and a button that copies it. */
function Ways({
  ways,
  blocked,
  locked,
  note,
  copied,
  copy,
  onChange,
  onSetUp,
  plansUrl,
}: {
  ways: Way[];
  blocked: boolean;
  locked: boolean;
  note: string | null;
  copied: string | null;
  copy: (key: string, text: string) => void;
  onChange: () => void;
  /** "Einrichten" of a row. */
  onSetUp: (way: Way) => void;
  /** Where the plans are, for a channel the plan does not have; null where there are none. */
  plansUrl: string | null;
}) {
  const id = useId();
  const groups = CHANNEL_GROUPS.filter((g) => ways.some((w) => w.group === g.id));
  return (
    <section aria-labelledby={id} className="flex flex-col">
      <div className="flex items-center justify-between gap-3">
        <h3 id={id} className={heading}>
          {t("share.ways")}
        </h3>
        {locked ? null : (
          <button
            type="button"
            onClick={onChange}
            className="min-h-8 text-[0.8125rem] text-ink-2 underline underline-offset-[3px] hover:text-ink"
          >
            {t("share.change")}
          </button>
        )}
      </div>
      {groups.map((g) => (
        <div key={g.id} className={cn("flex flex-col", blocked && "opacity-50")}>
          <div className="flex items-center gap-1.5 pt-2 pb-0.5 text-[0.75rem] text-ink-3">
            <g.icon className="size-3.5" /> {t(g.label)}
          </div>
          <ul className="flex flex-col">
            {ways
              .filter((w) => w.group === g.id)
              .map((w) => {
                const done = copied === w.id;
                let action: ReactNode = null;
                if (w.problem && w.problemKind === "plan") {
                  action = plansUrl ? (
                    <Button size="sm" variant="secondary" onClick={() => openExternal(plansUrl)}>
                      {w.problemPlan
                        ? t("share.seePlan", { plan: w.problemPlan })
                        : t("share.seePlans")}
                    </Button>
                  ) : null;
                } else if (w.problem && w.problemKind === "waiting") {
                  action = null;
                } else if (w.problem) {
                  action = locked ? null : (
                    <Button size="sm" variant="quiet" onClick={() => onSetUp(w)}>
                      {t("share.setUp")}
                    </Button>
                  );
                } else if (w.copy) {
                  const { text, number } = w.copy;
                  action = (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={blocked}
                      aria-label={t(number ? "share.copyNumberFor" : "share.copyLinkFor", {
                        name: w.name,
                      })}
                      onClick={() => copy(w.id, text)}
                    >
                      {done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                      {done ? t("share.copied") : t(number ? "share.copyNumber" : "share.copyLink")}
                    </Button>
                  );
                }
                return (
                  <li key={w.id} className="flex min-h-13 items-center gap-3 py-1">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-paper-2 text-ink-2">
                      {w.icon}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[0.9375rem]">{w.name}</span>
                      {w.problem ? (
                        <span
                          className={cn(
                            "block text-[0.8125rem]",
                            w.problemKind === "setup" ? "text-amber" : "text-ink-3",
                          )}
                          title={w.problem}
                        >
                          {w.problemNote ??
                            t(
                              w.problemKind === "waiting"
                                ? "share.waiting"
                                : w.problemKind === "plan"
                                  ? "share.notInPlan"
                                  : "share.unset",
                            )}
                        </span>
                      ) : w.note ? (
                        <span className="block truncate text-[0.8125rem] text-ink-3" title={w.note}>
                          {w.note}
                        </span>
                      ) : null}
                    </span>
                    {action}
                  </li>
                );
              })}
          </ul>
        </div>
      ))}
      {note ? <p className="mt-2.5 text-[0.8125rem] text-ink-3">{note}</p> : null}
    </section>
  );
}

/** The QR code of one of the ways: the link by default, or a channel's own. */
function QrView({
  ways,
  title,
  code,
  base,
}: {
  ways: Way[];
  title: string;
  code: string | undefined;
  base: string | null;
}) {
  const offered = ways.filter((w) => w.link && !w.problem);
  const first = offered.find((w) => w.link === base) ?? offered[0];
  const [pick, setPick] = useState(first?.id);
  const way = offered.find((w) => w.id === pick) ?? first;
  const url = way?.link ?? base ?? "";
  const svg = useMemo(() => qrSvg(url), [url]);
  return (
    <>
      <Body className="flex flex-col items-center gap-3">
        {offered.length > 1 ? (
          <fieldset className="m-0 flex flex-wrap items-center gap-1.5 self-stretch border-0 p-0">
            <legend className="sr-only">{t("share.qrOpens")}</legend>
            <span aria-hidden="true" className="mr-1 text-[0.8125rem] text-ink-3">
              {t("share.qrOpens")}
            </span>
            {offered.map((w) => (
              <button
                key={w.id}
                type="button"
                aria-pressed={w.id === way?.id}
                onClick={() => setPick(w.id)}
                className={cn(
                  "h-8 rounded-full px-3 font-medium text-[0.8125rem] transition coarse:h-10",
                  w.id === way?.id
                    ? "bg-ink text-paper"
                    : "text-ink ring-1 ring-border hover:bg-accent",
                )}
              >
                {w.name}
              </button>
            ))}
          </fieldset>
        ) : null}
        <QrImage svg={svg} label={t("share.qr")} className="mt-2 size-56 p-1" />
        <div className="font-medium">{title}</div>
        <p className="max-w-sm text-center text-[0.8125rem] text-ink-3">
          {way?.group === "web" || !way
            ? t("share.qrHint")
            : t("share.qrMessage", { name: way.name })}
        </p>
        {code && url === base ? (
          <p className="text-[0.8125rem] text-ink-3">
            {t("share.code")}{" "}
            <span className="select-all font-mono text-[0.9375rem] text-ink tracking-wider">
              {spacedCode(code)}
            </span>
          </p>
        ) : null}
      </Body>
      <Footer>
        <Button variant="ghost" className="max-sm:flex-1" onClick={() => printQr(svg, title)}>
          <Printer className="size-4" /> {t("share.print")}
        </Button>
        <span className="flex-1 max-sm:hidden" />
        <Button
          className="max-sm:order-first max-sm:w-full"
          onClick={() => void saveQrPng(svg, title)}
        >
          <Download className="size-4" /> {t("share.download")}
        </Button>
      </Footer>
    </>
  );
}

const attr = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

type Place = "inline" | "button" | "bubble" | "popout";

const PLACES: Record<Place, { label: Key; hint: Key }> = {
  inline: { label: "share.place.inline", hint: "share.place.inlineHint" },
  button: { label: "share.place.button", hint: "share.place.buttonHint" },
  bubble: { label: "share.place.bubble", hint: "share.place.bubbleHint" },
  popout: { label: "share.place.popout", hint: "share.place.popoutHint" },
};

/** A page with the wizard where it sits: in the text, behind a button, in the corner. */
function PlaceSketch({ place }: { place: Place }) {
  return (
    <span
      aria-hidden="true"
      className="relative block h-16 overflow-hidden rounded-lg bg-paper ring-1 ring-border-soft"
    >
      <span className="absolute inset-x-2 top-2 h-1.5 rounded-full bg-paper-3" />
      <span className="absolute top-5 left-2 h-1 w-1/2 rounded-full bg-paper-3" />
      {place === "inline" ? (
        <span className="absolute inset-x-2 top-8 bottom-2 rounded-md bg-primary" />
      ) : null}
      {place === "button" ? (
        <span className="absolute top-9 left-2 h-3.5 w-12 rounded-full bg-primary" />
      ) : null}
      {place === "bubble" || place === "popout" ? (
        <span className="absolute right-2 bottom-2 size-[1.125rem] rounded-full bg-primary" />
      ) : null}
    </span>
  );
}

/**
 * The wizard on a website: as steps or as a chat, in the page, behind a button or in the
 * corner of every page (a chat's corner is its button); the tag for the page's HTML
 * (`public/embed.js`). WordPress takes it by its plugin, with an account or as a package.
 */
function WebsiteView({
  url,
  title,
  enabled,
  wordpress,
  onPackage,
}: {
  url: string | null;
  title: string;
  enabled: string[];
  wordpress: boolean;
  onPackage: () => void;
}) {
  const { copied, copy } = useCopy();
  const offered = (["steps", "chat"] as const).filter((id) => enabled.includes(id));
  const looks = offered.length ? offered : (["steps"] as const);
  const [look, setLook] = useState<"steps" | "chat">(looks[0]);
  const [chosen, setPlace] = useState<Place>("inline");
  const chat = look === "chat";
  const places: Place[] = chat ? ["inline", "popout"] : ["inline", "button", "bubble"];
  const place = places.includes(chosen) ? chosen : "inline";
  const [, app, token] = url?.match(/^(.*)\/w\/([^/]+)$/) ?? [];
  let extra = "";
  if (chat) {
    extra = place === "popout" ? ' data-mode="popout"' : ' data-runner="chat"';
  } else if (place !== "inline") {
    extra = ` data-mode="${place === "button" ? "modal" : "bubble"}" data-label="${attr(title)}"`;
  }
  const tag = token
    ? `<script async src="${app}/embed.js" data-wizard="${token}"${extra}></script>`
    : null;
  return (
    <>
      <Body className="flex flex-col gap-5">
        {tag ? (
          <>
            {looks.length > 1 ? (
              <fieldset className="m-0 border-0 p-0">
                <legend className={cn(heading, "mb-2 p-0")}>{t("share.webShows")}</legend>
                <div className="flex flex-wrap gap-1.5">
                  {looks.map((id) => (
                    <button
                      key={id}
                      type="button"
                      aria-pressed={id === look}
                      onClick={() => setLook(id)}
                      className={cn(
                        "h-8 rounded-full px-3.5 font-medium text-[0.8125rem] transition coarse:h-10",
                        id === look
                          ? "bg-ink text-paper"
                          : "text-ink ring-1 ring-border hover:bg-accent",
                      )}
                    >
                      {t(id === "chat" ? "new.ch.chat" : "new.ch.steps")}
                    </button>
                  ))}
                </div>
              </fieldset>
            ) : null}
            <fieldset className="m-0 border-0 p-0">
              <legend className={cn(heading, "mb-2 p-0")}>{t("share.webWhere")}</legend>
              <div
                className={cn(
                  "grid gap-2.5",
                  places.length === 3 ? "grid-cols-2 sm:grid-cols-3" : "grid-cols-2",
                )}
              >
                {places.map((p) => (
                  <button
                    key={p}
                    type="button"
                    aria-pressed={p === place}
                    onClick={() => setPlace(p)}
                    className={cn(
                      "flex flex-col gap-2 rounded-xl p-2 pb-2.5 text-left font-medium text-[0.8125rem] transition",
                      p === place
                        ? "bg-paper-2 ring-2 ring-ink"
                        : "ring-1 ring-border hover:bg-accent",
                    )}
                  >
                    <PlaceSketch place={p} />
                    {t(PLACES[p].label)}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-[0.8125rem] text-ink-3">{t(PLACES[place].hint)}</p>
            </fieldset>
            <div className="flex flex-col gap-2">
              <h3 className={heading}>{t("share.webCode")}</h3>
              <pre className="select-all whitespace-pre-wrap break-all rounded-lg bg-paper-2 px-3 py-2.5 font-mono text-[0.75rem] text-ink-2 leading-relaxed">
                {tag}
              </pre>
            </div>
          </>
        ) : (
          <p className="text-[0.875rem] text-ink-2">{t("share.webNeedsLink")}</p>
        )}
        {wordpress ? (
          <p className="text-[0.8125rem] text-ink-3">
            {t("share.wpLine")}{" "}
            <a
              href={WORDPRESS_ZIP}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-ink-2 underline underline-offset-2 hover:text-ink"
            >
              {t("share.wpPlugin")}
            </a>
            {" · "}
            <button
              type="button"
              onClick={onPackage}
              className="font-medium text-ink-2 underline underline-offset-2 hover:text-ink"
            >
              {t("share.wpPackageLink")}
            </button>
          </p>
        ) : null}
      </Body>
      {tag ? (
        <Footer>
          <span className="flex-1 max-sm:hidden" />
          <Button className="max-sm:w-full" onClick={() => copy("code", tag)}>
            {copied === "code" ? <Check className="size-4" /> : <Copy className="size-4" />}
            {copied === "code" ? t("share.copied") : t("share.copyCode")}
          </Button>
        </Footer>
      ) : null}
    </>
  );
}

/**
 * The wizard as a package for a WordPress site without an account: what it needs there, in the
 * gallery's words, and the project's pages along if wanted.
 */
function PackageView({ wizard }: { wizard: WizardDetail }) {
  const fit = useStandalone(wizard.draft);
  const [knowledge, setKnowledge] = useState(false);
  const query = [wizard.published ? "published=1" : "", knowledge ? "knowledge=1" : ""]
    .filter(Boolean)
    .join("&");
  const href = `/api/studio/wizards/${wizard.id}/export${query ? `?${query}` : ""}`;
  return (
    <>
      <Body className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <FitChip fit={fit.fit} />
        </div>
        <p className="text-[0.8125rem] text-ink-2">{t("share.wpLocalHint")}</p>
        <NeedList def={wizard.draft} fit={fit} />
        {fit.fit === "no" ? null : (
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-[0.875rem]">{t("share.wpKnowledge")}</div>
              <p className="text-[0.75rem] text-ink-3">{t("share.wpKnowledgeHint")}</p>
            </div>
            <Switch checked={knowledge} onChange={setKnowledge} label={t("share.wpKnowledge")} />
          </div>
        )}
        <p className="text-[0.75rem] text-ink-3">{t("share.wpHelp")}</p>
      </Body>
      {fit.fit === "no" ? null : (
        <Footer>
          <span className="flex-1 max-sm:hidden" />
          <Button className="max-sm:w-full" onClick={() => window.open(withBase(href), "_blank")}>
            <Download className="size-4" />
            {t(wizard.published ? "share.wpPackage" : "share.wpPackageDraft")}
          </Button>
        </Footer>
      )}
    </>
  );
}

/**
 * How the link is shared: how many runs a day, the channels' own settings (a keyword), a new
 * address. With an account linked the copy in the cloud follows each change.
 */
function SettingsView({
  wizard,
  ways,
  cloudCopy,
  onDone,
}: {
  wizard: WizardDetail;
  ways: Way[];
  cloudCopy: boolean;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const id = useId();
  const [limit, setLimit] = useState(String(wizard.dailyRunLimit));
  const { shareSections } = useStudioPlugins();
  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ["wizard", wizard.id] }),
      qc.invalidateQueries({ queryKey: ["wizards"] }),
      qc.invalidateQueries({ queryKey: ["wizard-runners", wizard.id] }),
    ]);
  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.patch(`/api/studio/wizards/${wizard.id}`, body),
    onSuccess: refresh,
  });
  const rotate = useMutation({
    mutationFn: () =>
      api.post<{ cloud: CloudState | null }>(`/api/studio/wizards/${wizard.id}/rotate-link`),
    onSuccess: ({ cloud: next }) => {
      if (next) {
        qc.setQueryData(["cloud", wizard.id], { linked: true, ...next });
      }
      return refresh();
    },
  });
  /** Shown and run here, changed in the local install: how it is shared is set there. */
  const locked = wizard.readOnly;
  const failed = patch.error ?? rotate.error;
  const estimate = useEstimate(wizard.id, wizard.draft);
  const perDay =
    estimate.data?.available && estimate.data.reserve > 0
      ? Math.round(estimate.data.reserve * (Number(limit) || wizard.dailyRunLimit))
      : null;
  // A channel's own settings, from its plugin: the keyword that picks the wizard there.
  const own = ways.flatMap((way) => {
    const section = way.problem ? null : shareSections.find((s) => s.runner === way.id);
    return section ? [{ way, section }] : [];
  });
  return (
    <>
      <Body className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <label htmlFor={id} className="font-medium text-[0.875rem]">
            {t("share.limit")}
          </label>
          <div className="flex items-center gap-2.5">
            <Input
              id={id}
              inputMode="numeric"
              className="w-24 text-right"
              disabled={locked}
              value={limit}
              onChange={(e) => setLimit(e.target.value.replace(/\D/g, ""))}
              onBlur={() => {
                const n = Number(limit);
                if (n >= 1 && n !== wizard.dailyRunLimit) {
                  patch.mutate({ dailyRunLimit: n });
                }
              }}
            />
            <span className="text-[0.875rem] text-ink-2">{t("share.runs")}</span>
          </div>
          {perDay !== null && estimate.data ? (
            <p className="text-[0.8125rem] text-ink-3 tabular-nums">
              {t("estimate.share", {
                run: Math.round(estimate.data.credits).toLocaleString(lang),
                day: perDay.toLocaleString(lang),
              })}
            </p>
          ) : null}
        </div>
        <TranslationsSection
          wizard={wizard}
          locked={locked}
          onPatch={(body) => patch.mutate(body)}
        />
        {locked
          ? null
          : own.map(({ way, section }) => (
              <div key={way.id} className="flex flex-col gap-2">
                <span className="flex items-center gap-1.5 text-[0.75rem] text-ink-3">
                  {way.icon} {way.name}
                </span>
                <PluginFrame of={section}>
                  <section.component wizard={{ id: wizard.id, title: wizard.draft.title }} />
                </PluginFrame>
              </div>
            ))}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3 border-border-soft border-t pt-5">
          <div className="min-w-0 flex-[1_1_14rem]">
            <div className="font-medium text-[0.875rem]">{t("share.newLink")}</div>
            <p className="text-[0.8125rem] text-ink-3">
              {t(cloudCopy ? "share.rotateCloud" : "share.rotateHint")}
            </p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            busy={rotate.isPending}
            disabled={locked}
            onClick={() => rotate.mutate()}
          >
            {rotate.isSuccess ? <Check className="size-3.5" /> : <RefreshCw className="size-3.5" />}
            {t(rotate.isSuccess ? "share.rotated" : "share.rotate")}
          </Button>
        </div>
        {locked ? <p className="text-[0.8125rem] text-ink-3">{t("share.readOnly")}</p> : null}
        {failed ? <p className="text-[0.8125rem] text-rose">{(failed as Error).message}</p> : null}
      </Body>
      <Footer>
        <span className="flex-1 max-sm:hidden" />
        <Button className="max-sm:w-full" onClick={onDone}>
          {t("share.done")}
        </Button>
      </Footer>
    </>
  );
}

/** The channels it runs as, changed: the list of the new-wizard page. */
/** Where a runner's setup puts its buttons: the dialog's foot. */
const ActionsSlot = createContext<HTMLElement | null>(null);

function SetupActions({ children }: { children: ReactNode }) {
  const slot = useContext(ActionsSlot);
  return slot ? createPortal(children, slot) : null;
}

/** A runner's setup from its plugin, inside the dialog: "Einrichten" of its row. */
function SetupView({
  wizard,
  setup,
  onDone,
}: {
  wizard: WizardDetail;
  setup: StudioPlugins["shareSetups"][number];
  onDone: (banner?: SetupBanner) => void;
}) {
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  const Setup = setup.component;
  return (
    <ActionsSlot.Provider value={slot}>
      <Body>
        <PluginFrame of={setup}>
          <Setup
            wizard={{ id: wizard.id, title: wizard.draft.title }}
            Actions={SetupActions}
            done={onDone}
          />
        </PluginFrame>
      </Body>
      <div
        ref={setSlot}
        className="flex shrink-0 flex-wrap items-center gap-2 border-border-soft border-t px-4 py-3.5 empty:hidden sm:px-5"
      />
    </ActionsSlot.Provider>
  );
}

function ChannelsView({
  wizard,
  answer,
  onDone,
}: {
  wizard: WizardDetail;
  answer: RunnersAnswer | undefined;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const patch = useMutation({
    mutationFn: (settings: RunnerSettings) =>
      api.patch(`/api/studio/wizards/${wizard.id}`, { runners: settings }),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ["wizard-runners", wizard.id] }),
        qc.invalidateQueries({ queryKey: ["wizard", wizard.id] }),
        qc.invalidateQueries({ queryKey: ["wizards"] }),
      ]),
  });
  const value = channelsOfRunners(patch.variables?.enabled ?? answer?.settings.enabled ?? []);
  return (
    <>
      <Body>
        <ChannelList
          value={value}
          onChange={(ids) => patch.mutate(runnerSettingsOf(ids))}
          runners={answer?.runners}
          without={["wacall"]}
          disabled={wizard.readOnly}
        />
        {patch.error ? (
          <p className="mt-3 text-[0.8125rem] text-rose">{(patch.error as Error).message}</p>
        ) : null}
      </Body>
      <Footer>
        <span className="flex-1 max-sm:hidden" />
        <Button className="max-sm:w-full" onClick={onDone}>
          {t("share.done")}
        </Button>
      </Footer>
    </>
  );
}

/** What the dialog shows, while it is open. */
function SharePanel({
  wizard,
  onClose,
  publish,
}: {
  wizard: WizardDetail;
  onClose: () => void;
  publish?: Publish;
}) {
  const qc = useQueryClient();
  const account = useFeature("account");
  const me = useMe();
  const local = me.data?.mode === "local";
  // A local install with an account sends what it publishes on to the account's cloud.
  const linked = local && Boolean(me.data?.account);
  const cloud = useCloud(wizard.id, linked);
  const where: WhereItRuns = me.data
    ? whereItRuns(wizard, me.data, linked ? cloud.data : null)
    : { kind: "unknown" };
  const base = sharedLink(where);
  const here = where.kind === "here";
  // A local runtime answers only on this computer: its QR code and ID are the cloud copy's.
  const own = me.data?.mode === "managed" && wizard.published;
  const appCode = useQuery({
    queryKey: ["wizard-code", wizard.id, wizard.shareToken],
    queryFn: () => api.get<{ code: string }>(`/api/studio/wizards/${wizard.id}/code`),
    enabled: own,
  });
  const runners = useQuery({
    queryKey: ["wizard-runners", wizard.id, wizard.revision],
    queryFn: () => api.get<RunnersAnswer>(`/api/studio/wizards/${wizard.id}/runners`),
  });
  const access = useMutation({
    mutationFn: (shareEnabled: boolean) =>
      api.patch(`/api/studio/wizards/${wizard.id}`, { shareEnabled }),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ["wizard", wizard.id] }),
        qc.invalidateQueries({ queryKey: ["wizards"] }),
      ]),
  });
  const [view, setView] = useState<View>("main");
  const { copied, copy } = useCopy();
  const navigate = useNavigate();
  const { sections, shareSetups } = useStudioPlugins();
  /** The runner whose setup the dialog shows, and what its setup said when it went back. */
  const [setupOf, setSetupOf] = useState<string | null>(null);
  const [setupBanner, setSetupBanner] = useState<SetupBanner | null>(null);
  const setup = setupOf ? shareSetups.find((s) => s.runner === setupOf) : undefined;
  /** "Einrichten": the runner's setup in here, else its plugin's settings, the models for the built-in ones. */
  const setUp = (way: Pick<Way, "id" | "plugin">) => {
    if (shareSetups.some((s) => s.runner === way.id)) {
      setSetupOf(way.id);
      setSetupBanner(null);
      setView("setup");
      return;
    }
    const section = sections.find((s) => s.plugin === way.plugin);
    navigate(section ? `/settings/${section.id}` : "/settings/models");
  };
  const setupDone = (banner?: SetupBanner) => {
    setSetupBanner(banner ?? null);
    setView("main");
    void qc.invalidateQueries({ queryKey: ["wizard-runners", wizard.id] });
  };
  const plansUrl =
    me.data?.mode === "managed" && me.data.manageUrl ? `${me.data.manageUrl}/billing` : null;
  // Shared for the first time: it goes live as the dialog opens. Nobody has the link yet, and
  // "Nur du" keeps it closed.
  const [firstShare, setFirstShare] = useState<"publishing" | "done" | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const tried = useRef(false);
  useEffect(() => {
    if (tried.current || wizard.published || wizard.readOnly || !publish || publish.disabled) {
      return;
    }
    tried.current = true;
    setFirstShare("publishing");
    publish
      .run()
      .then(() => setFirstShare("done"))
      .catch((err: Error) => {
        setFirstShare(null);
        setFailed(err.message);
      });
  }, [wizard.published, wizard.readOnly, publish]);

  const ways = useMemo(
    () => (runners.data ? waysOf(runners.data, base) : []),
    [runners.data, base],
  );
  // A runner's news, drawn by its plugin: the first one of the runners that are on.
  const notice = ways
    .map((w) => shareSetups.find((s) => s.runner === w.id && s.notice))
    .find(Boolean);
  const blocked = !wizard.published || here || !wizard.shareEnabled || !base;
  const first = ways.find((w) => w.copy?.text === base);

  // Tall enough for its channels from the start; it never gets shorter while open.
  const groups = new Set(ways.map((w) => w.group)).size;
  const wanted = Math.min(
    720,
    Math.max(
      580,
      300 + groups * 28 + ways.length * 52 + (wizard.published && !wizard.dirty ? 0 : 96),
    ),
  );
  const [height, setHeight] = useState(wanted);
  useEffect(() => setHeight((h) => Math.max(h, wanted)), [wanted]);

  let note: string | null = null;
  if (wizard.published && !here && !wizard.shareEnabled) {
    note = t("share.offNote");
  } else if (first && ways.length > 1) {
    const how =
      first.id === "steps" ? t("share.opensSteps") : t("share.opensAs", { name: first.name });
    note = t("share.linkNote", { how });
  }

  const back = () => setView(view === "package" ? "website" : "main");
  const title = wizard.draft.title;
  const heading =
    view === "main"
      ? t("share.titleOf", { title })
      : view === "setup"
        ? (setup?.title() ?? "")
        : t(HEADINGS[view]);

  return (
    <div
      style={{ "--share-h": `${height}px` } as CSSProperties}
      className="mx-auto flex w-full flex-col overflow-hidden bg-card text-ink shadow-overlay max-sm:h-dvh max-sm:pt-[env(safe-area-inset-top)] max-sm:pb-[env(safe-area-inset-bottom)] sm:h-[min(var(--share-h),calc(100dvh-32px))] sm:max-w-[34rem] sm:rounded-2xl"
    >
      <div className="flex shrink-0 items-center gap-1 px-2 pt-3 pb-1 sm:px-3 sm:pt-4">
        {view === "main" ? null : (
          <IconButton label={t("share.back")} onClick={back}>
            <ChevronLeft className="size-5" />
          </IconButton>
        )}
        <h2
          className={cn(
            "min-w-0 flex-1 truncate font-display font-semibold text-xl",
            view === "main" && "pl-2 sm:pl-3",
          )}
        >
          {heading}
        </h2>
        {view === "main" ? (
          <IconButton label={t("share.settings")} onClick={() => setView("settings")}>
            <Gear className="size-[1.125rem]" />
          </IconButton>
        ) : null}
        <IconButton label={t("share.close")} onClick={onClose}>
          <X className="size-5" />
        </IconButton>
      </div>

      {view === "main" ? (
        <>
          <Body className="flex flex-col gap-6">
            {firstShare === "publishing" ? (
              <Banner>
                <span className="flex items-center gap-2">
                  <Spinner className="size-4 text-ink-3" /> {t("share.publishing")}
                </span>
              </Banner>
            ) : null}
            {firstShare === "done" && wizard.published ? (
              <Banner done title={t("share.firstTitle")}>
                {t("share.firstText", { v: wizard.publishedVersion ?? 1 })}
              </Banner>
            ) : null}
            {!wizard.published && !firstShare ? (
              <Banner
                warn
                title={t(wizard.issues.length ? "share.notReady" : "share.notPublished")}
                action={
                  wizard.issues.length && publish?.fix ? (
                    <Button size="sm" variant="secondary" onClick={publish.fix}>
                      {t("editor.fixWithChat")}
                    </Button>
                  ) : null
                }
              >
                {wizard.issues.length ? (
                  <>
                    <p>{t("share.notReadyHint")}</p>
                    <ul className="mt-1 list-disc pl-5">
                      {wizard.issues.slice(0, 4).map((issue, i) => (
                        <li key={i}>{issue.message}</li>
                      ))}
                    </ul>
                  </>
                ) : (
                  (failed ?? t(wizard.readOnly ? "share.readOnly" : "share.stillBuilding"))
                )}
              </Banner>
            ) : null}
            {wizard.published && wizard.dirty && !wizard.readOnly && !firstShare ? (
              <Banner
                action={
                  publish ? (
                    <Button size="sm" onClick={publish.goLive}>
                      {t("live.open")}
                    </Button>
                  ) : null
                }
              >
                {t("share.changes", { v: wizard.publishedVersion ?? 0 })}
              </Banner>
            ) : null}
            {setupBanner ? (
              <Banner done={setupBanner.tone !== "waiting"} title={setupBanner.title}>
                {setupBanner.text}
              </Banner>
            ) : notice?.notice ? (
              <PluginFrame of={notice}>
                <notice.notice
                  wizard={{ id: wizard.id, title }}
                  open={() => setUp({ id: notice.runner, plugin: notice.plugin })}
                />
              </PluginFrame>
            ) : null}
            {here && wizard.published ? <LocalOffer account={account} /> : null}
            {linked && wizard.published ? (
              <CloudProblem wizard={wizard} where={where} cloud={cloud.data} />
            ) : null}
            {cloud.isError ? (
              <p className="text-[0.8125rem] text-rose">{(cloud.error as Error).message}</p>
            ) : null}
            <Access wizard={wizard} here={here} onChange={(on) => access.mutate(on)} />
            {access.error ? (
              <p className="-mt-4 text-[0.8125rem] text-rose">{(access.error as Error).message}</p>
            ) : null}
            {runners.data ? (
              <Ways
                ways={ways}
                blocked={blocked}
                locked={wizard.readOnly}
                note={note}
                copied={copied}
                copy={copy}
                onChange={() => setView("channels")}
                onSetUp={setUp}
                plansUrl={plansUrl}
              />
            ) : null}
          </Body>
          <Footer>
            <Button
              variant="ghost"
              className="max-sm:flex-1"
              disabled={blocked}
              onClick={() => setView("qr")}
            >
              <QrCode className="size-4" /> {t("share.qr")}
            </Button>
            <Button variant="ghost" className="max-sm:flex-1" onClick={() => setView("website")}>
              <Code className="size-4" /> {t("share.website")}
            </Button>
            <span className="flex-1 max-sm:hidden" />
            <Button
              className="max-sm:order-first max-sm:w-full"
              disabled={blocked}
              onClick={() => base && copy("main", base)}
            >
              {copied === "main" ? <Check className="size-4" /> : <Link2 className="size-4" />}
              {copied === "main" ? t("share.copied") : t("share.copyMain")}
            </Button>
          </Footer>
        </>
      ) : null}
      {view === "qr" ? (
        <QrView
          ways={ways}
          title={title}
          base={base}
          code={own ? appCode.data?.code : cloud.data?.copy?.code}
        />
      ) : null}
      {view === "website" ? (
        <WebsiteView
          url={blocked ? null : base}
          title={title}
          enabled={runners.data?.settings.enabled ?? []}
          wordpress={account}
          onPackage={() => setView("package")}
        />
      ) : null}
      {view === "package" ? <PackageView wizard={wizard} /> : null}
      {view === "settings" ? (
        <SettingsView
          wizard={wizard}
          ways={ways}
          cloudCopy={Boolean(cloud.data?.copy)}
          onDone={() => setView("main")}
        />
      ) : null}
      {view === "channels" ? (
        <ChannelsView wizard={wizard} answer={runners.data} onDone={() => setView("main")} />
      ) : null}
      {view === "setup" && setup ? (
        <SetupView wizard={wizard} setup={setup} onDone={setupDone} />
      ) : null}
    </div>
  );
}

/**
 * Hands out a wizard: who may open it, the ways others reach it, the link to copy. A local
 * install's own link answers only on this computer: with an account, the link is its copy's in
 * the cloud.
 */
export function ShareDialog({
  wizard,
  open,
  onClose,
  publish,
}: {
  wizard: WizardDetail;
  open: boolean;
  onClose: () => void;
  /** The editor's publishing; none where nothing is changed here. */
  publish?: Publish;
}) {
  return (
    <Dialog open={open} onClose={onClose} bare wide>
      <SharePanel wizard={wizard} onClose={onClose} publish={publish} />
    </Dialog>
  );
}
