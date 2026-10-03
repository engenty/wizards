import type { RunView } from "@engenty-wizards/shared/run";
import type { ShareIcon, ShareJobView, ShareOverview } from "@engenty-wizards/shared/sharing";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Copy,
  FolderUp,
  Globe,
  Link2,
  type LucideIcon,
  Mail,
  MessageSquare,
  Plug,
  Share2,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { appCall, appCan } from "../lib/app";
import { lang, t } from "../lib/i18n";
import { Button, cn, Dialog, IconButton, Spinner } from "../ui";
import { ShareJob } from "./ShareJob";
import { type ShareDraft, ShareTargetFlow } from "./ShareTargetFlow";

interface Shared {
  url: string;
  expiresAt: string | null;
}

function intents(url: string, title: string) {
  const u = encodeURIComponent(url);
  const text = encodeURIComponent(title);
  return [
    {
      id: "mail",
      label: t("shareRun.email"),
      href: `mailto:?subject=${text}&body=${text}%0A%0A${u}`,
    },
    { id: "x", label: "X", href: `https://x.com/intent/post?text=${text}&url=${u}` },
    {
      id: "linkedin",
      label: "LinkedIn",
      href: `https://www.linkedin.com/sharing/share-offsite/?url=${u}`,
    },
    { id: "whatsapp", label: "WhatsApp", href: `https://wa.me/?text=${text}%20${u}` },
    {
      id: "facebook",
      label: "Facebook",
      href: `https://www.facebook.com/sharer/sharer.php?u=${u}`,
    },
  ];
}

const MONOGRAM: Record<string, string> = { x: "𝕏", linkedin: "in", whatsapp: "WA", facebook: "f" };

export const TARGET_ICON: Record<ShareIcon, LucideIcon> = {
  mail: Mail,
  folder: FolderUp,
  chat: MessageSquare,
  plug: Plug,
  globe: Globe,
};

/** Where the sheet stands: the choice of targets, the link, one target's steps, or a job at work. */
type Screen =
  | { at: "home" }
  | { at: "link" }
  | { at: "target"; key: string }
  | { at: "job"; id: string; key: string | null };

/**
 * "Teilen" on a finished result: the link, or a target that sends or publishes it — by e-mail,
 * into a folder, to a channel, onto a website. Each target walks the person through its steps.
 */
export function ShareResultButton({ view, title }: { view: RunView; title: string }) {
  const runId = view.id;
  const [open, setOpen] = useState(false);
  const [screen, setScreen] = useState<Screen>({ at: "home" });
  const [overview, setOverview] = useState<ShareOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, ShareDraft>>({});
  const working = view.shareJob?.status === "running" ? view.shareJob : null;

  const load = useCallback(async () => {
    try {
      setOverview(await api.get<ShareOverview>(`/api/runs/${runId}/share/targets?lang=${lang}`));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [runId]);

  const start = () => {
    setOpen(true);
    // A result that is already on its way is what the person comes back to.
    setScreen(working ? { at: "job", id: working.id, key: null } : { at: "home" });
    void load();
  };

  // An account connected in a popup or with its form: the run's stream tells, the sheet reads again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new view is the signal
  useEffect(() => {
    if (open && screen.at === "target") {
      void load();
    }
  }, [open, screen.at, view, load]);
  // A job that ended belongs to the list of what was sent.
  const jobStatus = view.shareJob?.status;
  useEffect(() => {
    if (open && jobStatus && jobStatus !== "running") {
      void load();
    }
  }, [open, jobStatus, load]);

  const target =
    screen.at === "target" || screen.at === "job"
      ? overview?.targets.find((x) => x.key === screen.key)
      : undefined;
  const job =
    screen.at === "job"
      ? view.shareJob?.id === screen.id
        ? view.shareJob
        : overview?.jobs.find((j) => j.id === screen.id)
      : undefined;
  const back =
    screen.at === "home" || (screen.at === "job" && job?.status === "running")
      ? null
      : () => setScreen({ at: "home" });

  return (
    <>
      <Button variant="secondary" onClick={start}>
        {working ? <Spinner className="size-4" /> : <Share2 className="size-4" />}{" "}
        {t("shareRun.button")}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        wide
        title={
          <span className="flex items-center gap-1">
            {back ? (
              <IconButton label={t("run.back")} onClick={back} className="-my-1.5 -ml-2">
                <ArrowLeft className="size-4" />
              </IconButton>
            ) : null}
            {screen.at === "link"
              ? t("shareRun.linkTitle")
              : (target?.name ?? job?.name ?? t("shareRun.title"))}
          </span>
        }
      >
        {screen.at === "link" ? (
          <LinkView view={view} title={title} onWithdrawn={() => setScreen({ at: "home" })} />
        ) : screen.at === "target" && target ? (
          <ShareTargetFlow
            key={target.key}
            view={view}
            target={target}
            draft={drafts[target.key]}
            onStarted={(started, draft) => {
              setDrafts((d) => ({ ...d, [target.key]: draft }));
              setScreen({ at: "job", id: started.id, key: target.key });
            }}
          />
        ) : screen.at === "job" && job ? (
          <ShareJob
            runId={runId}
            job={job}
            onAgain={
              screen.key ? () => setScreen({ at: "target", key: screen.key as string }) : null
            }
            onHome={() => setScreen({ at: "home" })}
          />
        ) : error ? (
          <p className="rounded-lg bg-rose-tint px-3 py-2 text-[0.875rem] text-rose">{error}</p>
        ) : !overview ? (
          <div className="flex justify-center py-8 text-ink-4">
            <Spinner />
          </div>
        ) : (
          <Home
            overview={overview}
            onLink={() => setScreen({ at: "link" })}
            onTarget={(key) => setScreen({ at: "target", key })}
            onJob={(id) => setScreen({ at: "job", id, key: null })}
          />
        )}
      </Dialog>
    </>
  );
}

function Tile({
  icon: Icon,
  name,
  description,
  onClick,
}: {
  icon: LucideIcon;
  name: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex items-center gap-3 rounded-xl bg-card p-3 text-left ring-1 ring-input transition hover:ring-ember"
    >
      <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-paper-2 text-ink-2 transition group-hover:bg-ember-tint group-hover:text-ember-strong">
        <Icon className="size-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-[0.9375rem]">{name}</span>
        <span className="block text-[0.8125rem] text-ink-3 leading-snug">{description}</span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-ink-4 transition group-hover:text-ember-strong" />
    </button>
  );
}

function when(iso: string): string {
  return new Intl.DateTimeFormat(lang, { dateStyle: "short", timeStyle: "short" }).format(
    new Date(iso),
  );
}

/** The first step of every way to share: pick where the result goes. */
function Home({
  overview,
  onLink,
  onTarget,
  onJob,
}: {
  overview: ShareOverview;
  onLink: () => void;
  onTarget: (key: string) => void;
  onJob: (id: string) => void;
}) {
  const sent = overview.jobs.filter((j) => j.status !== "cancelled");
  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-2.5 sm:grid-cols-2">
        <Tile
          icon={Link2}
          name={t("share.link")}
          description={t("shareRun.linkHint")}
          onClick={onLink}
        />
        {overview.targets.map((target) => (
          <Tile
            key={target.key}
            icon={TARGET_ICON[target.icon]}
            name={target.name}
            description={target.description}
            onClick={() => onTarget(target.key)}
          />
        ))}
      </div>
      {sent.length ? (
        <div>
          <div className="mb-2 font-medium text-[0.75rem] text-ink-3 uppercase tracking-[0.06em]">
            {t("shareRun.recent")}
          </div>
          <ul className="overflow-hidden rounded-lg ring-1 ring-border-soft">
            {sent.slice(0, 5).map((job) => (
              <li key={job.id} className="border-border-soft border-b last:border-0">
                <button
                  type="button"
                  onClick={() => onJob(job.id)}
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[0.8125rem] hover:bg-paper-2 coarse:min-h-11"
                >
                  <JobDot job={job} />
                  <span className="shrink-0 font-medium">{job.name}</span>
                  <span className="min-w-0 flex-1 truncate text-ink-3">
                    {job.result?.summary ?? job.error ?? t("shareRun.working")}
                  </span>
                  <span className="shrink-0 text-ink-4 tabular-nums">{when(job.createdAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function JobDot({ job }: { job: ShareJobView }) {
  return job.status === "running" ? (
    <Spinner className="size-3.5 shrink-0 text-ember" />
  ) : (
    <span
      className={cn(
        "size-2 shrink-0 rounded-full",
        job.status === "done" ? "bg-moss" : job.status === "failed" ? "bg-rose" : "bg-ink-4",
      )}
    />
  );
}

/** One link, then wherever the person wants to send it. */
function LinkView({
  view,
  title,
  onWithdrawn,
}: {
  view: RunView;
  title: string;
  onWithdrawn: () => void;
}) {
  const runId = view.id;
  const [shared, setShared] = useState<Shared | null>(
    view.shareUrl ? { url: view.shareUrl, expiresAt: view.expiresAt } : null,
  );
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (shared) {
      return;
    }
    let alive = true;
    api
      .post<Shared>(`/api/runs/${runId}/share`)
      .then((made) => alive && setShared(made))
      .catch((err) => alive && setError((err as Error).message));
    return () => {
      alive = false;
    };
  }, [runId, shared]);

  const withdraw = async () => {
    await api.del(`/api/runs/${runId}/share`);
    onWithdrawn();
  };
  const copy = () => {
    if (!shared) {
      return;
    }
    void navigator.clipboard.writeText(shared.url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const canNativeShare =
    appCan("share") || (typeof navigator !== "undefined" && "share" in navigator);
  const until = shared?.expiresAt
    ? new Intl.DateTimeFormat(lang, { dateStyle: "long" }).format(new Date(shared.expiresAt))
    : null;

  if (error) {
    return <p className="rounded-lg bg-rose-tint px-3 py-2 text-[0.875rem] text-rose">{error}</p>;
  }
  if (!shared) {
    return (
      <div className="flex justify-center py-8 text-ink-4">
        <Spinner />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-2 rounded-xl bg-paper-2 p-1.5 pl-3">
        <Link2 className="size-4 shrink-0 text-ink-3" />
        <input
          readOnly
          value={shared.url}
          onFocus={(e) => e.target.select()}
          aria-label={t("share.link")}
          className="min-w-0 flex-1 bg-transparent text-[0.875rem] outline-none coarse:h-11"
        />
        <Button size="sm" onClick={copy}>
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? t("share.copied") : t("share.copy")}
        </Button>
      </div>
      <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
        {intents(shared.url, title).map((intent) => (
          <a
            key={intent.id}
            href={intent.href}
            target="_blank"
            rel="noreferrer"
            className="flex flex-col items-center gap-1.5 text-[0.75rem] text-ink-2 hover:text-ink"
          >
            <span className="inline-flex size-12 items-center justify-center rounded-full bg-paper-2 font-semibold text-[0.9375rem] transition hover:bg-paper-3">
              {intent.id === "mail" ? <Mail className="size-5" /> : MONOGRAM[intent.id]}
            </span>
            {intent.label}
          </a>
        ))}
        {canNativeShare ? (
          <button
            type="button"
            onClick={() =>
              void (
                appCan("share")
                  ? appCall("share", { link: shared.url, title })
                  : navigator.share({ title, url: shared.url })
              ).catch(() => undefined)
            }
            className="flex flex-col items-center gap-1.5 text-[0.75rem] text-ink-2 hover:text-ink"
          >
            <span className="inline-flex size-12 items-center justify-center rounded-full bg-paper-2 transition hover:bg-paper-3">
              <Share2 className="size-5" />
            </span>
            {t("shareRun.more")}
          </button>
        ) : null}
      </div>
      <div className="flex items-center justify-between gap-3 text-[0.8125rem] text-ink-3">
        <span>{until ? t("shareRun.until", { date: until }) : t("shareRun.kept")}</span>
        <button
          type="button"
          onClick={() => void withdraw()}
          className="shrink-0 hover:text-rose coarse:min-h-11"
        >
          {t("shareRun.withdraw")}
        </button>
      </div>
    </div>
  );
}
