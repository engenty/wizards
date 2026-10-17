import type { Lang, StepType } from "@engenty-wizards/shared/definition";
import {
  CAPABILITY_IDS,
  type Capability,
  INDUSTRY_IDS,
  type Industry,
  ITEM_FORMAT_IDS,
  type ItemFormat,
  MARKETPLACE_PLAN_IDS,
  type MarketGroup,
  type MarketplaceEntry,
  type MarketplacePage,
  type MarketplacePlan,
  marketLabel,
  USE_CASE_IDS,
  type UseCase,
} from "@engenty-wizards/shared/marketplace";
import type { OutlineStep, WizardOutline } from "@engenty-wizards/shared/marketplace-entry";
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  AppWindow,
  AudioLines,
  Bot,
  ChartColumn,
  Check,
  ChevronDown,
  CircleDollarSign,
  CircleEuro,
  Clapperboard,
  Clock,
  CloudOff,
  Coins,
  Eye,
  FileText,
  Flag,
  Globe,
  Image as ImageIcon,
  ListChecks,
  type LucideIcon,
  Mic,
  MousePointerClick,
  PenLine,
  Plug,
  Puzzle,
  ScanText,
  Search,
  Star,
  Table2,
  Terminal,
  Type,
  Video,
  Volume2,
  Wand2,
  X,
} from "lucide-react";
import {
  type CSSProperties,
  lazy,
  type ReactNode,
  Suspense,
  useEffect,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router";
import { Mascot } from "../brand";
import { ENGENTY_FILL, ENGENTY_KIND_FILL, type EngentyKind } from "../engenty/colors";
import { api } from "../lib/api";
import { lang, t } from "../lib/i18n";
import { useCurrentProject, useMayCreate } from "../lib/session";
import { useTheme } from "../lib/theme";
import { Button, Card, Chip, cn, Dialog, Spinner } from "../ui";
import { TYPE_TONE } from "./editor/meta";
import type { PreviewStep } from "./FlowPreview";

// The diagram brings its own library: loaded when a template is opened, not with the list.
const FlowPreview = lazy(() => import("./FlowPreview"));

/** One entry with what its wizard does, makes, needs and costs: what the dialog shows. */
type EntryDetail = MarketplaceEntry & WizardOutline;

/** What a search answers: a page of entries, and whether the marketplace answered. */
export interface SearchPage extends MarketplacePage<MarketplaceEntry> {
  offline: boolean;
  /** The capabilities this install has no model for. */
  unavailable: Capability[];
}

interface Filters {
  useCase: UseCase | "";
  industry: Industry | "";
  format: ItemFormat | "";
  capability: Capability | "";
  plan: MarketplacePlan | "";
}
const NO_FILTERS: Filters = { useCase: "", industry: "", format: "", capability: "", plan: "" };

const label = (group: MarketGroup, id: string) => marketLabel(group, id, lang);

/** The currency coin the cost is drawn with, by the language the person reads. */
const COINS: Record<Lang, typeof CircleEuro> = { en: CircleDollarSign, de: CircleEuro };

/** An estimate as one says it: one significant digit — 111 is "about 100", 27 "about 30". */
function roughly(credits: number): number {
  if (credits < 1) {
    return 1;
  }
  const unit = 10 ** Math.floor(Math.log10(credits));
  return Math.round(credits / unit) * unit;
}

function costLine(e: MarketplaceEntry): string {
  return e.credits
    ? t("market.credits", { n: roughly(e.credits.credits) })
    : label("cost", e.costTier);
}

const FORMAT_ICONS: Record<ItemFormat, LucideIcon> = {
  text: Type,
  document: FileText,
  table: Table2,
  image: ImageIcon,
  video: Video,
  audio: AudioLines,
  dashboard: ChartColumn,
};

/** A format as its icon; the name is there for a pointer and a screen reader. */
function FormatIcon({ format, className }: { format: ItemFormat; className?: string }) {
  const Icon = FORMAT_ICONS[format];
  const name = label("format", format);
  return (
    <span title={name} className="inline-flex">
      <Icon className={className} aria-label={name} role="img" />
    </span>
  );
}

const TIERS = ["low", "medium", "high"] as const;

/** One, two or three coins for a cheap, a medium and an expensive run. */
function CostCoins({ entry }: { entry: MarketplaceEntry }) {
  const coins = TIERS.indexOf(entry.costTier) + 1;
  // A euro where the app speaks German, a dollar where it speaks English.
  const Coin = COINS[lang];
  return (
    <span title={costLine(entry)} className="inline-flex items-center gap-1">
      <span aria-hidden="true" className="inline-flex shrink-0">
        {TIERS.slice(0, coins).map((tier, i) => (
          // Each coin lies half over the one before it.
          <span
            key={tier}
            className={cn("rounded-full bg-(--coin-bg,var(--color-card))", i > 0 && "-ml-1.5")}
          >
            <Coin className="size-4" />
          </span>
        ))}
      </span>
      {label("cost", entry.costTier)}
    </span>
  );
}

/** An entry that needs the Pro plan: its wizard uses plugins that come with Pro. */
export function ProChip() {
  return (
    <Chip tone="ember" title={t("market.proHint")}>
      {t("market.pro")}
    </Chip>
  );
}

/** The plugin an entry comes with, by its name. */
function PluginChip({ plugin }: { plugin: { name: string } }) {
  return (
    <Chip
      icon={<Puzzle className="size-3.5" />}
      title={t("market.fromPlugin", { name: plugin.name })}
    >
      {plugin.name}
    </Chip>
  );
}

function EntryCard({ entry, onOpen }: { entry: MarketplaceEntry; onOpen: () => void }) {
  return (
    <Card
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className={cn(
        "relative flex min-h-[124px] cursor-pointer flex-col gap-5 p-4 text-left transition sm:min-h-[136px] sm:p-5 hover:shadow-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
        (!entry.usable || entry.missing.length > 0 || Boolean(entry.needs?.length)) && "opacity-60",
      )}
    >
      {/* engenty sits on the card's corner, a little over its edge. */}
      <span className="-top-4 pointer-events-none absolute right-4">
        <Mascot kind={entry.avatar} size={68} />
      </span>
      <div className="min-w-0 pr-20">
        {/* A block, not a flex row: Safari sizes a card too short for a title that wraps in a flex row. */}
        <div className="font-display font-semibold text-[0.9375rem]">
          {entry.title}
          {entry.plan === "pro" ? (
            <span className="ml-1.5 inline-flex align-middle">
              <ProChip />
            </span>
          ) : null}
          {entry.starred ? (
            <Star
              className="ml-1.5 inline size-3.5 fill-amber align-[-2px] text-amber"
              aria-label={t("market.starred")}
            />
          ) : null}
        </div>
        <div className="mt-0.5 text-[0.8125rem] text-ink-3 leading-snug">{entry.pitch}</div>
      </div>
      <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[0.75rem] text-ink-3">
        {entry.plugin ? <PluginChip plugin={entry.plugin} /> : null}
        {entry.needs?.length ? (
          <Chip tone="warn">{t("market.needsPro", { list: entry.needs.join(", ") })}</Chip>
        ) : entry.usable && entry.missing.length ? (
          <Chip tone="warn">{t("market.missing", { list: capabilityList(entry.missing) })}</Chip>
        ) : entry.usable ? (
          <>
            <span className="inline-flex items-center gap-1">
              <Clock className="size-3.5" /> {t("market.minutes", { n: entry.effort.minutes })}
            </span>
            <CostCoins entry={entry} />
            {entry.optional?.length ? (
              <Chip title={t("market.optionalHint", { list: capabilityList(entry.optional) })}>
                {t("market.without", { list: capabilityList(entry.optional) })}
              </Chip>
            ) : null}
            <span className="ml-auto inline-flex items-center gap-1.5">
              {entry.formats.map((f) => (
                <FormatIcon key={f} format={f} className="size-4" />
              ))}
            </span>
          </>
        ) : (
          <Chip tone="warn">{t("market.needsUpdate")}</Chip>
        )}
      </div>
    </Card>
  );
}

function Fact({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 font-medium text-[0.75rem] text-ink-3 uppercase tracking-[0.06em]">
        {title}
      </div>
      {children}
    </div>
  );
}

/** Capabilities by name, as one says them in a sentence. */
const capabilityList = (capabilities: Capability[]) =>
  capabilities.map((c) => label("capability", c)).join(", ");

const CAPABILITY_ICONS: Record<Capability, LucideIcon> = {
  text: PenLine,
  web: Globe,
  browser: MousePointerClick,
  documents: ScanText,
  image: ImageIcon,
  video: Video,
  speech: Volume2,
  listening: Mic,
  code: Terminal,
  connectors: Plug,
  film: Clapperboard,
};

/** A step of the flow as its icon: what the person or the wizard does there. */
function stepIcon(step: OutlineStep): LucideIcon {
  switch (step.type) {
    case "page":
      return ListChecks;
    case "agent":
      return Bot;
    case "generate":
      return step.asset === "image"
        ? ImageIcon
        : step.asset === "video"
          ? Video
          : step.asset === "voice"
            ? Volume2
            : step.asset === "dashboard"
              ? ChartColumn
              : FileText;
    case "widget":
      return step.video ? Clapperboard : AppWindow;
    case "surface":
      return AppWindow;
    case "film":
      return Clapperboard;
    case "review":
      return Eye;
    case "result":
      return Flag;
  }
  return Wand2;
}

/** The steps a branch jumps over: they only run when the branch is not taken. */
function skippable(steps: OutlineStep[]): Set<string> {
  const skipped = new Set<string>();
  for (const [from, step] of steps.entries()) {
    for (const branch of step.branches ?? []) {
      const to = branch.to === "end" ? steps.length : steps.findIndex((s) => s.id === branch.to);
      for (let i = from + 1; i < to; i++) {
        skipped.add(steps[i].id);
      }
    }
  }
  return skipped;
}

/** The outline as the preview draws it. */
function previewSteps(steps: OutlineStep[]): PreviewStep[] {
  const optional = skippable(steps);
  return steps.map((s) => ({
    id: s.id,
    title: s.title,
    icon: stepIcon(s),
    tone: TYPE_TONE[s.type as StepType] ?? "bg-paper-2 text-ink-2",
    optional: optional.has(s.id),
    branches: s.branches,
  }));
}

/** One of the header's three values; a thin line parts it from the one before. */
function HeaderFact({ title, children }: { title: string; children: ReactNode }) {
  return (
    <span
      title={title}
      className="inline-flex items-center gap-2 border-border border-l px-4 first:border-l-0 first:pl-0"
    >
      {children}
    </span>
  );
}

/** A line of the main area's facts: an icon, what it is, and a second line that says more. */
function Detail({
  icon,
  children,
  more,
}: {
  icon: ReactNode;
  children: ReactNode;
  more?: ReactNode;
}) {
  return (
    <div className="flex gap-2.5">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0">
        <div className="text-[0.875rem] text-ink leading-snug">{children}</div>
        {more ? <div className="text-[0.75rem] text-ink-3 leading-snug">{more}</div> : null}
      </div>
    </div>
  );
}

/**
 * A column that scrolls when it is clipped, and fades out at the edge more of it lies behind.
 */
function FadeScroll({ className, children }: { className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState({ above: false, below: false });
  useEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    const measure = () => {
      const above = el.scrollTop > 1;
      const below = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
      setMore((m) => (m.above === above && m.below === below ? m : { above, below }));
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    if (el.firstElementChild) {
      observer.observe(el.firstElementChild);
    }
    return () => {
      el.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, []);
  const mask = `linear-gradient(to bottom, ${more.above ? "transparent" : "black"} 0, black 28px, black calc(100% - 44px), ${more.below ? "transparent" : "black"} 100%)`;
  return (
    <div ref={ref} className={className} style={{ maskImage: mask, WebkitMaskImage: mask }}>
      <div>{children}</div>
    </div>
  );
}

/** `fallback`: the entry as the list has it, shown until the marketplace has answered. */
export function EntryDialog({
  id,
  fallback,
  onClose,
  onUse,
  busy,
}: {
  id: string | null;
  fallback: MarketplaceEntry | null;
  onClose: () => void;
  /** Without it the entry is there to look at: nothing is made of it. */
  onUse?: (entry: MarketplaceEntry) => void;
  busy?: boolean;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const detail = useQuery({
    queryKey: ["marketplace-entry", id, lang],
    queryFn: () =>
      api.get<EntryDetail>(`/api/studio/marketplace/${encodeURIComponent(id!)}?lang=${lang}`),
    enabled: Boolean(id),
    retry: false,
  });
  const entry = detail.data ?? fallback;
  // A starred entry is kept on this machine, for use without a connection.
  const star = useMutation({
    mutationFn: (on: boolean) => {
      const path = `/api/studio/marketplace/${encodeURIComponent(id!)}/star`;
      return on ? api.put(path) : api.del(path);
    },
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ["marketplace"] }),
        qc.invalidateQueries({ queryKey: ["marketplace-entry", id] }),
      ]),
  });
  const dark = useTheme() === "dark";
  // The header: in the dark the dialog's own colour under a spotlight; in the light a grey
  // with a little of the engenty's colour in it.
  const fill = ENGENTY_FILL[ENGENTY_KIND_FILL[(entry?.avatar || "round") as EngentyKind]];
  const head = dark
    ? "var(--card)"
    : `color-mix(in oklch, ${fill ?? "var(--ink-4)"} 14%, var(--paper-2))`;
  return (
    <Dialog open={Boolean(id)} onClose={onClose} wide bare>
      {!entry ? (
        <div className="flex min-h-48 flex-col items-center justify-center gap-3 rounded-2xl bg-card p-8 text-[0.875rem] text-ink-2 shadow-overlay">
          {detail.isLoading ? (
            <Spinner className="size-6 text-ink-3" />
          ) : (
            <>
              <p>{t("market.notFound")}</p>
              <Button variant="secondary" onClick={onClose}>
                {t("common.close")}
              </Button>
            </>
          )}
        </div>
      ) : (
        // As high as the window allows: the header and the buttons stay, the flow scrolls.
        // On a phone the panel is the whole screen.
        <div className="relative flex max-h-[calc(100dvh-48px)] flex-col rounded-2xl bg-card shadow-overlay max-sm:h-dvh max-sm:max-h-none max-sm:rounded-none">
          <button
            type="button"
            aria-label={t("common.close")}
            onClick={onClose}
            className="sm:-top-3.5 sm:-right-3.5 absolute top-3 right-3 z-20 flex size-9 items-center justify-center rounded-full bg-card text-ink-2 shadow-elevated ring-1 ring-border-soft transition hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <X className="size-4" />
          </button>
          <header
            className="relative shrink-0 border-border-soft border-b px-5 pt-5 pb-4 text-ink sm:rounded-t-2xl sm:px-7"
            style={{ background: head, "--coin-bg": head } as CSSProperties}
          >
            {/* A soft spotlight, as on the landing page: light from the top right. */}
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 overflow-hidden sm:rounded-t-2xl"
            >
              <span
                className={cn(
                  "-top-28 -right-10 absolute size-80 rounded-full bg-white blur-3xl",
                  dark ? "opacity-[0.14]" : "opacity-80",
                )}
              />
            </span>
            {/* The engenty stands on the header's lower edge, a little over it. */}
            <div className="-bottom-5 absolute right-9 z-10 max-sm:hidden">
              <Mascot kind={entry.avatar} size={104} />
            </div>
            <div className="relative sm:pr-36">
              <h2 className="font-display font-semibold text-[1.375rem] leading-tight tracking-tight max-sm:pr-10">
                {entry.title}
              </h2>
              <p className="mt-1 text-[0.875rem] text-ink-2 leading-snug">
                {detail.data?.description || entry.pitch}
              </p>
            </div>
            {entry.usable ? (
              <div className="-mx-5 sm:-mx-7 relative mt-3.5 flex flex-wrap items-center gap-y-2 border-border-soft border-t px-5 pt-3 font-medium text-[0.875rem] sm:px-7 sm:pr-40">
                <HeaderFact title={t("market.duration")}>
                  <Clock className="size-4 text-ink-3" />
                  {t("market.minutes", { n: entry.effort.minutes })}
                </HeaderFact>
                <HeaderFact title={t("market.cost")}>
                  <CostCoins entry={entry} />
                </HeaderFact>
                <HeaderFact title={t("market.result")}>
                  {entry.formats.map((f) => (
                    <FormatIcon key={f} format={f} className="size-4" />
                  ))}
                </HeaderFact>
              </div>
            ) : null}
          </header>
          {entry.usable ? (
            <div className="grid min-h-0 flex-1 gap-x-7 gap-y-6 px-5 pt-6 max-sm:overflow-y-auto max-sm:pb-4 sm:grid-cols-[230px_minmax(0,1fr)] sm:grid-rows-[minmax(0,1fr)] sm:px-7">
              <div className="flex flex-col gap-5 sm:min-h-0 sm:overflow-y-auto">
                <Fact title={t("market.duration")}>
                  <Detail
                    icon={<Clock className="size-4 text-moss" />}
                    more={t("market.durationHint", { n: entry.effort.fields })}
                  >
                    {t("market.minutes", { n: entry.effort.minutes })}
                  </Detail>
                </Fact>
                <Fact title={t("market.cost")}>
                  <Detail
                    icon={<Coins className="size-4 text-amber" />}
                    more={entry.credits ? t("market.creditsHint") : undefined}
                  >
                    <span className="flex flex-wrap items-center gap-x-2">
                      <CostCoins entry={entry} />
                      {entry.credits ? (
                        <span className="text-ink-2">
                          {t("market.creditsRange", {
                            n: roughly(entry.credits.credits),
                          })}
                        </span>
                      ) : null}
                    </span>
                  </Detail>
                </Fact>
                <Fact title={t("market.result")}>
                  <div className="flex flex-col gap-2">
                    {(detail.data?.results ?? []).map((r) => (
                      <Detail
                        key={r.title}
                        icon={<FormatIcon format={r.kind} className="size-4 text-ember-strong" />}
                        more={r.formats.map((f) => f.toUpperCase()).join(" · ")}
                      >
                        {r.title}
                      </Detail>
                    ))}
                  </div>
                </Fact>
                <Fact title={t("market.needs")}>
                  <ul className="flex flex-col gap-2">
                    {entry.capabilities.map((c) => {
                      const Icon = CAPABILITY_ICONS[c];
                      const missing = entry.missing.includes(c);
                      const optional = entry.optional?.includes(c);
                      return (
                        <li
                          key={c}
                          className={cn(
                            "flex items-center gap-2.5 text-[0.875rem]",
                            missing ? "text-ink-3" : "text-ink-2",
                          )}
                        >
                          <Icon
                            className={cn(
                              "size-4 shrink-0",
                              missing ? "text-rose" : optional ? "text-amber" : "text-cobalt",
                            )}
                          />
                          {label("capability", c)}
                          {missing ? (
                            <span className="text-[0.75rem] text-rose">
                              {t("market.unavailable")}
                            </span>
                          ) : optional ? (
                            <span className="text-[0.75rem] text-amber">
                              {t("market.optional")}
                            </span>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                </Fact>
              </div>
              <div className="flex flex-col sm:min-h-0">
                <div className="mb-1.5 shrink-0 font-medium text-[0.75rem] text-ink-3 uppercase tracking-[0.06em]">
                  {t("market.steps")}
                </div>
                <FadeScroll className="-mr-2 overscroll-contain pt-1 pr-2 pl-1 sm:min-h-0 sm:flex-1 sm:overflow-y-auto">
                  {detail.isLoading ? (
                    <Spinner className="size-5 text-ink-3" />
                  ) : (
                    <Suspense fallback={<Spinner className="size-5 text-ink-3" />}>
                      <FlowPreview steps={previewSteps(detail.data?.outline ?? [])} />
                    </Suspense>
                  )}
                </FadeScroll>
              </div>
            </div>
          ) : (
            <div className="flex-1 px-5 pt-6 sm:px-7">
              <p className="rounded-lg bg-amber-tint p-3 text-[0.875rem] text-ink-2">
                {t("market.needsUpdateHint")}
              </p>
            </div>
          )}
          <div className="flex shrink-0 justify-end gap-2 px-5 pt-4 pb-5 max-sm:border-border-soft max-sm:border-t sm:px-7 sm:pb-6">
            {/* A plugin's starter is always here: there is nothing to keep for offline use. */}
            {entry.plugin ? (
              <span className="mr-auto flex items-center">
                <PluginChip plugin={entry.plugin} />
              </span>
            ) : (
              <Button
                variant="ghost"
                className="mr-auto"
                title={t("market.starHint")}
                aria-pressed={entry.starred}
                busy={star.isPending}
                onClick={() => star.mutate(!entry.starred)}
              >
                <Star className={cn("size-4", entry.starred && "fill-amber text-amber")} />
                <span className="max-sm:sr-only">
                  {t(entry.starred ? "market.starred" : "market.star")}
                </span>
              </Button>
            )}
            <Button variant="secondary" onClick={onClose}>
              {t("common.close")}
            </Button>
            {entry.usable && entry.missing.length ? (
              <Button variant="secondary" onClick={() => navigate("/settings/models")}>
                {t("editor.models.settings")}
              </Button>
            ) : null}
            {onUse ? (
              <Button
                disabled={!entry.usable || entry.missing.length > 0 || Boolean(entry.needs?.length)}
                title={
                  entry.needs?.length
                    ? t("market.needsProHint", { list: entry.needs.join(", ") })
                    : entry.missing.length
                      ? t("market.missingHint", { list: capabilityList(entry.missing) })
                      : entry.optional?.length
                        ? t("market.optionalHint", { list: capabilityList(entry.optional) })
                        : undefined
                }
                busy={busy}
                onClick={() => onUse(entry)}
              >
                {t("market.use")}
              </Button>
            ) : null}
          </div>
        </div>
      )}
    </Dialog>
  );
}

interface FilterOption {
  value: string;
  label: string;
  /** Entries the option would leave, with the other filters as they are. */
  count: number;
  icon?: ReactNode;
  /** This install has no model for it: shown, not to be picked. */
  unavailable?: boolean;
}

/** A filter as a pill: its name, or its pick with a way to drop it; the options open below. */
function FilterMenu({
  name,
  value,
  options,
  onChange,
}: {
  name: string;
  value: string;
  options: FilterOption[];
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) {
      return;
    }
    const away = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", onEscape);
    };
  }, [open]);
  const picked = options.find((o) => o.value === value);
  return (
    <div ref={ref} className="relative">
      <div
        className={cn(
          "flex h-8 items-center rounded-full text-[0.8125rem] transition",
          picked ? "bg-ember-tint text-ink" : "text-ink-2 hover:bg-paper-2 hover:text-ink",
          open && !picked && "bg-paper-2 text-ink",
        )}
      >
        <button
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className={cn(
            "flex h-full items-center gap-1.5 rounded-full pl-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
            picked ? "pr-1" : "pr-2.5",
          )}
        >
          {picked ? (
            <>
              <span className="text-ink-3">{name}</span>
              <span className="font-medium">{picked.label}</span>
            </>
          ) : (
            <>
              {name}
              <ChevronDown className={cn("size-3.5 transition", open && "rotate-180")} />
            </>
          )}
        </button>
        {picked ? (
          <button
            type="button"
            aria-label={`${name}: ${t("market.reset")}`}
            onClick={() => onChange("")}
            className="mr-1 flex size-6 items-center justify-center rounded-full text-ink-3 hover:bg-card hover:text-ink"
          >
            <X className="size-3.5" />
          </button>
        ) : null}
      </div>
      {open ? (
        <div
          role="listbox"
          aria-label={name}
          className="absolute top-full left-0 z-30 mt-1.5 max-h-80 min-w-60 overflow-y-auto rounded-xl bg-card p-1.5 shadow-overlay ring-1 ring-border-soft"
        >
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              disabled={!o.count || o.unavailable}
              onClick={() => {
                onChange(o.value === value ? "" : o.value);
                setOpen(false);
              }}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[0.875rem] transition coarse:py-2.5",
                o.count && !o.unavailable
                  ? "text-ink-2 hover:bg-paper-2 hover:text-ink"
                  : "text-ink-4",
                o.value === value && "font-medium text-ink",
              )}
            >
              {o.icon}
              <span className="flex-1 whitespace-nowrap">{o.label}</span>
              {o.value === value ? (
                <Check className="size-4 text-ember" />
              ) : o.unavailable ? (
                <span className="whitespace-nowrap text-[0.75rem] text-ink-4">
                  {t("market.unavailable")}
                </span>
              ) : (
                <span className="text-[0.75rem] text-ink-4 tabular-nums">{o.count}</span>
              )}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** A value once it has stopped changing for a moment: what is typed, when the typing pauses. */
export function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

const PAGE = 60;

/**
 * The marketplace's first answers to a search made elsewhere — the home, when few of the
 * space's own wizards match: a few cards under their own heading, each opening as in the
 * browser; nothing at all while the search is empty or the marketplace has nothing for it.
 */
export function MarketplaceHits({
  query,
  onUse,
  busy,
  limit = 6,
}: {
  query: string;
  onUse?: (entry: MarketplaceEntry) => void;
  busy?: boolean;
  limit?: number;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const q = useSettled(query.trim(), 250);
  const search = useQuery({
    queryKey: ["marketplace", lang, q, "hits", limit],
    queryFn: () =>
      api.get<SearchPage>(
        `/api/studio/marketplace?${new URLSearchParams({ lang, limit: String(limit), offset: "0", q })}`,
      ),
    enabled: Boolean(q),
    placeholderData: keepPreviousData,
  });
  const entries = q ? (search.data?.entries ?? []) : [];
  if (!entries.length) {
    return null;
  }
  return (
    <section className="mt-10">
      <h2 className="mb-5 flex items-center gap-2 font-medium text-[0.8125rem] text-ink-3 uppercase tracking-[0.08em]">
        {t("market.hits")}
        {search.isFetching ? <Spinner className="size-3.5" /> : null}
      </h2>
      <div className="flex flex-col gap-4 sm:grid sm:grid-cols-2 lg:grid-cols-3">
        {entries.map((e) => (
          <EntryCard key={e.id} entry={e} onOpen={() => setPicked(e.id)} />
        ))}
      </div>
      <EntryDialog
        id={picked}
        fallback={entries.find((e) => e.id === picked) ?? null}
        onClose={() => setPicked(null)}
        onUse={onUse}
        busy={busy}
      />
    </section>
  );
}

/**
 * Templates the studio assistant shows under an answer: the gallery's cards, each opening as in
 * the gallery; a wizard made of one opens in the editor.
 */
export function MarketplaceCards({ entries }: { entries: MarketplaceEntry[] }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { project } = useCurrentProject();
  const mayCreate = useMayCreate() && Boolean(project) && !project?.readOnly;
  const [picked, setPicked] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (starterId: string) =>
      api.post<{ id: string }>("/api/studio/wizards", { projectId: project!.id, starterId, lang }),
    onSuccess: async ({ id }) => {
      await qc.invalidateQueries({ queryKey: ["projects"] });
      await qc.invalidateQueries({ queryKey: ["wizards"] });
      setPicked(null);
      navigate(`/edit/${id}`);
    },
  });
  return (
    // Two side by side where the chat is wide enough, one under the other in the sidebar.
    <div className="@container mt-3">
      <div className="flex flex-col gap-4 @xl:grid @xl:grid-cols-2">
        {entries.map((e) => (
          <EntryCard key={e.id} entry={e} onOpen={() => setPicked(e.id)} />
        ))}
      </div>
      {create.error ? (
        <p className="mt-2 text-[0.8125rem] text-rose">{(create.error as Error).message}</p>
      ) : null}
      <EntryDialog
        id={picked}
        fallback={entries.find((e) => e.id === picked) ?? null}
        onClose={() => setPicked(null)}
        onUse={mayCreate ? (entry) => !create.isPending && create.mutate(entry.id) : undefined}
        busy={create.isPending}
      />
    </div>
  );
}

/**
 * The marketplace as a person browses it: a search the marketplace answers live, the ways to
 * narrow it, the starred entries, and a card per entry that opens with what the wizard makes,
 * needs and costs. Without a connection it shows what this machine keeps.
 */
export function MarketplaceBrowser({
  onUse,
  busy,
  open: opened,
  search: searchFor,
  onGuestOpen,
}: {
  /** Makes a wizard of an entry; left out where nothing is made, the entries are only shown. */
  onUse?: (entry: MarketplaceEntry) => void;
  busy?: boolean;
  /** An entry to open at once (a link from the gallery). */
  open?: string | null;
  /** Words to search for, handed in from outside (the wish on the start page); each hand-in sets the field. */
  search?: { text: string } | null;
  /**
   * Someone not signed in (the studio's start page for guests): the gallery's public list, no
   * stars, and an entry opens by signing in first.
   */
  onGuestOpen?: (entry: MarketplaceEntry) => void;
}) {
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (searchFor) {
      setQuery(searchFor.text);
    }
  }, [searchFor]);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [starred, setStarred] = useState(false);
  const [picked, setPicked] = useState<string | null>(opened ?? null);
  const q = useSettled(query.trim(), 250);
  // On a phone a search brings its field to the top, so the results below it are on screen.
  const field = useRef<HTMLLabelElement>(null);
  useEffect(() => {
    const el = field.current;
    if (q && el && window.matchMedia("(max-width: 639px)").matches) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [q]);

  const search = useInfiniteQuery({
    queryKey: ["marketplace", lang, q, filters, starred],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ lang, limit: String(PAGE), offset: String(pageParam) });
      if (q) {
        params.set("q", q);
      }
      for (const [key, value] of Object.entries(filters)) {
        if (value) {
          params.set(key, value);
        }
      }
      if (starred) {
        params.set("starred", "1");
      }
      return api.get<SearchPage>(`/api/${onGuestOpen ? "guest" : "studio"}/marketplace?${params}`);
    },
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const had = pages.reduce((sum, p) => sum + p.entries.length, 0);
      return had < last.total ? had : undefined;
    },
    placeholderData: keepPreviousData,
  });
  const first = search.data?.pages[0];
  const shown = search.data?.pages.flatMap((p) => p.entries) ?? [];
  const all = first?.all ?? 0;
  const thinking = query.trim() !== q || (search.isFetching && !search.isFetchingNextPage);

  /** The options of one filter, each with what it would leave of the list. */
  const options = (
    key: keyof Filters,
    group: MarketGroup,
    ids: readonly string[],
    icon?: (id: string) => ReactNode,
  ) =>
    ids
      // An option no entry has at all is not offered.
      .filter(
        (id) => (first?.facets[key] as Record<string, number> | undefined)?.[id] !== undefined,
      )
      .map((id) => ({
        value: id,
        label: label(group, id),
        icon: icon?.(id),
        count: (first?.facets[key] as Record<string, number>)[id] ?? 0,
        unavailable: key === "capability" && unavailable.has(id as Capability),
      }));

  const unavailable = new Set(first?.unavailable ?? []);
  const useCases = options("useCase", "useCase", USE_CASE_IDS);
  const menus: { key: keyof Filters; name: string; options: FilterOption[] }[] = [
    {
      key: "industry",
      name: t("market.industry"),
      options: options("industry", "industry", INDUSTRY_IDS),
    },
    {
      key: "format",
      name: t("market.format"),
      options: options("format", "format", ITEM_FORMAT_IDS, (id) => (
        <FormatIcon format={id as ItemFormat} className="size-4 text-ink-3" />
      )),
    },
    {
      key: "plan",
      name: t("market.plan"),
      options: options("plan", "plan", MARKETPLACE_PLAN_IDS),
    },
    {
      key: "capability",
      name: t("market.capability"),
      options: options("capability", "capability", CAPABILITY_IDS, (id) => {
        const Icon = CAPABILITY_ICONS[id as Capability];
        return <Icon className="size-4 text-ink-3" />;
      }),
    },
  ];
  const narrowed = Boolean(query.trim()) || starred || Object.values(filters).some(Boolean);
  const reset = () => {
    setFilters(NO_FILTERS);
    setQuery("");
    setStarred(false);
  };

  if (search.isLoading) {
    return (
      <div className="flex justify-center py-10">
        <Spinner className="size-6 text-ink-3" />
      </div>
    );
  }
  const offline = first?.offline ? (
    <p className="mt-4 flex items-center justify-center gap-2 text-[0.8125rem] text-ink-3">
      <CloudOff className="size-4 shrink-0" />
      {t("market.offline")}
    </p>
  ) : null;
  // No marketplace, and nothing kept: the page has only the prompt.
  if (!all && !narrowed) {
    return offline;
  }
  const clear = query ? (
    <button
      type="button"
      aria-label={t("market.reset")}
      onClick={() => setQuery("")}
      className="-mr-1.5 flex size-7 shrink-0 items-center justify-center rounded-full text-ink-3 hover:bg-paper-2 hover:text-ink"
    >
      <X className="size-4" />
    </button>
  ) : null;
  const chip = (pressed: boolean) =>
    cn(
      "inline-flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2.5 text-[0.78125rem] transition",
      pressed
        ? "bg-card font-medium text-ink shadow-soft ring-1 ring-border-soft"
        : "text-ink-3 hover:bg-card/60 hover:text-ink",
    );

  return (
    <div>
      <label
        ref={field}
        className="relative mx-auto flex h-10 max-w-md scroll-mt-4 items-center gap-2.5 rounded-full bg-card px-4 shadow-soft ring-1 ring-border-soft transition focus-within:ring-2 focus-within:ring-focus sm:h-11"
      >
        {thinking ? (
          <Spinner className="size-4 shrink-0 text-ink-3" />
        ) : (
          <Search className="size-4 shrink-0 text-ink-3" />
        )}
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("market.search")}
          aria-label={t("market.search")}
          className="min-w-0 flex-1 bg-transparent text-[0.9375rem] outline-none placeholder:text-ink-4 [&::-webkit-search-cancel-button]:hidden"
        />
        {clear}
      </label>
      {offline}
      {/* On a phone the chips are one row to swipe, not four rows to scroll past. */}
      <div className="max-sm:-mx-3 mt-4 flex gap-1 max-sm:overflow-x-auto max-sm:px-3 max-sm:[scrollbar-width:none] sm:flex-wrap sm:justify-center max-sm:[&::-webkit-scrollbar]:hidden">
        {[{ value: "", label: t("market.all") }, ...useCases].map((u) => (
          <button
            key={u.value}
            type="button"
            aria-pressed={!starred && filters.useCase === u.value}
            onClick={() => {
              setStarred(false);
              setFilters({ ...filters, useCase: u.value as UseCase | "" });
            }}
            className={chip(!starred && filters.useCase === u.value)}
          >
            {u.label}
          </button>
        ))}
        {onGuestOpen ? null : (
          <button
            type="button"
            aria-pressed={starred}
            onClick={() => setStarred(!starred)}
            className={chip(starred)}
          >
            <Star className={cn("size-3.5", starred && "fill-amber text-amber")} />
            {t("market.starred")}
          </button>
        )}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-1 gap-y-2 sm:mt-6">
        {starred
          ? null
          : menus.map((m) => (
              <FilterMenu
                key={m.key}
                name={m.name}
                value={filters[m.key]}
                options={m.options}
                onChange={(v) => setFilters({ ...filters, [m.key]: v })}
              />
            ))}
        {/* Reset stands before the count, so the count never moves. */}
        <span className="ml-auto flex items-center gap-3 whitespace-nowrap pl-2 text-[0.8125rem] text-ink-3">
          {narrowed ? (
            <button
              type="button"
              onClick={reset}
              className="inline-flex items-center gap-1 text-ember-strong underline-offset-2 hover:underline"
            >
              <X className="size-3.5 max-sm:size-4" />
              {/* On a phone the cross alone: the row has no room for the word. */}
              <span className="max-sm:sr-only">{t("market.resetShort")}</span>
            </button>
          ) : null}
          {/* A phone has no room for the noun beside the reset link. */}
          {narrowed ? (
            <span className="tabular-nums sm:hidden">
              {t("market.countOfShort", { n: first?.total ?? 0, all })}
            </span>
          ) : null}
          <span className={cn("tabular-nums", narrowed && "max-sm:hidden")}>
            {narrowed
              ? t("market.countOf", { n: first?.total ?? 0, all })
              : t("market.count", { n: all })}
          </span>
        </span>
      </div>
      {shown.length ? (
        // On a phone a column, not a one-track grid: Safari can size a grid row too short.
        <div className="mt-4 flex flex-col gap-4 sm:grid sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((e) => (
            <EntryCard
              key={e.id}
              entry={e}
              onOpen={() => (onGuestOpen ? onGuestOpen(e) : setPicked(e.id))}
            />
          ))}
        </div>
      ) : (
        <div className="py-10 text-center text-[0.875rem] text-ink-3">
          <p>{t(starred ? "market.noneStarred" : "market.none")}</p>
          <Button variant="ghost" className="mt-2" onClick={reset}>
            {t("market.reset")}
          </Button>
        </div>
      )}
      {search.hasNextPage ? (
        <div className="mt-6 flex justify-center">
          <Button
            variant="secondary"
            busy={search.isFetchingNextPage}
            onClick={() => void search.fetchNextPage()}
          >
            {t("market.more")}
          </Button>
        </div>
      ) : null}
      <EntryDialog
        id={picked}
        fallback={shown.find((e) => e.id === picked) ?? null}
        onClose={() => setPicked(null)}
        onUse={onUse}
        busy={busy}
      />
    </div>
  );
}
