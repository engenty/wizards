import type {
  StudioKnowledgeSource,
  StudioKnowledgeSourceFormProps,
} from "@engenty/wizards/plugin/studio";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Calendar,
  Check,
  ChevronDown,
  CircleAlert,
  Eye,
  EyeOff,
  FolderOpen,
  Hash,
  type LucideIcon,
  Pause,
  PenLine,
  RefreshCw,
  Settings2,
  Tags,
  ToggleLeft,
  Trash2,
  Type,
  X,
} from "lucide-react";
import { type ComponentType, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { type Key, lang, t } from "../../lib/i18n";
import { keys } from "../../lib/keys";
import { useCurrentSpace } from "../../lib/session";
import { PluginFrame, useStudioPlugins } from "../../plugins/host";
import {
  askConfirm,
  Button,
  Card,
  Chip,
  cn,
  Dialog,
  Empty,
  IconButton,
  Input,
  Label,
  Spinner,
  Textarea,
} from "../../ui";
import { CORE_KINDS } from "./FromDateien";
import { when as ago } from "./KnowledgeHome";
import { Section } from "./Section";

/**
 * Sources of Wissen in the studio (docs/plans/knowledge-base.md, „A source fills a folder“): the
 * kinds the plugins bring in „Hinzufügen“, the dialog that proposes one and takes it, the line
 * above Wissen while one reads, and a source's settings behind its folder's ⋯ › Quelle. The rows
 * and runs are the core's (`/api/studio/spaces/:id/sources`); a kind's form and its own settings
 * are the plugin's.
 */

type CategoryType = "choice" | "date" | "number" | "text" | "boolean";

export interface SourceProposal {
  id: string;
  label: string;
  kind: string;
  plugin: string;
  address: string;
  state: "proposed" | "taken";
  found: number;
  included: number;
  leftOut: { title: string; reason: string }[];
  categories: { name: string; type: CategoryType; unit?: string; hint?: string }[];
  folderId: string | null;
}

export interface SourceRun {
  id: string;
  startedAt: string;
  endedAt: string | null;
  status: "running" | "done" | "failed" | "stopped";
  written: number;
  unchanged: number;
  failed: number;
  leftOut: number;
  log: string[];
}

export interface Source {
  id: string;
  space: string;
  kind: string;
  plugin: string;
  address: string;
  label: string;
  state: "proposed" | "taken";
  everyHours: number | null;
  token: string;
  status: "idle" | "running" | "failed";
  error: string | null;
  lastRunAt: string | null;
  folderId: string | null;
  /** The plugin that reads it is there. */
  available: boolean;
  /** Its entries come by hand, as addresses. */
  manual: boolean;
  running: boolean;
  now: {
    phase: "listing" | "reading" | "finishing";
    reading: string[];
    done: number;
    of: number;
  } | null;
}

export interface SourceListed extends Source {
  counts: { entries: number; included: number; done: number; check: number; failed: number };
  lastRun: (Omit<SourceRun, "log"> & { lastLine: string | null }) | null;
}

export interface SourceEntry {
  id: string;
  address: string;
  title: string | null;
  path: string[];
  included: boolean;
  reason: string | null;
  decidedBy: "rule" | "model" | "person" | null;
  status: "new" | "done" | "check" | "failed" | "kept";
  result: { kind: "page" | "table" | "file"; id: string; path: string; title: string } | null;
  note: string | null;
  /** When the source last wrote down what it found for it. */
  updatedAt: string;
}

interface SourcesList {
  sources: SourceListed[];
  kinds: { kind: string; plugin: string; manual: boolean }[];
}

/** A kind both halves of its plugin brought: the server's reader and the studio's entry. */
export type SourceKind = StudioKnowledgeSource & {
  plugin: string;
  serial: number;
  manual: boolean;
};

const sourcesKey = (spaceId: string | undefined) => ["sources", spaceId] as const;
const sourceKey = (id: string) => ["source", id] as const;

export const TYPE_ICON: Record<CategoryType, LucideIcon> = {
  choice: Tags,
  date: Calendar,
  number: Hash,
  text: Type,
  boolean: ToggleLeft,
};

/** What a failed request says, in the person's language. */
function errorText(error: unknown): string {
  const body = (error as { body?: { code?: string } } | null)?.body;
  const message = error instanceof Error ? error.message : String(error);
  if (body?.code === "empty") {
    return t("src.errorEmpty");
  }
  if (body?.code === "not_readable") {
    return t("src.errorNotReadable", { message });
  }
  if (body?.code === "no_kind") {
    return t("src.errorNoKind");
  }
  return message;
}

/**
 * A space's sources and the kinds its plugins bring. Asked every two seconds while one reads,
 * else every half minute (a run the schedule starts shows then); Wissen reads again whenever an
 * entry was written or a run ended.
 */
export function useSources(spaceId: string | undefined) {
  const qc = useQueryClient();
  const plugins = useStudioPlugins();
  const list = useQuery({
    queryKey: sourcesKey(spaceId),
    queryFn: () => api.get<SourcesList>(`/api/studio/spaces/${spaceId}/sources`),
    enabled: Boolean(spaceId),
    refetchInterval: (query) => (query.state.data?.sources.some((s) => s.running) ? 2000 : 30_000),
  });
  const running = (list.data?.sources ?? []).filter((s) => s.running);
  const progress = `${running.length}:${running.reduce((n, s) => n + (s.now?.done ?? 0), 0)}`;
  const seen = useRef(progress);
  useEffect(() => {
    if (seen.current !== progress) {
      seen.current = progress;
      void qc.invalidateQueries({ queryKey: keys.knowledge(spaceId) });
    }
  }, [progress, qc, spaceId]);
  const kinds: SourceKind[] = (list.data?.kinds ?? []).flatMap((k) => {
    const studio =
      k.plugin === "core"
        ? CORE_KINDS.find((s) => s.kind === k.kind)
        : plugins.knowledgeSources.find((s) => s.kind === k.kind);
    return studio ? [{ ...studio, manual: k.manual }] : [];
  });
  const sources = list.data?.sources ?? [];
  return {
    sources,
    kinds,
    /** The source whose folder this is; undefined for any other page. */
    ofFolder: (folderId: string) => sources.find((s) => s.folderId === folderId),
    /** The icon of a source's kind, for its folder's mark. */
    iconOf: (source: Source): ComponentType<{ className?: string }> =>
      [...CORE_KINDS, ...plugins.knowledgeSources].find((s) => s.kind === source.kind)?.icon ??
      FolderOpen,
  };
}

// --- the sources on Wissen's start page -------------------------------------------------------

/** „5m“, „2h“, „3d“: a stretch of time, short. */
function span(minutes: number): string {
  return minutes < 60
    ? `${Math.round(minutes)}m`
    : minutes < 48 * 60
      ? `${Math.round(minutes / 60)}h`
      : `${Math.round(minutes / 1440)}d`;
}

/** „in 22h“: how long until, short; „jetzt fällig“ once it is past. */
function shortIn(at: number): string {
  const minutes = (at - Date.now()) / 60_000;
  return minutes <= 1 ? t("src.dueNow") : t("src.inSpan", { span: span(minutes) });
}

/** Where a source reads, short: the host and the path, without the scheme. */
function shortAddress(address: string): string {
  try {
    const url = new URL(address);
    return `${url.host.replace(/^www\./, "")}${url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "")}`;
  } catch {
    return address;
  }
}

/**
 * The sources as cards, on Wissen's start page: what each reads (its address), how many pages it
 * keeps, how often it reads and when it read last, and what it is doing — reading,
 * or broken. A card opens the source's folder; its gear, the source's settings.
 */
export function SourceCards({
  spaceId,
  folderIds,
  onOpen,
}: {
  spaceId: string;
  /** The folders to show, in their order. */
  folderIds: string[];
  onOpen: (key: string) => void;
}) {
  const { sources, iconOf } = useSources(spaceId);
  const shown = folderIds.flatMap((id) => sources.filter((s) => s.folderId === id));
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(17rem,1fr))] gap-3">
      {shown.map((s) => {
        const Icon = iconOf(s);
        const pages = s.counts.included;
        const last = s.lastRun?.endedAt ?? s.lastRunAt;
        const facts = [
          pages === 1 ? t("src.onePage") : t("src.pages", { n: pages }),
          t(EVERY_WORD[(s.everyHours ?? 0) as keyof typeof EVERY_WORD] ?? "src.every0"),
          // When it read last, short: when it reads next is on the source's page.
          last ? ago(last) : t("src.neverRead"),
        ].filter(Boolean);
        return (
          <div
            key={s.id}
            className="group/card relative flex min-w-0 flex-col gap-1 rounded-xl bg-card px-3.5 py-3 shadow-soft ring-1 ring-border-soft transition hover:ring-border"
          >
            <button
              type="button"
              onClick={() => s.folderId && onOpen(`p:${s.folderId}`)}
              // Its click area covers the whole card; the gear stands above it.
              className="flex min-w-0 items-center gap-2 pr-7 text-left after:absolute after:inset-0 after:rounded-xl"
            >
              <Icon className="size-4 shrink-0 text-ink-3" />
              <span className="truncate font-medium text-[0.875rem]">{s.label}</span>
            </button>
            <span className="truncate text-[0.75rem] text-ink-3" title={s.address}>
              {shortAddress(s.address)}
            </span>
            <span className="truncate text-[0.75rem] text-ink-4">{facts.join(" · ")}</span>
            {s.running ? (
              <span className="mt-1 inline-flex items-center gap-1.5 self-start rounded-full bg-cobalt-tint px-2 py-0.5 text-[0.75rem] text-cobalt">
                <Spinner className="size-3" />
                {s.now?.of
                  ? t("src.readingOf", { done: s.now.done, n: s.now.of })
                  : t("src.readingNow")}
              </span>
            ) : s.status === "failed" ? (
              <span
                className="mt-1 inline-flex items-center gap-1.5 self-start rounded-full bg-rose-tint px-2 py-0.5 text-[0.75rem] text-rose"
                title={s.error ?? ""}
              >
                <CircleAlert className="size-3" />
                {t("src.failedShort")}
              </span>
            ) : null}
            <IconButton
              label={t("src.menuSource")}
              className="absolute top-2 right-2 z-10 size-7 text-ink-4 opacity-0 transition group-hover/card:opacity-100 focus-visible:opacity-100"
              onClick={() => onOpen(`q:${s.id}`)}
            >
              <Settings2 className="size-4" />
            </IconButton>
          </div>
        );
      })}
    </div>
  );
}

// --- the line above Wissen -------------------------------------------------------------------

/** How long the line keeps saying how a run ended, unless its log is open. */
const FINISHED_SHOWN_MS = 30_000;
/** Runs whose ending the person put away, for as long as the studio stays open. */
const dismissed = new Set<string>();

/** A line of a run's log, in the person's language: the core writes `code\tpart\tpart`. */
export function logText(line: string): string {
  const [code, a = "", b = ""] = line.split("\t");
  const key = {
    read: "src.logRead",
    unchanged: "src.logUnchanged",
    gone: "src.logGone",
    failed: "src.logFailed",
    error: "src.logError",
    limit: "src.logLimit",
    summary: "src.logSummary",
    aborted: "src.logAborted",
  }[code] as Key | undefined;
  return key ? t(key, { a, b }) : line;
}

/** „12 aktualisiert, 24 unverändert“: the parts of a run that did something. */
function partsOf(run: Omit<SourceRun, "log">) {
  const words = {
    written: "src.partWritten",
    unchanged: "src.partUnchanged",
    failed: "src.partFailed",
    leftOut: "src.partLeftOut",
  } as const;
  return (["written", "unchanged", "failed", "leftOut"] as const)
    .filter((k) => run[k])
    .map((k) => t(words[k], { n: run[k] }))
    .join(", ");
}

const TONE = {
  running: { box: "bg-cobalt-tint", icon: "text-cobalt" },
  done: { box: "bg-moss-tint", icon: "text-moss" },
  failed: { box: "bg-rose-tint", icon: "text-rose" },
};

/** What a source does now, or how its last run ended: one sentence. */
function nowText(source: SourceListed): string {
  const { now, lastRun, label } = source;
  if (now) {
    if (now.phase === "finishing") {
      return t("src.finishing", { label });
    }
    if (now.phase === "listing" || !now.reading.length) {
      return t("src.listing", { label });
    }
    return t(now.reading.length > 1 ? "src.readingMore" : "src.reading", {
      label,
      title: now.reading[0],
      more: now.reading.length - 1,
      done: now.done,
      n: now.of,
    });
  }
  if (lastRun?.status === "failed") {
    return t("src.broke", { label, error: source.error ?? "" });
  }
  const parts = lastRun ? partsOf(lastRun) : "";
  return parts
    ? t(lastRun?.status === "stopped" ? "src.stopped" : "src.finished", { label, parts })
    : t("src.finishedNothing", { label });
}

/** A run's log, following new lines while it runs. */
function RunLog({
  spaceId,
  source,
  className = "max-h-48",
}: {
  spaceId: string;
  source: Source;
  className?: string;
}) {
  const detail = useSource(spaceId, source.id, source.running);
  const box = useRef<HTMLUListElement>(null);
  const log = detail.data?.runs[0]?.log ?? [];
  useEffect(() => {
    if (source.running && box.current && log.length) {
      box.current.scrollTop = box.current.scrollHeight;
    }
  }, [source.running, log.length]);
  return (
    <ul ref={box} className={cn("overflow-y-auto text-[0.75rem] text-ink-3 leading-5", className)}>
      {detail.isPending ? (
        <li>
          <Spinner className="size-3.5" />
        </li>
      ) : log.length ? (
        log.map((line, i) => (
          <li key={i} className="truncate">
            {logText(line)}
          </li>
        ))
      ) : (
        <li>{t("src.noRun")}</li>
      )}
    </ul>
  );
}

function StatusLine({
  spaceId,
  source,
  open,
  onOpen,
  onDismiss,
  onPick,
}: {
  spaceId: string;
  source: SourceListed;
  open: boolean;
  onOpen: (open: boolean) => void;
  onDismiss: () => void;
  onPick?: () => void;
}) {
  const tone = source.running ? "running" : source.lastRun?.status === "failed" ? "failed" : "done";
  return (
    <div className={cn("flex flex-col rounded-xl px-3.5 py-2", TONE[tone].box)}>
      <div className="flex items-center gap-2.5">
        {source.running ? (
          <Spinner className={cn("size-3.5 shrink-0", TONE[tone].icon)} />
        ) : tone === "failed" ? (
          <CircleAlert className={cn("size-3.5 shrink-0", TONE[tone].icon)} />
        ) : (
          <Check className={cn("size-3.5 shrink-0", TONE[tone].icon)} />
        )}
        <button
          type="button"
          onClick={onPick}
          disabled={!onPick}
          className="min-w-0 flex-1 truncate text-left enabled:hover:text-ink"
        >
          {nowText(source)}
        </button>
        <IconButton
          label={open ? t("src.hideLog") : t("src.showLog")}
          className="size-7"
          onClick={() => onOpen(!open)}
        >
          <ChevronDown className={cn("size-4 transition-transform", open ? "rotate-180" : null)} />
        </IconButton>
        {source.running ? null : (
          <IconButton label={t("src.dismiss")} className="size-7" onClick={onDismiss}>
            <X className="size-4" />
          </IconButton>
        )}
      </div>
      {open ? (
        <div className="mt-1 ml-6">
          <RunLog spaceId={spaceId} source={source} />
        </div>
      ) : source.lastRun?.lastLine ? (
        <p className="ml-6 truncate text-[0.75rem] text-ink-3 leading-5">
          {logText(source.lastRun.lastLine)}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Above Wissen's items (or a source's folder, `only`): what each source reads now, and for half a
 * minute after how its run ended (as long as its log is open), each with the log's last line and
 * the whole log to open. A press on the line opens the source's folder. Nothing while no source
 * reads or ended a run just now.
 */
export function SourcesStatus({
  spaceId,
  sources,
  only,
  onOpen,
}: {
  spaceId: string;
  sources: SourceListed[];
  only?: string;
  onOpen?: (key: string) => void;
}) {
  const [, setTick] = useState(0);
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const taken = sources.filter((s) => s.state === "taken" && (!only || s.id === only));
  const endsAt = (s: SourceListed) =>
    s.lastRun?.endedAt ? Date.parse(s.lastRun.endedAt) + FINISHED_SHOWN_MS : 0;
  const shown = taken.filter(
    (s) =>
      s.running ||
      opened.has(s.id) ||
      (s.lastRun && !dismissed.has(s.lastRun.id) && endsAt(s) > Date.now()),
  );
  const next = Math.min(
    ...shown.filter((s) => !s.running && !opened.has(s.id)).map(endsAt),
    Number.POSITIVE_INFINITY,
  );
  useEffect(() => {
    if (!Number.isFinite(next)) {
      return;
    }
    const timer = setTimeout(() => setTick((n) => n + 1), Math.max(0, next - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [next]);
  if (!shown.length) {
    return null;
  }
  const toggle = (id: string, open: boolean) =>
    setOpened((now) => {
      const copy = new Set(now);
      if (open) {
        copy.add(id);
      } else {
        copy.delete(id);
      }
      return copy;
    });
  return (
    <div className="flex flex-col gap-1.5 text-[0.8125rem] text-ink-2">
      {shown.map((s) => (
        <StatusLine
          key={s.id}
          spaceId={spaceId}
          source={s}
          open={opened.has(s.id)}
          onOpen={(open) => toggle(s.id, open)}
          onPick={onOpen && s.folderId && !only ? () => onOpen(`p:${s.folderId}`) : undefined}
          onDismiss={() => {
            if (s.lastRun) {
              dismissed.add(s.lastRun.id);
            }
            toggle(s.id, false);
            setTick((n) => n + 1);
          }}
        />
      ))}
    </div>
  );
}

// --- proposing and taking --------------------------------------------------------------------

/** Left-out entries the proposal shows before „Alle zeigen“. */
const LEFT_OUT_SHOWN = 4;

function useSource(spaceId: string, sourceId: string, live = false, enabled = true) {
  return useQuery({
    queryKey: sourceKey(sourceId),
    queryFn: () =>
      api.get<{ source: Source; entries: SourceEntry[]; runs: SourceRun[] }>(
        `/api/studio/spaces/${spaceId}/sources/${sourceId}`,
      ),
    enabled,
    refetchInterval: (query) => (live || query.state.data?.source.running ? 2000 : false),
  });
}

/**
 * A proposed source: what it holds, what stays out and why, the Kategorien it brings. Taking it
 * makes its folder (in `parentId`) and starts its first run.
 */
export function ProposalView({
  spaceId,
  proposal,
  parentId,
  onTaken,
}: {
  spaceId: string;
  proposal: SourceProposal;
  parentId?: string | null;
  onTaken?: (taken: SourceProposal) => void;
}) {
  const qc = useQueryClient();
  const plugins = useStudioPlugins();
  const [taken, setTaken] = useState<SourceProposal | null>(
    proposal.state === "taken" ? proposal : null,
  );
  const [allLeftOut, setAllLeftOut] = useState(false);
  const leftOutCount = proposal.found - proposal.included;
  const entries = useSource(spaceId, proposal.id, false, allLeftOut);
  const leftOut = allLeftOut
    ? (entries.data?.entries ?? [])
        .filter((e) => !e.included)
        .map((e) => ({ title: e.title || e.address, reason: e.reason ?? "" }))
    : proposal.leftOut.slice(0, LEFT_OUT_SHOWN);
  const take = useMutation({
    mutationFn: () =>
      api.post<SourceProposal>(`/api/studio/spaces/${spaceId}/sources/${proposal.id}/take`, {
        parentId: parentId ?? null,
      }),
    onSuccess: async (done) => {
      setTaken(done);
      await qc.invalidateQueries({ queryKey: sourcesKey(spaceId) });
      await qc.invalidateQueries({ queryKey: keys.knowledge(spaceId) });
      onTaken?.(done);
    },
  });
  const kind = plugins.knowledgeSources.find((k) => k.kind === proposal.kind);
  const Icon = kind?.icon ?? FolderOpen;
  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-start gap-3">
        <Icon className="mt-0.5 size-4 shrink-0 text-ink-3" />
        <div className="min-w-0 flex-1">
          <div className="font-medium text-[0.9375rem]">{proposal.label}</div>
          <div className="truncate text-[0.8125rem] text-ink-3">
            {[kind?.label(), proposal.address].filter(Boolean).join(" · ")}
          </div>
        </div>
      </div>
      <div className="text-[0.8125rem] text-ink-2">
        {[
          t("src.found", { n: proposal.found }),
          t("src.in", { n: proposal.included }),
          leftOutCount ? t("src.out", { n: leftOutCount }) : "",
        ]
          .filter(Boolean)
          .join(" · ")}
      </div>
      {leftOut.length ? (
        <ul
          className={cn(
            "flex flex-col gap-0.5 text-[0.8125rem] text-ink-3",
            allLeftOut && "max-h-56 overflow-y-auto",
          )}
        >
          {leftOut.map((e, i) => (
            <li key={`${e.title}-${i}`} className="truncate">
              <span className="text-ink-4">{t("src.leftOut")}:</span> {e.title}
              {e.reason ? ` – ${e.reason}` : ""}
            </li>
          ))}
        </ul>
      ) : null}
      {leftOutCount > LEFT_OUT_SHOWN ? (
        <button
          type="button"
          onClick={() => setAllLeftOut(!allLeftOut)}
          className="inline-flex items-center gap-1.5 self-start text-[0.8125rem] text-ink-3 hover:text-ink"
        >
          {allLeftOut && entries.isPending ? <Spinner className="size-3.5" /> : null}
          {allLeftOut ? t("src.showLess") : t("src.showLeftOut", { n: leftOutCount })}
        </button>
      ) : null}
      {proposal.categories.length ? (
        <div className="flex flex-wrap gap-1.5">
          {proposal.categories.map((c) => {
            const TypeIcon = TYPE_ICON[c.type] ?? Tags;
            return (
              <span
                key={c.name}
                title={c.hint}
                className="inline-flex h-7 items-center gap-1.5 rounded-full bg-paper-2 px-2.5 text-[0.75rem] text-ink-2"
              >
                <TypeIcon className="size-3.5 text-ink-3" />
                {c.name}
                <span className="text-ink-4">
                  {t(`know.type.${c.type}` as Key)}
                  {c.unit ? ` · ${c.unit}` : ""}
                </span>
              </span>
            );
          })}
        </div>
      ) : null}
      {taken ? (
        <Chip tone="live">{t("src.taken")}</Chip>
      ) : (
        <div className="flex items-center justify-end gap-2">
          {take.error ? (
            <span className="flex-1 text-[0.8125rem] text-rose">{errorText(take.error)}</span>
          ) : null}
          <Button size="sm" busy={take.isPending} onClick={() => take.mutate()}>
            {t("src.take")}
          </Button>
        </div>
      )}
    </Card>
  );
}

/** The card of Goose's `propose_source` in the assistant's chat. */
export function SourceProposalCard({ data }: { data: SourceProposal }) {
  const { space } = useCurrentSpace();
  return space ? <ProposalView spaceId={space.id} proposal={data} /> : null;
}

/** The field a kind without a form of its own asks with. */
function AddressForm({
  propose,
  busy,
  error,
  placeholder,
}: StudioKnowledgeSourceFormProps & { placeholder?: string }) {
  const [address, setAddress] = useState("");
  const [label, setLabel] = useState("");
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (address.trim()) {
          void propose({ address: address.trim(), label: label.trim() || undefined }).catch(
            () => {},
          );
        }
      }}
    >
      <div>
        <Label>{t("src.address")}</Label>
        <Input
          data-autofocus
          value={address}
          placeholder={placeholder}
          onChange={(e) => setAddress(e.target.value)}
        />
      </div>
      <div>
        <Label>{t("src.label")}</Label>
        <Input
          value={label}
          maxLength={120}
          placeholder={t("src.labelHint")}
          onChange={(e) => setLabel(e.target.value)}
        />
      </div>
      {error ? <p className="text-[0.875rem] text-rose">{error}</p> : null}
      <div className="flex justify-end">
        <Button type="submit" busy={busy} disabled={!address.trim()}>
          {t("src.propose")}
        </Button>
      </div>
    </form>
  );
}

/**
 * „Hinzufügen“ › a kind: its form (or a field for the address), then the proposal to take. Taken,
 * the source's folder opens.
 */
export function SourceDialog({
  spaceId,
  kind,
  parentId,
  onClose,
  onOpen,
}: {
  spaceId: string;
  kind: SourceKind | null;
  parentId: string | null;
  onClose: () => void;
  onOpen: (key: string) => void;
}) {
  const [proposed, setProposed] = useState(false);
  useEffect(() => {
    if (!kind) {
      setProposed(false);
    }
  }, [kind]);
  return (
    // The form is short; what it proposes needs the room, and the dialog grows to it once.
    <Dialog
      open={Boolean(kind)}
      onClose={onClose}
      title={kind?.label()}
      height={proposed ? "tall" : "auto"}
    >
      {kind ? (
        <SourcePane
          key={kind.kind}
          spaceId={spaceId}
          kind={kind}
          parentId={parentId}
          onProposed={() => setProposed(true)}
          onTaken={(taken) => {
            onClose();
            if (taken.folderId) {
              onOpen(`p:${taken.folderId}`);
            }
          }}
        />
      ) : null}
    </Dialog>
  );
}

/** A kind of source: its form, then what it would take in, to take. */
export function SourcePane({
  spaceId,
  kind,
  parentId,
  onProposed,
  onTaken,
}: {
  spaceId: string;
  kind: SourceKind;
  parentId: string | null;
  onProposed?: () => void;
  onTaken: (taken: SourceProposal) => void;
}) {
  const qc = useQueryClient();
  const [proposal, setProposal] = useState<SourceProposal | null>(null);
  const propose = useMutation({
    mutationFn: (input: { address: string; label?: string }) =>
      api.post<SourceProposal>(`/api/studio/spaces/${spaceId}/sources`, {
        ...input,
        kind: kind.kind,
      }),
    onSuccess: async (made) => {
      setProposal(made);
      onProposed?.();
      await qc.invalidateQueries({ queryKey: sourcesKey(spaceId) });
    },
  });
  const Form = kind.form;
  const formProps: StudioKnowledgeSourceFormProps = {
    propose: async (input) => {
      await propose.mutateAsync(input);
    },
    busy: propose.isPending,
    error: propose.error ? errorText(propose.error) : null,
  };
  return proposal ? (
    <ProposalView spaceId={spaceId} proposal={proposal} parentId={parentId} onTaken={onTaken} />
  ) : (
    <div className="flex flex-col gap-4">
      {kind.hint ? <p className="-mt-2 text-[0.875rem] text-ink-3">{kind.hint()}</p> : null}
      {Form ? (
        <PluginFrame of={kind}>
          <Form {...formProps} />
        </PluginFrame>
      ) : (
        <AddressForm {...formProps} placeholder={kind.placeholder?.()} />
      )}
    </div>
  );
}

// --- a source's settings (its folder's ⋯ › Quelle) ---------------------------------------------

const EVERY = [0, 1, 24, 168] as const;
const EVERY_WORD = {
  0: "src.every0",
  1: "src.every1",
  24: "src.every24",
  168: "src.every168",
} as const;
const STATUS_WORD = {
  new: "src.statusNew",
  done: "src.statusDone",
  check: "src.statusCheck",
  failed: "src.statusFailed",
  kept: "src.statusKept",
} as const;

/**
 * One source: how often it reads, read now or stop, its entries with the eye, its last run with
 * its log, the kind's own settings, and removing it.
 */
export function SourceView({
  spaceId,
  sourceId,
  readOnly,
  onOpen,
  onGone,
}: {
  spaceId: string;
  sourceId: string;
  readOnly: boolean;
  onOpen: (key: string) => void;
  onGone: () => void;
}) {
  const qc = useQueryClient();
  const plugins = useStudioPlugins();
  const [show, setShow] = useState<"all" | "in" | "out" | "check" | "log">("all");
  const [removing, setRemoving] = useState(false);
  const [adding, setAdding] = useState("");
  const detail = useSource(spaceId, sourceId);
  const base = `/api/studio/spaces/${spaceId}/sources/${sourceId}`;
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: sourceKey(sourceId) });
    await qc.invalidateQueries({ queryKey: sourcesKey(spaceId) });
    await qc.invalidateQueries({ queryKey: keys.knowledge(spaceId) });
  };
  const patch = useMutation({
    mutationFn: (body: { everyHours: number | null }) => api.patch(base, body),
    onSuccess: refresh,
  });
  const run = useMutation({
    mutationFn: (stop: boolean) => api.post(`${base}/${stop ? "stop" : "run"}`),
    onSuccess: refresh,
  });
  const eye = useMutation({
    mutationFn: (e: SourceEntry) => api.patch(`${base}/entries/${e.id}`, { included: !e.included }),
    onSuccess: refresh,
  });
  const add = useMutation({
    mutationFn: (addresses: string[]) => api.post(`${base}/entries`, { addresses }),
    onSuccess: async () => {
      setAdding("");
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: () => api.del(base),
    onSuccess: async () => {
      setRemoving(false);
      await refresh();
      onGone();
    },
  });
  if (!detail.data) {
    return (
      <div className="flex justify-center p-6 text-ink-3">
        <Spinner className="size-4" />
      </div>
    );
  }
  const { source, entries, runs } = detail.data;
  const kind = plugins.knowledgeSources.find((k) => k.kind === source.kind);
  const Icon = kind?.icon ?? FolderOpen;
  const Settings = kind?.settings;
  const last = runs[0];
  const toCheck = (e: SourceEntry) => e.included && (e.status === "check" || e.status === "failed");
  const shown = entries.filter((e) =>
    show === "in"
      ? e.included
      : show === "out"
        ? !e.included
        : show === "check"
          ? toCheck(e)
          : true,
  );
  const lastAt = last?.endedAt ?? source.lastRunAt;
  const tab = (id: typeof show, label: string, count?: number) => (
    <button
      type="button"
      aria-pressed={show === id}
      onClick={() => setShow(id)}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[0.8125rem] transition",
        show === id ? "bg-paper-2 font-medium text-ink" : "text-ink-3 hover:text-ink",
      )}
    >
      {label}
      {count !== undefined ? (
        <span className="font-normal text-[0.75rem] text-ink-4 tabular-nums">{count}</span>
      ) : null}
    </button>
  );
  const error = patch.error ?? run.error ?? eye.error ?? add.error ?? remove.error;
  return (
    <Section page title={source.label} plain>
      {source.available ? null : (
        <p className="rounded-xl bg-amber-tint px-4 py-2.5 text-[0.8125rem] text-ink-2">
          {t("src.missing")}
        </p>
      )}
      {/* What it reads and its folder; below, how often it reads, with reading now at its end. */}
      <Card className="flex flex-col divide-y divide-border-soft">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
          <Icon className="size-4 shrink-0 text-ink-3" />
          <div className="min-w-0 flex-1">
            <p className="font-medium text-[0.875rem]">{kind?.label() ?? t("src.source")}</p>
            <a
              href={source.address}
              target="_blank"
              rel="noreferrer"
              title={source.address}
              className="block truncate text-[0.8125rem] text-ink-3 underline-offset-2 hover:text-ink hover:underline"
            >
              {shortAddress(source.address)}
            </a>
          </div>
          {source.folderId ? (
            <Button variant="ghost" size="sm" onClick={() => onOpen(`p:${source.folderId}`)}>
              <FolderOpen className="size-4" /> {t("src.openFolder")}
            </Button>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-2 px-4 py-3 text-[0.8125rem] text-ink-3">
          <span className="text-ink-2">{t("src.every")}</span>
          {readOnly ? (
            <span className="font-medium text-ink">
              {t(EVERY_WORD[(source.everyHours ?? 0) as keyof typeof EVERY_WORD])}
            </span>
          ) : (
            <span className="relative">
              <select
                aria-label={t("src.every")}
                value={String(source.everyHours ?? 0)}
                onChange={(e) => patch.mutate({ everyHours: Number(e.target.value) || null })}
                className="h-7 cursor-pointer appearance-none rounded-md bg-paper-2 pr-7 pl-2 font-medium text-[0.8125rem] text-ink transition hover:bg-accent"
              >
                {EVERY.map((h) => (
                  <option key={h} value={h}>
                    {t(EVERY_WORD[h])}
                  </option>
                ))}
              </select>
              <ChevronDown className="-translate-y-1/2 pointer-events-none absolute top-1/2 right-2 size-3.5 text-ink-3" />
            </span>
          )}
          <span className="min-w-0 flex-1">
            {source.running ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-cobalt-tint px-2 py-0.5 text-[0.75rem] text-cobalt">
                <Spinner className="size-3" />
                {source.now?.of
                  ? t("src.readingOf", { done: source.now.done, n: source.now.of })
                  : t("src.readingNow")}
              </span>
            ) : (
              <span title={last ? partsOf(last) : undefined}>
                {[
                  lastAt
                    ? `${t("src.lastRead", { when: ago(lastAt) })}${last && partsOf(last) ? `: ${partsOf(last)}` : ""}`
                    : t("src.neverRead"),
                  source.everyHours && lastAt
                    ? t("src.nextRead", {
                        when: shortIn(Date.parse(lastAt) + source.everyHours * 3_600_000),
                      })
                    : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            )}
            {source.status === "failed" && !source.running ? (
              <span
                className="ml-2 inline-flex items-center gap-1.5 rounded-full bg-rose-tint px-2 py-0.5 text-[0.75rem] text-rose"
                title={source.error ?? ""}
              >
                <CircleAlert className="size-3" />
                {t("src.failedShort")}
              </span>
            ) : null}
          </span>
          {!readOnly && source.state === "taken" && source.available ? (
            <Button
              variant="secondary"
              size="sm"
              busy={run.isPending}
              onClick={() => run.mutate(source.running)}
            >
              {source.running ? <Pause className="size-4" /> : <RefreshCw className="size-4" />}{" "}
              {source.running ? t("src.stop") : t("src.refresh")}
            </Button>
          ) : null}
        </div>
      </Card>
      {/* The kind's own settings frame themselves: a kind with none to show leaves no box. */}
      {Settings ? (
        <PluginFrame of={kind}>
          <Settings source={source} />
        </PluginFrame>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-1">
        {tab("all", t("src.all"), entries.length)}
        {tab("in", t("src.included"), entries.filter((e) => e.included).length)}
        {tab("out", t("src.excluded"), entries.filter((e) => !e.included).length)}
        {tab("check", t("src.check"), entries.filter(toCheck).length)}
        {last ? tab("log", t("src.log")) : null}
      </div>
      {show === "log" ? (
        <Card className="p-4">
          <RunLog spaceId={spaceId} source={source} className="max-h-[70dvh]" />
        </Card>
      ) : (
        <Card className="flex flex-col p-1.5">
          {shown.length ? (
            <ul className="flex flex-col">
              {shown.map((e) => (
                <li
                  key={e.id}
                  className="group flex items-center gap-3 rounded-lg py-1.5 pr-1 pl-2.5 hover:bg-accent"
                >
                  <button
                    type="button"
                    disabled={!e.result}
                    onClick={() => e.result && onOpen(`${e.result.kind[0]}:${e.result.id}`)}
                    title={e.address}
                    className={cn(
                      "min-w-0 flex-1 text-left disabled:cursor-default",
                      !e.included && "opacity-60",
                    )}
                  >
                    <span className="block truncate text-[0.8125rem]">
                      {e.result?.title ?? e.title ?? e.address}
                    </span>
                    <span className="block truncate text-[0.75rem] text-ink-3">
                      {e.included ? (e.result?.path ?? e.address) : (e.reason ?? e.address)}
                    </span>
                  </button>
                  {e.included && e.status !== "done" ? (
                    <Chip
                      tone={e.status === "kept" || e.status === "new" ? "neutral" : "warn"}
                      title={e.note ?? undefined}
                    >
                      {t(STATUS_WORD[e.status])}
                    </Chip>
                  ) : null}
                  <span
                    className="shrink-0 text-[0.75rem] text-ink-4 tabular-nums"
                    title={new Date(e.updatedAt).toLocaleString(lang)}
                  >
                    {ago(e.updatedAt)}
                  </span>
                  {readOnly ? null : (
                    <IconButton
                      label={e.included ? t("src.leaveOut") : t("src.takeIn")}
                      onClick={() => eye.mutate(e)}
                      className={cn("size-7", e.included ? "text-ink-3" : "text-ink-4")}
                    >
                      {e.included ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
                    </IconButton>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <Empty>{t("src.noRun")}</Empty>
          )}
        </Card>
      )}
      {!readOnly && source.manual ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const addresses = adding
              .split(/\s+/)
              .map((a) => a.trim())
              .filter(Boolean);
            if (addresses.length) {
              add.mutate(addresses);
            }
          }}
        >
          <Label>{t("src.addAddresses")}</Label>
          <Textarea
            value={adding}
            rows={3}
            placeholder={t("src.addressesHint")}
            onChange={(e) => setAdding(e.target.value)}
          />
          <div className="flex justify-end">
            <Button type="submit" size="sm" busy={add.isPending} disabled={!adding.trim()}>
              {t("src.addAddresses")}
            </Button>
          </div>
        </form>
      ) : null}
      {error ? <p className="text-[0.8125rem] text-rose">{errorText(error)}</p> : null}
      {readOnly ? null : (
        <div className="flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setRemoving(true)}
            className="text-rose hover:bg-rose-tint hover:text-rose"
          >
            <Trash2 className="size-4" /> {t("src.remove")}
          </Button>
        </div>
      )}
      <Dialog
        open={removing}
        onClose={() => setRemoving(false)}
        title={t("src.removeTitle", { label: source.label })}
      >
        <p className="-mt-2 text-[0.875rem] text-ink-2">{t("src.removeBody")}</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setRemoving(false)}>
            {t("common.cancel")}
          </Button>
          <Button variant="danger" busy={remove.isPending} onClick={() => remove.mutate()}>
            <Trash2 className="size-4" /> {t("src.remove")}
          </Button>
        </div>
      </Dialog>
    </Section>
  );
}

// --- an item a source wrote ---------------------------------------------------------------------

/**
 * Above a page a source wrote: which source writes it and that it does so on every read, and
 * „Selbst bearbeiten“, which asks first. Taken over, the page is the space's own and can be
 * written; the source leaves it alone.
 */
export function SourceItemNotice({
  spaceId,
  itemKey,
  label,
  readOnly,
}: {
  spaceId: string;
  itemKey: string;
  label: string;
  readOnly: boolean;
}) {
  const qc = useQueryClient();
  const keep = useMutation({
    mutationFn: () => api.post(`/api/studio/spaces/${spaceId}/knowledge/keep`, { key: itemKey }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: keys.knowledge(spaceId) });
      await qc.invalidateQueries({ queryKey: keys.page(itemKey.slice(2)) });
      await qc.invalidateQueries({ queryKey: sourcesKey(spaceId) });
    },
  });
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-cobalt-tint px-3.5 py-2.5">
      <RefreshCw className="size-4 shrink-0 text-cobalt" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-[0.8125rem] text-ink">{t("src.fromTitle", { label })}</p>
        <p className="text-[0.75rem] text-ink-3">{t("src.fromHint")}</p>
      </div>
      {readOnly ? null : (
        <Button
          size="sm"
          variant="secondary"
          busy={keep.isPending}
          onClick={async () =>
            (await askConfirm(t("src.takeOverTitle"), {
              detail: t("src.takeOverDetail", { label }),
              action: t("src.takeOver"),
              danger: false,
            })) && keep.mutate()
          }
        >
          <PenLine className="size-3.5" /> {t("src.takeOver")}
        </Button>
      )}
      {keep.error ? (
        <p className="w-full text-[0.75rem] text-rose">{(keep.error as Error).message}</p>
      ) : null}
    </div>
  );
}
