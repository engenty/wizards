import type {
  KnowledgeHit,
  KnowledgeItem,
  KnowledgeSearch,
  Where,
  WhereValue,
} from "@engenty/wizards-shared/knowledge";
import {
  CornerDownLeft,
  FileText,
  Image,
  ListFilter,
  type LucideIcon,
  MessageCircle,
  Search,
  TextQuote,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useNavigate } from "react-router";
import { api } from "../../lib/api";
import { useFeature } from "../../lib/features";
import { lang, t } from "../../lib/i18n";
import { useCurrentSpace } from "../../lib/session";
import { cn, Dialog, IconButton, Spinner, Switch } from "../../ui";
import { useDismiss } from "../AppFrame";
import { useAssistant } from "../assistant/chat";
import { mountThumbUrl, thumbUrl } from "./data";
import { FilterChip, itemIcon, passes, useKnowledge } from "./Knowledge";
import { when } from "./KnowledgeHome";
import { ancestorsOf, isFolder, treeIcon } from "./KnowledgeTree";
import { fold, type Place, reveal, wordsOf } from "./reveal";

// The search of Wissen, on ⌘K or Wissen's search field (peer-it's palette, over
// `POST /spaces/:id/search`). Before anything is typed: what changed lately. Typed: the items whose
// title has the words, the pictures, then the passages, grouped by where they live. The first list
// comes at once; the classifier's replaces it when it comes. Enter opens the row at its place,
// ⌘Enter hands the question to Goose. „So findet es ein Wizard“ shows the list a step gets, with
// the classifier's numbers.

// --- opening it from anywhere ------------------------------------------------------------------

let wanted: { query: string } | null = null;
const listeners = new Set<() => void>();

function set(next: { query: string } | null) {
  wanted = next;
  for (const listener of listeners) {
    listener();
  }
}

/** Opens the palette, with a question in it when there is one. */
export function openKnowledgePalette(query = "") {
  set({ query });
}

/** ⌘K or Ctrl+K anywhere in the studio, where Wissen is a knowledge base (`knowledgeTree`). */
function isPaletteKey(e: KeyboardEvent) {
  return (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k";
}

/** One row of the palette, of whatever place it lives in. */
interface Row {
  id: string;
  icon: LucideIcon;
  /** A picture instead of the icon. */
  thumb?: string;
  title: ReactNode;
  where?: string;
  /** What it says: a passage. */
  text?: string;
  /** P(relevant) the classifier gave. */
  relevance?: number | null;
  /** Its time, quiet, at the end: when it changed. */
  at?: string;
  open: () => void;
}

/**
 * Where hits live: Wissen, then each mount of Dateien the person may see. Each gives the rows
 * whose title has the words, its pictures and its passages.
 */
interface Group {
  id: string;
  /** Above its titles and pictures: „Wissen“, „Dateien › Kunden“. */
  label: string;
  /** Above its passages, where they need one of their own: „In den Texten von Wissen“. */
  textsLabel?: string;
  names: Row[];
  pictures: Row[];
  texts: Row[];
}

/** ⌘ on a Mac, Ctrl elsewhere. */
const MAC = /Mac|iPhone|iPad/.test(navigator.platform);

const NAMES = 5;
const RECENT = 8;
const PICTURES = 6;

/** The words of a query, folded: what a title must hold. */
const termsOf = (query: string) => fold(query).split(/\s+/).filter(Boolean);

/** The query's words, marked in a text. Short words would light up inside every other one. */
function Marked({ text, terms }: { text: string; terms: string[] }) {
  const long = terms.filter((w) => w.length > 2);
  if (!long.length) {
    return <>{text}</>;
  }
  const folded = fold(text);
  // Folding keeps the length for Latin letters with marks, so places carry over.
  if (folded.length !== text.length) {
    return <>{text}</>;
  }
  const marks: [number, number][] = [];
  for (const w of long) {
    for (let i = folded.indexOf(w); i >= 0; i = folded.indexOf(w, i + w.length)) {
      marks.push([i, i + w.length]);
    }
  }
  marks.sort((a, b) => a[0] - b[0]);
  const out: ReactNode[] = [];
  let at = 0;
  for (const [from, to] of marks) {
    if (from < at) {
      continue;
    }
    out.push(text.slice(at, from));
    out.push(
      <mark key={from} className="rounded-[3px] bg-ember-tint px-0.5 text-ink">
        {text.slice(from, to)}
      </mark>,
    );
    at = to;
  }
  out.push(text.slice(at));
  return <>{out}</>;
}

/** A passage as one quiet line: pictures, link targets, the Markdown's marks and breaks out. */
const plain = (text: string) =>
  text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/[#*_`>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Wissen's search field: it opens the palette. */
export function PaletteField() {
  return (
    <button
      type="button"
      onClick={() => openKnowledgePalette()}
      className="flex h-9 w-full items-center gap-2.5 rounded-full border border-input bg-card pr-3 pl-3 text-left text-[0.875rem] text-ink-4 transition hover:border-focus"
    >
      <Search className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{t("know.searchAll")}</span>
      <kbd className="shrink-0 font-mono text-[0.6875rem] max-sm:hidden">
        {MAC ? "⌘K" : "Ctrl K"}
      </kbd>
    </button>
  );
}

/** The studio's one palette: mounted once, it opens on ⌘K and on `openKnowledgePalette`. */
export function KnowledgePalette() {
  const on = useFeature("knowledgeTree");
  const { space } = useCurrentSpace();
  const open = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => wanted,
  );
  useEffect(() => {
    if (!on) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      // A field that takes ⌘K itself (the Markdown editor's link) has it.
      if (isPaletteKey(e) && !e.defaultPrevented) {
        e.preventDefault();
        set(wanted ? null : { query: "" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [on]);
  if (!on || !space) {
    return null;
  }
  return (
    <Dialog open={open !== null} onClose={() => set(null)} wide bare>
      {open ? <Palette spaceId={space.id} initial={open.query} onClose={() => set(null)} /> : null}
    </Dialog>
  );
}

function Palette({
  spaceId,
  initial,
  onClose,
}: {
  spaceId: string;
  initial: string;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const assistant = useAssistant();
  const knowledge = useKnowledge(spaceId);
  const [query, setQuery] = useState(initial);
  const [where, setWhere] = useState<Where>({});
  // Categories picked under „Filter“ that have no value yet: their chip opens.
  const [adding, setAdding] = useState<string[]>([]);
  const [filterMenu, setFilterMenu] = useState(false);
  const filterRef = useRef<HTMLDivElement>(null);
  useDismiss(filterRef, filterMenu, () => setFilterMenu(false));
  const [found, setFound] = useState<{ query: string; result: KnowledgeSearch } | null>(null);
  const [ranking, setRanking] = useState(false);
  const [wizard, setWizard] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const asked = query.trim();
  const terms = termsOf(asked);
  const filtered = Object.keys(where).length > 0;
  const whereKey = JSON.stringify(where);
  const items = knowledge.data?.items ?? [];
  const categories = (knowledge.data?.categories ?? []).filter((c) => !c.proposed && c.count > 0);
  const goose = assistant !== null;

  useEffect(() => input.current?.focus(), []);

  // At once without the classifier, then with it: the checked list replaces the first.
  // biome-ignore lint/correctness/useExhaustiveDependencies: whereKey stands for where
  useEffect(() => {
    if (asked.length < 2) {
      setFound(null);
      setRanking(false);
      return;
    }
    const ctl = new AbortController();
    const url = `/api/studio/spaces/${spaceId}/search`;
    const body = { query: asked, limit: 12, ...(filtered ? { where } : {}) };
    const timer = setTimeout(async () => {
      try {
        const first = await api.post<KnowledgeSearch>(url, { ...body, check: false }, ctl.signal);
        setFound({ query: asked, result: first });
        if (knowledge.data?.checked && first.hits.length) {
          setRanking(true);
          const checked = await api.post<KnowledgeSearch>(url, body, ctl.signal);
          setFound({ query: asked, result: checked });
        }
      } catch {
        // The next query came, or the server is away: the list stays.
      } finally {
        if (!ctl.signal.aborted) {
          setRanking(false);
        }
      }
    }, 180);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [asked, whereKey, spaceId, knowledge.data?.checked]);

  const openKey = (key: string, place?: Place) => {
    onClose();
    navigate(`/space/knowledge?show=${encodeURIComponent(key)}`);
    if (place) {
      reveal(place);
    }
  };
  const placeOf = (item: KnowledgeItem) =>
    ancestorsOf(items, item)
      .map((a) => a.title)
      .join(" › ");
  const itemRow = (item: KnowledgeItem, at?: boolean): Row => ({
    id: item.key,
    icon: treeIcon(item),
    title: <Marked text={item.title} terms={terms} />,
    where: placeOf(item),
    at: at ? when(item.updatedAt) : undefined,
    open: () => openKey(item.key),
  });
  const hitRow = (hit: KnowledgeHit): Row => (hit.mount ? mountedRow(hit) : wissenRow(hit));
  // A file of a mount in Dateien: its path in the mount says where it is. It opens in Dateien,
  // a PDF at its page.
  const mountedRow = (hit: KnowledgeHit): Row => {
    const id = hit.open?.slice(2) ?? "";
    const inMount = hit.path.split("/").slice(2, -1).join(" › ");
    // The passage is read with the headings it was indexed under: they are in the title.
    const text = hit.picture ? undefined : plain(hit.text.replace(/^#+ [^\n]*\n+/, ""));
    return {
      id: `${hit.key}:${hit.heading ?? ""}:${hit.sheet ?? ""}`,
      icon: hit.picture ? Image : FileText,
      thumb: hit.picture ? mountThumbUrl(spaceId, id) : undefined,
      title: (
        <>
          {hit.title}
          {hit.heading ? <span className="text-ink-3"> › {plain(hit.heading)}</span> : null}
          {hit.sheet ? (
            <span className="text-ink-3"> · {t("know.palette.page", { n: hit.sheet })}</span>
          ) : null}
        </>
      ),
      where: inMount,
      text,
      relevance: hit.relevance,
      open: () => {
        onClose();
        const page = hit.picture === "page" ? hit.sheet : null;
        navigate(`/space/files?show=${encodeURIComponent(page ? `m:${id}#${page}` : `m:${id}`)}`);
        reveal(page ? { page } : { words: wordsOf(text ?? "") });
      },
    };
  };
  const wissenRow = (hit: KnowledgeHit): Row => {
    const file = hit.open?.startsWith("f:") ? hit.open.slice(2) : null;
    const page = hit.sheet && file ? hit.sheet : null;
    // A page's title comes with its folders: they say where it is.
    const titles = hit.kind === "page" ? hit.title.split(" › ") : [hit.title];
    const heading = hit.heading ? plain(hit.heading) : null;
    const text = plain(hit.text);
    return {
      id: `${hit.key}:${hit.heading ?? ""}:${hit.sheet ?? ""}`,
      icon: hit.picture
        ? Image
        : hit.kind === "page" || hit.kind === "summary"
          ? FileText
          : hit.kind === "table" || hit.kind === "file"
            ? itemIcon({ kind: hit.kind, children: 0, format: null })
            : TextQuote,
      // A page's picture opens its page; the thumbnail is the picture's own.
      thumb:
        hit.picture && hit.key.startsWith("f:") ? thumbUrl(spaceId, hit.key.slice(2)) : undefined,
      title: (
        <>
          {titles[titles.length - 1]}
          {heading && heading !== titles[titles.length - 1] ? (
            <span className="text-ink-3"> › {heading}</span>
          ) : null}
          {hit.sheet ? (
            <span className="text-ink-3"> · {t("know.palette.page", { n: hit.sheet })}</span>
          ) : null}
        </>
      ),
      where: titles.slice(0, -1).join(" › "),
      text: hit.picture ? undefined : text,
      relevance: hit.relevance,
      open: () => {
        if (hit.open) {
          // A file opens at its page; a table at its row; a page at the passage's block.
          openKey(
            page ? `${hit.open}#${page}` : hit.open,
            page ? { page } : hit.rowId ? { rowId: hit.rowId } : { words: wordsOf(text) },
          );
        } else if (hit.link) {
          onClose();
          navigate(hit.link);
        }
      },
    };
  };

  const hits = found?.result.hits ?? [];
  const folders = new Set(items.filter(isFolder).map((i) => i.key));
  const empty = asked.length < 2;
  // What the filters let through, as the search's `where` does.
  const fits = (item: KnowledgeItem) =>
    Object.entries(where).every(([name, w]) => {
      const category = categories.find((c) => c.name === name);
      const mine = item.categories.find((h) => h.categoryId === category?.id);
      return category && mine ? passes(category, mine.values, w) : false;
    });
  const recent = empty
    ? [...items]
        .filter((i) => !isFolder(i) && i.status !== "pending" && fits(i))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, RECENT)
    : [];
  const names = terms.length
    ? items
        .filter((i) => fits(i) && terms.every((w) => fold(i.title).includes(w)))
        .sort((a, b) => a.title.length - b.title.length)
        .slice(0, NAMES)
    : [];
  const askGoose = () => {
    if (!assistant) {
      return;
    }
    onClose();
    assistant.setOpen(true);
    if (asked) {
      void assistant.send(asked);
    }
  };
  const gooseRow: Row = {
    id: "goose",
    icon: MessageCircle,
    title: asked ? (
      <>
        {t("know.palette.goose")}: <b className="font-medium text-ink">„{asked}“</b>
      </>
    ) : (
      t("know.palette.gooseAbout")
    ),
    open: askGoose,
  };
  // Wissen first, then each mount of Dateien the person may see, in the order of its best hit.
  const own = hits.filter((h) => !h.mount);
  const mounts = [
    ...new Map(hits.flatMap((h) => (h.mount ? [[h.mount.id, h.mount] as const] : []))).values(),
  ];
  const groups: Group[] = empty
    ? []
    : [
        {
          id: "knowledge",
          label: t("know.title"),
          textsLabel: t("know.palette.texts", { place: t("know.title") }),
          names: names.map((i) => itemRow(i)),
          pictures: own
            .filter((h) => h.picture)
            .slice(0, PICTURES)
            .map(hitRow),
          // A folder's title is in the names already.
          texts: own.filter((h) => !(h.picture || folders.has(h.key))).map(hitRow),
        },
        ...mounts.map((m) => {
          const mine = hits.filter((h) => h.mount?.id === m.id);
          return {
            id: m.id,
            label: t("know.palette.mount", { name: m.name }),
            names: [],
            pictures: mine
              .filter((h) => h.picture)
              .slice(0, PICTURES)
              .map(hitRow),
            texts: mine.filter((h) => !h.picture).map(hitRow),
          };
        }),
      ];
  // What a step gets: the hits in their order, pictures among them, with the numbers.
  const steps = wizard && !empty ? hits.map(hitRow) : [];
  const recentRows = recent.map((i) => itemRow(i, true));
  const rows: Row[] = [
    ...(goose ? [gooseRow] : []),
    ...(empty
      ? recentRows
      : wizard
        ? steps
        : groups.flatMap((g) => [...g.names, ...g.pictures, ...g.texts])),
  ];
  // Enter takes the first result, not Goose's line above it (that is ⌘Enter).
  const first = goose && rows.length > 1 ? 1 : 0;
  const at = Math.min(active, Math.max(rows.length - 1, 0));
  // biome-ignore lint/correctness/useExhaustiveDependencies: back to the top for each new list
  useEffect(() => setActive(first), [asked, found, wizard, first]);
  useEffect(() => {
    list.current?.querySelector(`[data-i="${at}"]`)?.scrollIntoView({ block: "nearest" });
  }, [at]);

  const button = (row: Row, className: string, children: ReactNode) => {
    const i = rows.indexOf(row);
    return (
      <button
        key={row.id}
        type="button"
        role="option"
        id={`kp-${i}`}
        data-i={i}
        aria-selected={i === at}
        onClick={row.open}
        onMouseMove={() => i !== at && setActive(i)}
        className={cn(className, i === at && "bg-accent")}
      >
        {children}
      </button>
    );
  };
  const line = (row: Row) =>
    button(
      row,
      "flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left",
      <>
        <row.icon className="mt-0.5 size-4 shrink-0 text-ink-3" />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-[0.875rem]">{row.title}</span>
            {row.where ? (
              <span className="min-w-0 shrink truncate text-[0.75rem] text-ink-4">{row.where}</span>
            ) : null}
          </span>
          {row.text ? (
            <span className="line-clamp-2 text-[0.8125rem] text-ink-3">
              <Marked text={row.text} terms={terms} />
            </span>
          ) : null}
        </span>
        {row.at ? (
          <span className="shrink-0 whitespace-nowrap pt-0.5 text-[0.75rem] text-ink-4 tabular-nums">
            {row.at}
          </span>
        ) : null}
        {wizard && row.relevance !== undefined ? (
          <span className="shrink-0 pt-0.5 font-medium text-[0.75rem] text-moss tabular-nums">
            {row.relevance === null
              ? "–"
              : row.relevance.toLocaleString(lang, { minimumFractionDigits: 2 })}
          </span>
        ) : null}
      </>,
    );
  const picture = (row: Row) =>
    button(
      row,
      "flex w-28 shrink-0 flex-col gap-1 rounded-lg p-1.5 text-left",
      <>
        <span className="block aspect-[4/3] w-full overflow-hidden rounded-md bg-paper-2 ring-1 ring-border-soft">
          {row.thumb ? (
            <img src={row.thumb} alt="" loading="lazy" className="size-full object-cover" />
          ) : null}
        </span>
        <span className="line-clamp-2 text-[0.75rem] text-ink-2">{row.title}</span>
      </>,
    );
  const label = (text: string) => (
    <p className="px-3 pt-3 pb-1 font-medium text-[0.6875rem] text-ink-4 uppercase tracking-[0.12em]">
      {text}
    </p>
  );

  const result = found?.result;
  const state = !result
    ? asked.length >= 2
      ? t("know.palette.searching")
      : ""
    : [
        knowledge.data?.embeddings ? t("know.palette.meaning") : t("know.palette.words"),
        ranking ? t("know.palette.ranking") : result.checked ? t("know.palette.ranked") : "",
      ]
        .filter(Boolean)
        .join(" · ");
  const shownFilters = categories.filter(
    (c) => where[c.name] !== undefined || adding.includes(c.id),
  );
  const nothing =
    found && !hits.length && !groups.some((g) => g.names.length) ? (
      <p className="px-3 py-6 text-center text-[0.875rem] text-ink-3">
        {found.result.checked
          ? t("know.palette.noneChecked", { query: found.query })
          : t("know.palette.none", { query: found.query })}
      </p>
    ) : null;

  return (
    <div
      role="dialog"
      aria-label={t("know.palette")}
      className="mx-auto flex h-[min(36rem,calc(100dvh-6rem))] w-full max-w-2xl flex-col rounded-2xl bg-card shadow-overlay ring-1 ring-border-soft max-sm:h-dvh max-sm:max-w-none max-sm:rounded-none"
    >
      <label className="flex items-center gap-3 border-border-soft border-b px-4 py-3.5">
        <Search className="size-[18px] shrink-0 text-ink-3" />
        <input
          ref={input}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("know.searchAll")}
          role="combobox"
          aria-expanded={rows.length > 0}
          aria-controls="kp-list"
          aria-activedescendant={rows.length ? `kp-${at}` : undefined}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((at + 1) % Math.max(rows.length, 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((at - 1 + rows.length) % Math.max(rows.length, 1));
            } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              askGoose();
            } else if (e.key === "Enter") {
              e.preventDefault();
              rows[at]?.open();
            }
          }}
          className="min-w-0 flex-1 bg-transparent text-[1.0625rem] text-ink outline-none placeholder:text-ink-4"
        />
        {ranking ? <Spinner className="size-4 shrink-0 text-ink-3" /> : null}
        <kbd className="shrink-0 rounded-md px-1.5 font-mono text-[0.6875rem] text-ink-4 ring-1 ring-border-soft max-sm:hidden">
          esc
        </kbd>
        {/* A phone has no Escape. */}
        <IconButton label={t("common.close")} onClick={onClose} className="-mr-2 sm:hidden">
          <X className="size-4" />
        </IconButton>
      </label>
      {categories.length ? (
        <div className="flex flex-wrap items-center gap-1.5 px-4 pt-3">
          {shownFilters.map((c) => (
            <FilterChip
              key={c.id}
              category={c}
              value={where[c.name]}
              startOpen={where[c.name] === undefined}
              onChange={(next: WhereValue | undefined) => {
                setAdding((now) => now.filter((id) => id !== c.id));
                setWhere((now) => {
                  const copy = { ...now };
                  if (next === undefined) {
                    delete copy[c.name];
                  } else {
                    copy[c.name] = next;
                  }
                  return copy;
                });
              }}
            />
          ))}
          {shownFilters.length < categories.length ? (
            <div ref={filterRef} className="relative">
              <button
                type="button"
                onClick={() => setFilterMenu((o) => !o)}
                aria-expanded={filterMenu}
                className="inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[0.8125rem] text-ink-3 ring-1 ring-border ring-dashed transition hover:text-ink"
              >
                <ListFilter className="size-3.5" />
                {t("know.palette.filter")}
              </button>
              {filterMenu ? (
                <div
                  role="menu"
                  className="absolute top-full left-0 z-30 mt-1.5 w-56 animate-rise rounded-xl bg-card p-1.5 shadow-overlay ring-1 ring-border-soft"
                >
                  {categories
                    .filter((c) => !shownFilters.includes(c))
                    .map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setFilterMenu(false);
                          setAdding((now) => [...now, c.id]);
                        }}
                        className="flex w-full items-center rounded-lg px-2.5 py-2 text-left text-[0.8125rem] text-ink-2 transition hover:bg-accent hover:text-ink"
                      >
                        {c.name}
                      </button>
                    ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      <div ref={list} id="kp-list" role="listbox" className="min-h-0 flex-1 overflow-y-auto p-2">
        {goose
          ? button(
              gooseRow,
              "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-[0.8125rem] text-ink-2",
              <>
                <MessageCircle className="size-4 shrink-0 text-ember" />
                <span className="min-w-0 flex-1 truncate">{gooseRow.title}</span>
                <kbd className="shrink-0 font-mono text-[0.6875rem] text-ink-4 max-sm:hidden">
                  {MAC ? "⌘↵" : "Ctrl ↵"}
                </kbd>
              </>,
            )
          : null}
        {empty ? (
          recent.length ? (
            <>
              {label(t("know.recent"))}
              {recentRows.map(line)}
            </>
          ) : null
        ) : wizard ? (
          <>
            {result ? (
              <p className="px-3 pt-3 pb-1 text-[0.75rem] text-ink-3">
                {result.checked
                  ? t("know.searchStats", { candidates: result.candidates, hits: hits.length })
                  : t("know.searchUnchecked", { hits: hits.length })}
              </p>
            ) : null}
            {steps.map(line)}
            {nothing}
          </>
        ) : (
          <>
            {groups.map((g) => (
              <div key={g.id}>
                {g.names.length || g.pictures.length || (g.texts.length && !g.textsLabel)
                  ? label(g.label)
                  : null}
                {g.names.map(line)}
                {g.pictures.length ? (
                  <div className="flex gap-1 overflow-x-auto px-1 pb-1">
                    {g.pictures.map(picture)}
                  </div>
                ) : null}
                {g.texts.length && g.textsLabel ? label(g.textsLabel) : null}
                {g.texts.map(line)}
              </div>
            ))}
            {nothing}
          </>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-b-2xl border-border-soft border-t bg-paper-2 px-4 py-2.5 text-[0.75rem] text-ink-3 max-sm:rounded-none">
        <span className="max-sm:hidden">↑ ↓ {t("know.palette.choose")}</span>
        <span className="inline-flex items-center gap-1 max-sm:hidden">
          <CornerDownLeft className="size-3" /> {t("know.palette.open")}
        </span>
        <span className="min-w-0 flex-1 truncate">{state}</span>
        <label className="inline-flex items-center gap-2" title={t("know.palette.wizardHint")}>
          <Switch checked={wizard} onChange={setWizard} />
          {t("know.palette.wizard")}
        </label>
      </div>
    </div>
  );
}
