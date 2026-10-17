import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUpRight,
  BookOpen,
  Check,
  CloudOff,
  Copy,
  Fingerprint,
  Inbox,
  Laptop,
  type LucideIcon,
  PencilLine,
  Plug,
  Plus,
  Radio,
  Search,
  Sparkles,
  Wand2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Navigate, useNavigate } from "react-router";
import { Mascot } from "../brand";
import { api } from "../lib/api";
import { useFeature } from "../lib/features";
import { type Key, lang, t } from "../lib/i18n";
import {
  type Me,
  useCurrentProject,
  useMayBuild,
  useMayCreate,
  useMe,
  type WizardSummary,
} from "../lib/session";
import { Button, Card, Chip, cn, Dialog, Empty, IconButton, Input, Select } from "../ui";
import { LinkStatus, useAccountLink } from "./Account";
import { ChannelIcons, type Runner, useRunners } from "./channels";
import { openExternal } from "./LocalRuntime";
import { MarketplaceHits } from "./Marketplace";
import { WizardMenu } from "./WizardMenu";
import { ownLink, sharedLink, WhereChip, whereItRuns } from "./where";

/** What a space holds, row by row: its own wizards and what they share. */
const SPACE_HOLDS: { icon: LucideIcon; name: () => string; what: Key }[] = [
  { icon: Wand2, name: () => t("nav.wizards"), what: "space.holds.wizards" },
  { icon: Fingerprint, name: () => t("space.info"), what: "space.holds.info" },
  {
    icon: BookOpen,
    name: () => `${t("space.knowledge")} & ${t("space.data")}`,
    what: "space.holds.knowledge",
  },
  { icon: Plug, name: () => t("connectors.title"), what: "space.holds.connectors" },
  { icon: Inbox, name: () => t("space.results"), what: "space.holds.results" },
];

/** Names a new space and makes it the one the studio looks at; says first what a space is. */
export function NewSpaceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { select } = useCurrentProject();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: () => api.post<{ id: string }>("/api/studio/projects", { name }),
    onSuccess: async ({ id }) => {
      await qc.invalidateQueries({ queryKey: ["projects"] });
      select(id);
      setName("");
      onClose();
    },
  });
  return (
    <Dialog open={open} onClose={onClose} title={t("home.newProject")}>
      <p className="-mt-2 text-[0.875rem] text-ink-2">{t("space.holds.intro")}</p>
      <dl className="mt-4 flex flex-col gap-2.5 text-[0.8125rem]">
        {SPACE_HOLDS.map((row) => (
          <div key={row.what} className="flex items-start gap-2.5">
            <row.icon className="mt-0.5 size-4 shrink-0 text-ink-3" />
            <dt className="w-28 shrink-0 font-medium text-ink">{row.name()}</dt>
            <dd className="min-w-0 text-ink-3">{t(row.what)}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-[0.8125rem] text-ink-4">{t("space.holds.shared")}</p>
      <form
        className="mt-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) {
            create.mutate();
          }
        }}
      >
        <Input
          autoFocus
          placeholder={t("home.projectName")}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" busy={create.isPending} disabled={!name.trim()}>
            {t("home.newProject")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Picks the project the studio looks at. Nothing where the tenant works with one project. */
export function ProjectSwitcher() {
  const { project, projects, select } = useCurrentProject();
  // Null: as many as wanted.
  const limit = useMe().data?.limits.projects ?? 1;
  const mayCreate = useMayCreate();
  const [open, setOpen] = useState(false);
  if (!project || (limit !== null && limit <= 1)) {
    return null;
  }
  return (
    <div className="flex items-center gap-2">
      <Select
        className="w-56"
        value={project.id}
        onChange={(v) => (v === "__new" ? setOpen(true) : select(v))}
        options={[
          ...projects.map((p) => ({ value: p.id, label: p.name })),
          // A tenant that builds nothing here makes no project here either; nor does a member.
          ...(mayCreate
            ? [
                limit === null || projects.length < limit
                  ? { value: "__new", label: `+ ${t("home.newProject")}` }
                  : {
                      value: "__new",
                      label: t("home.projectLimit", { n: limit }),
                      disabled: true,
                    },
              ]
            : []),
        ]}
      />
      <NewSpaceDialog open={open} onClose={() => setOpen(false)} />
    </div>
  );
}

function CopyLink({ url }: { url: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard.writeText(url);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
      className="inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[0.8125rem] text-ink-3 hover:bg-accent hover:text-ink"
    >
      {done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {done ? t("share.copied") : t("share.link")}
    </button>
  );
}

/**
 * "Link" on a wizard that runs only on this computer: there is none to hand out. It says so, and
 * how there would be one — an account, whose cloud runs the wizard for everyone.
 */
function LinkTeaser() {
  const navigate = useNavigate();
  const linking = useAccountLink(false);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) {
      return;
    }
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    // Clicks in here stay here: the card around opens the editor.
    <div className="relative" ref={ref} onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[0.8125rem] text-ink-3 hover:bg-accent hover:text-ink"
      >
        <Copy className="size-3.5" /> {t("share.link")}
      </button>
      {open ? (
        <div className="absolute right-0 bottom-10 z-20 flex w-72 animate-rise flex-col gap-3 rounded-xl bg-card p-3.5 shadow-overlay ring-1 ring-border-soft">
          <p className="text-[0.8125rem] text-ink-2 leading-relaxed">{t("teaser.link")}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" busy={linking.link.isPending} onClick={() => linking.link.mutate({})}>
              {t("account.signIn")}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => navigate("/settings/account")}>
              {t("account.create")}
            </Button>
          </div>
          <LinkStatus {...linking} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * A wizard on the start page: where it runs, and the link others can open — this server's own,
 * or for a local install its copy's in the cloud. A wizard that runs only on this computer has
 * no link to hand out; it opens here.
 */
function WizardCard({ w, me, runners }: { w: WizardSummary; me: Me; runners: Runner[] }) {
  const account = useFeature("account");
  const navigate = useNavigate();
  const where = whereItRuns(w, me, w.cloud);
  const link = sharedLink(where);
  const open = link ?? (w.published ? ownLink(w) : null);
  return (
    // The engenty sits on the card's top edge, half above it; the chip stays inside the card.
    <div className="group/card relative pt-6">
      {/* Alive: it wobbles and its eye follows the pointer, as on the setup and the landing page. */}
      <div className="pointer-events-none absolute top-0 left-4 z-10">
        <Mascot kind={w.avatar} size={52} />
      </div>
      <Card
        className="relative flex h-full cursor-pointer flex-col px-5 pt-10 pb-3 transition hover:shadow-elevated"
        onClick={() => navigate(`/edit/${w.id}`)}
      >
        <div className="absolute top-3 right-3">
          {w.published ? <WhereChip where={where} me={me} /> : <Chip>{t("home.draft")}</Chip>}
        </div>
        <h3 className="font-display font-semibold text-[1.0625rem] leading-snug">{w.title}</h3>
        <p className="mt-1 line-clamp-2 text-[0.875rem] text-ink-3">{w.description}</p>
        <div className="mt-auto flex min-h-8 items-center justify-between pt-3">
          <span className="inline-flex items-center gap-2.5 text-[0.75rem] text-ink-4">
            {t("home.steps", { n: w.stepCount })}
            {/* The channels it runs through, the link's first. */}
            <ChannelIcons w={w} runners={runners} />
          </span>
          <div className="flex items-center">
            <WizardMenu
              wizard={w}
              className="opacity-0 transition group-hover/card:opacity-100 has-[[aria-expanded=true]]:opacity-100 focus-within:opacity-100 coarse:opacity-100"
            />
            {link ? (
              <CopyLink url={link} />
            ) : where.kind === "here" && account ? (
              <LinkTeaser />
            ) : null}
            {open ? (
              // The live wizard as a visitor sees it, outside the studio.
              <IconButton
                label={link ? t("share.open") : t("share.openHere")}
                className="ml-1 size-8"
                onClick={(e) => {
                  e.stopPropagation();
                  openExternal(open);
                }}
              >
                <ArrowUpRight className="size-4" />
              </IconButton>
            ) : null}
          </div>
        </div>
      </Card>
    </div>
  );
}

/** Where a wizard stands, as the cards' chips say it: not yet published, here, live, or amiss. */
type Status = "draft" | "here" | "live" | "missing";
const STATUSES: Status[] = ["draft", "here", "live", "missing"];
const STATUS_ICON: Record<Status, LucideIcon> = {
  draft: PencilLine,
  here: Laptop,
  live: Radio,
  missing: CloudOff,
};
const statusLabel = (status: Status) =>
  status === "draft"
    ? t("home.draft")
    : status === "here"
      ? t("where.here")
      : status === "live"
        ? t("home.live")
        : t("where.missing");
function statusOf(w: WizardSummary, me: Me): Status {
  const { kind } = whereItRuns(w, me, w.cloud);
  return kind === "draft" || kind === "here"
    ? kind
    : kind === "live" || kind === "unknown"
      ? "live"
      : "missing";
}

/** A row of pills: all the wizards, or those of one status — drawn once two statuses are in play. */
function StatusFilter({
  wizards,
  me,
  value,
  onChange,
}: {
  wizards: WizardSummary[];
  me: Me;
  value: Status | null;
  onChange: (next: Status | null) => void;
}) {
  const counts = new Map<Status, number>();
  for (const w of wizards) {
    const status = statusOf(w, me);
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  if (counts.size < 2) {
    return null;
  }
  const pill = (on: boolean) =>
    cn(
      "inline-flex h-8 items-center gap-1.5 rounded-full px-3 font-medium text-[0.8125rem] transition",
      on ? "bg-paper-2 text-ink" : "text-ink-3 hover:text-ink",
    );
  return (
    <div className="mt-5 flex flex-wrap items-center gap-1">
      <button type="button" className={pill(value === null)} onClick={() => onChange(null)}>
        {t("home.all")}
        <span className="text-[0.75rem] text-ink-4">{wizards.length}</span>
      </button>
      {STATUSES.filter((status) => counts.has(status)).map((status) => {
        const Icon = STATUS_ICON[status];
        return (
          <button
            key={status}
            type="button"
            aria-pressed={value === status}
            className={pill(value === status)}
            onClick={() => onChange(value === status ? null : status)}
          >
            <Icon className="size-3.5" />
            {statusLabel(status)}
            <span className="text-[0.75rem] text-ink-4">{counts.get(status)}</span>
          </button>
        );
      })}
    </div>
  );
}

/** More wizards than this — four rows of three — and the home is searched, not scrolled. */
const SEARCH_FROM = 12;
/** Fewer own hits than this, and the marketplace is asked as well. */
const FEW = 3;

/** The home's search, in the title's place: as the marketplace's, with the space's own words. */
function WizardSearch({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  return (
    <label className="relative flex h-10 w-full max-w-md items-center gap-2.5 rounded-full bg-card px-4 shadow-soft ring-1 ring-border-soft transition focus-within:ring-2 focus-within:ring-focus sm:h-11">
      <Search className="size-4 shrink-0 text-ink-3" />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t("home.search")}
        aria-label={t("home.search")}
        className="min-w-0 flex-1 bg-transparent text-[0.9375rem] outline-none placeholder:text-ink-4 [&::-webkit-search-cancel-button]:hidden"
      />
      {value ? (
        <button
          type="button"
          aria-label={t("market.reset")}
          onClick={() => onChange("")}
          className="-mr-1.5 flex size-7 shrink-0 items-center justify-center rounded-full text-ink-3 hover:bg-paper-2 hover:text-ink"
        >
          <X className="size-4" />
        </button>
      ) : null}
    </label>
  );
}

const INSTALL = "curl -fsSL https://engenty.ai/install.sh | bash";

/**
 * Nothing is built on this server, and nothing has arrived yet: wizards get here from the
 * person's own install. Three steps lead there.
 */
function FromLocal() {
  const [copied, setCopied] = useState(false);
  const steps = [t("home.local.install"), t("home.local.signIn"), t("home.local.publish")];
  return (
    <div className="mx-auto flex max-w-xl animate-rise flex-col items-center pt-4 text-center">
      <Mascot kind="round" size={120} />
      <h1 className="mt-2 font-display font-semibold text-[1.75rem] leading-tight tracking-tight">
        {t("home.local.title")}
      </h1>
      <p className="mt-3 text-[0.9375rem] text-ink-2 leading-relaxed">{t("home.local.text")}</p>
      <ol className="mt-8 flex w-full flex-col gap-4 text-left">
        {steps.map((step, i) => (
          <li key={step} className="flex gap-3">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-paper-2 font-medium text-[0.8125rem] text-ink-2">
              {i + 1}
            </span>
            <div className="min-w-0 flex-1 pt-0.5">
              <p className="text-[0.9375rem] leading-snug">{step}</p>
              {i === 0 ? (
                <div className="mt-2 flex items-center gap-2 rounded-lg bg-paper-2 py-1.5 pr-1.5 pl-3">
                  <code className="min-w-0 flex-1 select-all overflow-x-auto whitespace-nowrap font-mono text-[0.8125rem] text-ink-2">
                    {INSTALL}
                  </code>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      void navigator.clipboard.writeText(INSTALL);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    }}
                  >
                    {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                    {copied ? t("share.copied") : t("share.copy")}
                  </Button>
                </div>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function HomePage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { project, projects, loading } = useCurrentProject();
  const me = useMe().data;
  const build = useMayBuild();
  const create = useMayCreate();
  const wizards = useQuery({
    // Linked or not, the cards ask anew: where each wizard runs changes with it.
    queryKey: ["wizards", project?.id, Boolean(me?.account)],
    queryFn: () => api.get<WizardSummary[]>(`/api/studio/projects/${project!.id}/wizards`),
    enabled: Boolean(project),
  });
  const runners = useRunners().data ?? [];
  // One status to narrow the cards to, or all of them.
  const [status, setStatus] = useState<Status | null>(null);
  // Past a few rows the title gives way to a search over title and description.
  const [query, setQuery] = useState("");
  const searching = (wizards.data?.length ?? 0) > SEARCH_FROM;
  const q = searching ? query.trim().toLowerCase() : "";
  const shown = (wizards.data ?? []).filter(
    (w) =>
      (!status || !me || statusOf(w, me) === status) &&
      (!q || `${w.title} ${w.description}`.toLowerCase().includes(q)),
  );
  // Few own hits: the marketplace is asked the same, and a new one is offered.
  const beyond = Boolean(q) && shown.length < FEW;
  const fromEntry = useMutation({
    mutationFn: (starterId: string) =>
      api.post<{ id: string }>("/api/studio/wizards", { projectId: project!.id, starterId, lang }),
    onSuccess: async ({ id }) => {
      await qc.invalidateQueries({ queryKey: ["projects"] });
      await qc.invalidateQueries({ queryKey: ["wizards"] });
      navigate(`/edit/${id}`);
    },
  });
  const total = projects.reduce((n, p) => n + p.wizardCount, 0);
  /** Wizards are made in this project: the person makes things here, and the project is the team's own. */
  const canCreate = create && !project?.readOnly;
  if (!loading && canCreate && projects.length && total === 0) {
    return <Navigate to="/new" replace />;
  }
  // Nothing is built here and no install has sent anything yet: the way a wizard gets here.
  if (!loading && !build && projects.length === 0) {
    return <FromLocal />;
  }
  return (
    <div className="animate-rise">
      <div className="flex flex-wrap items-center justify-between gap-4">
        {searching ? (
          <WizardSearch value={query} onChange={setQuery} />
        ) : (
          <h1 className="font-display font-semibold text-[1.75rem] tracking-tight">
            {t("home.title", { space: project?.name ?? "" })}
          </h1>
        )}
        {canCreate ? (
          <Button onClick={() => navigate("/new")}>
            <Plus className="size-4" /> {t("home.new")}
          </Button>
        ) : null}
      </div>
      {project?.origin === "local" ? (
        <p className="mt-2 text-[0.875rem] text-ink-3">
          {t("home.fromLocal")}{" "}
          {project.syncedAt
            ? t("home.syncedAt", {
                when: new Intl.DateTimeFormat(lang, {
                  dateStyle: "medium",
                  timeStyle: "short",
                }).format(new Date(project.syncedAt)),
              })
            : null}
        </p>
      ) : null}
      {/* An empty space says so and, where wizards are made here, offers the first one. */}
      {wizards.data && wizards.data.length === 0 ? (
        <Empty>
          <p>{t("home.empty")}</p>
          {canCreate ? (
            <Button className="mt-5" onClick={() => navigate("/new")}>
              <Plus className="size-4" /> {t("home.new")}
            </Button>
          ) : null}
        </Empty>
      ) : null}
      {wizards.data?.length && me ? (
        <StatusFilter wizards={wizards.data} me={me} value={status} onChange={setStatus} />
      ) : null}
      {q && shown.length === 0 ? (
        <p className="mt-6 text-[0.875rem] text-ink-3">{t("home.noMatch")}</p>
      ) : null}
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {me ? shown.map((w) => <WizardCard key={w.id} w={w} me={me} runners={runners} />) : null}
      </div>
      {beyond ? (
        <>
          {canCreate ? (
            <MarketplaceHits
              query={query}
              busy={fromEntry.isPending}
              onUse={(entry) => project && !fromEntry.isPending && fromEntry.mutate(entry.id)}
            />
          ) : (
            <MarketplaceHits query={query} />
          )}
          {canCreate ? (
            <div className="mt-8 flex justify-center">
              <Button
                variant="secondary"
                onClick={() => navigate(`/new?wish=${encodeURIComponent(query.trim())}`)}
              >
                <Sparkles className="size-4" /> {t("home.newFromSearch", { q: query.trim() })}
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
