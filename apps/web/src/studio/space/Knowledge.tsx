import type {
  CategoryCell,
  ItemCategory,
  Knowledge,
  KnowledgeItem,
  KnowledgeSearch,
  KnowledgeValue,
  SpaceCategory,
  Where,
  WhereValue,
} from "@engenty/wizards-shared/knowledge";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  Files,
  FileText,
  type LucideIcon,
  MessagesSquare,
  Paperclip,
  Plus,
  Table2,
  Upload,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { lang, t } from "../../lib/i18n";
import { keys } from "../../lib/keys";
import {
  Button,
  Card,
  Chip,
  cn,
  Dialog,
  Empty,
  Input,
  Label,
  Segmented,
  Select,
  Spinner,
  Switch,
  Textarea,
} from "../../ui";
import { useAssistant } from "../assistant/chat";
import {
  CATEGORY_ICON,
  categoryLine,
  ItemCategories,
  NewCategoryDialog,
  shownValue,
} from "./Categories";
import { fileUrl, thumbUrl, useFileActions } from "./data";
import { folderSources } from "./KnowledgeTree";
import { DropArea, SearchField, Section } from "./Section";

/** Knowledge of a space: its items and categories; asked again while a document is still read. */
export function useKnowledge(spaceId: string | undefined) {
  return useQuery({
    queryKey: keys.knowledge(spaceId),
    queryFn: () => api.get<Knowledge>(`/api/studio/spaces/${spaceId}/knowledge`),
    enabled: Boolean(spaceId),
    refetchInterval: (query) =>
      query.state.data?.items.some((i) => i.status === "pending") ? 2000 : false,
  });
}

export function itemIcon(item: Pick<KnowledgeItem, "kind" | "children" | "format">): LucideIcon {
  if (item.kind === "table") {
    return item.format === "faq" ? MessagesSquare : Table2;
  }
  if (item.kind === "file") {
    return Paperclip;
  }
  return item.children ? Files : FileText;
}

/** An item of Knowledge as a row: what it is, its categories in one line, where it came from. */
export function ItemRow({
  item,
  categories,
  onOpen,
}: {
  item: KnowledgeItem;
  categories: SpaceCategory[];
  onOpen: (key: string) => void;
}) {
  const Icon = itemIcon(item);
  const meta = [
    categoryLine(categories, item.categories),
    item.children
      ? item.children === 1
        ? t("know.oneSub")
        : t("know.sub", { n: item.children })
      : "",
    item.rows !== null ? (item.rows === 1 ? t("know.row") : t("know.rows", { n: item.rows })) : "",
    item.originLabel ?? "",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <button
      type="button"
      onClick={() => onOpen(item.key)}
      disabled={item.status === "pending"}
      className="flex items-start gap-3 rounded-lg px-3 py-2.5 text-left transition hover:bg-accent disabled:pointer-events-none"
    >
      <Icon className="mt-0.5 size-4 shrink-0 text-ink-3" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[0.875rem]">{item.title}</span>
        {meta ? <span className="block truncate text-[0.75rem] text-ink-3">{meta}</span> : null}
      </span>
      {item.status === "pending" ? (
        <span className="inline-flex shrink-0 items-center gap-1.5 text-[0.75rem] text-ink-3">
          <Spinner className="size-3" /> {t("know.reading")}
        </span>
      ) : item.review ? (
        <Chip tone="warn" title={item.review}>
          {t("know.review")}
        </Chip>
      ) : null}
    </button>
  );
}

// --- what an opened item says about itself ------------------------------------------------------

/**
 * Above an opened item of Knowledge: its categories, where it came from (a source, by hand since),
 * why a person should look at it, and its original.
 */
export function KnowledgeHeader({
  spaceId,
  itemKey,
  has,
  originLabel,
  kept,
  review,
  file,
  readOnly,
  onReviewed,
}: {
  spaceId: string;
  itemKey: string;
  has: ItemCategory[];
  originLabel: string | null;
  kept: boolean;
  review: string | null;
  file: { id: string; name: string } | null;
  readOnly: boolean;
  onReviewed: () => void;
}) {
  const knowledge = useKnowledge(spaceId);
  const notes = [
    originLabel
      ? kept
        ? t("know.kept", { label: originLabel })
        : t("know.from", { label: originLabel })
      : "",
  ].filter(Boolean);
  return (
    <div className="flex flex-col gap-2 px-1">
      {knowledge.data ? (
        <ItemCategories
          spaceId={spaceId}
          itemKey={itemKey}
          has={has}
          categories={knowledge.data.categories}
          readOnly={readOnly}
        />
      ) : null}
      {notes.length || file || review ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.75rem] text-ink-4">
          {notes.map((n) => (
            <span key={n}>{n}</span>
          ))}
          {file ? (
            <a
              href={fileUrl(spaceId, file.id)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 underline-offset-2 hover:text-ink hover:underline"
            >
              <Paperclip className="size-3.5" /> {t("know.original")}: {file.name}
            </a>
          ) : null}
          {review ? (
            <span className="inline-flex items-center gap-2">
              <Chip tone="warn">{t("know.review")}</Chip>
              <span>{review}</span>
              {readOnly ? null : (
                <button type="button" onClick={onReviewed} className="underline hover:text-ink">
                  {t("know.reviewed")}
                </button>
              )}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// --- the entries of a category ----------------------------------------------------------------

/** A range of numbers: from `lo`, up to but not including `hi`. */
interface NumberRange {
  lo: number;
  hi: number;
}

/**
 * At most seven ranges that split numbers into groups. Spread over orders of magnitude (from
 * 10.000 € to 3 Mio. €), they step by 1, 2, 5 times a power of ten — or by 1 and 3, or by
 * powers of ten, where that gives fewer; otherwise they are of equal width, a round one. Only
 * ranges that hold a number are given. None for a handful of numbers: they stand by value.
 */
export function numberRanges(values: number[]): NumberRange[] {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (new Set(sorted).size <= 4) {
    return [];
  }
  const min = sorted[0];
  const max = sorted.at(-1) as number;
  const filled = (bounds: number[]) =>
    bounds
      .slice(0, -1)
      .map((lo, i) => ({ lo, hi: bounds[i + 1] }))
      .filter((r) => sorted.some((v) => v >= r.lo && v < r.hi));
  if (min > 0 && max / min >= 30) {
    const first = Math.floor(Math.log10(min));
    const last = Math.floor(Math.log10(max)) + 1;
    for (const steps of [[1, 2, 5], [1, 3], [1]]) {
      const bounds: number[] = [];
      for (let k = first; k <= last; k++) {
        for (const step of steps) {
          bounds.push(step * 10 ** k);
        }
      }
      const ranges = filled(bounds.filter((b, i) => b <= min || bounds[i - 1] <= max));
      if (ranges.length <= 7) {
        return ranges;
      }
    }
  }
  const rough = (max - min) / 5;
  const power = 10 ** Math.floor(Math.log10(rough));
  const width = ([1, 2, 2.5, 5, 10].map((f) => f * power).find((w) => w >= rough) ?? rough) || 1;
  const bounds: number[] = [];
  for (let b = Math.floor(min / width) * width; b <= max; b += width) {
    bounds.push(b);
  }
  bounds.push((bounds.at(-1) as number) + width);
  return filled(bounds);
}

/**
 * Everything that has a category, in groups: days by month, newest first; yes and no; a text by
 * its value; numbers in ranges, from the lowest up. What a choice's values list, its values'
 * pages do.
 */
export function CategoryItems({
  spaceId,
  category,
  categories,
  onOpen,
}: {
  spaceId: string;
  category: SpaceCategory;
  categories: SpaceCategory[];
  onOpen: (key: string) => void;
}) {
  const contents = useQuery({
    queryKey: ["knowledge", spaceId, "category", category.id],
    queryFn: () =>
      api.get<Pick<KnowledgeValue, "items" | "rows">>(
        `/api/studio/categories/${category.id}/items`,
      ),
  });
  if (!contents.data) {
    return contents.isLoading ? <Spinner className="mx-auto size-4 text-ink-3" /> : null;
  }
  const first = (item: KnowledgeItem) =>
    item.categories.find((c) => c.categoryId === category.id)?.values[0];
  const items = [...contents.data.items].sort((a, b) => {
    const x = first(a);
    const y = first(b);
    return typeof x === "number" && typeof y === "number"
      ? x - y
      : String(y ?? "").localeCompare(String(x ?? ""), lang);
  });
  const ranges =
    category.type === "number"
      ? numberRanges(items.map(first).filter((v): v is number => typeof v === "number"))
      : [];
  const compact = new Intl.NumberFormat(lang, { notation: "compact", maximumFractionDigits: 1 });
  const unit = category.unit ? ` ${category.unit}` : "";
  const groups = new Map<string, KnowledgeItem[]>();
  for (const item of items) {
    const v = first(item);
    const range = typeof v === "number" ? ranges.find((r) => v >= r.lo && v < r.hi) : undefined;
    const label =
      v === undefined
        ? ""
        : category.type === "date"
          ? new Date(`${String(v).slice(0, 7)}-01T00:00:00`).toLocaleDateString(lang, {
              month: "long",
              year: "numeric",
            })
          : range
            ? t("know.range", {
                min: `${compact.format(range.lo)}${unit}`,
                max: `${compact.format(range.hi)}${unit}`,
              })
            : shownValue(category, v);
    groups.set(label, [...(groups.get(label) ?? []), item]);
  }
  return (
    <div className="flex flex-col gap-5">
      {[...groups].map(([label, list]) => (
        <div key={label} className="flex flex-col gap-1.5">
          {label ? (
            <p className="px-1 font-medium text-[0.6875rem] text-ink-4 uppercase tracking-[0.12em]">
              {label}
            </p>
          ) : null}
          <Card className="flex flex-col p-1.5">
            {list.map((item) => (
              <ItemRow key={item.key} item={item} categories={categories} onOpen={onOpen} />
            ))}
          </Card>
        </div>
      ))}
      {contents.data.rows.map((r) => (
        <button
          key={r.tableId}
          type="button"
          onClick={() => onOpen(`t:${r.tableId}`)}
          className="px-1 text-left text-[0.8125rem] text-ink-3 hover:text-ink"
        >
          {t("know.tocRows", { n: r.count, table: r.title })}
        </button>
      ))}
    </div>
  );
}

// --- filters ---------------------------------------------------------------------------------

/** Whether an item's value of a category passes a filter on it. */
export function passes(category: SpaceCategory, values: CategoryCell[], w: WhereValue): boolean {
  if (Array.isArray(w)) {
    return values.some((v) => w.map(String).includes(String(v)));
  }
  if (typeof w === "object" && w !== null) {
    return values.some((v) => {
      if (category.type === "number" && typeof v === "number") {
        return (w.gte === undefined || v >= w.gte) && (w.lte === undefined || v <= w.lte);
      }
      if (category.type === "date") {
        const day = String(v).slice(0, 10);
        return (!w.after || day >= w.after) && (!w.before || day <= w.before);
      }
      return w.contains ? String(v).toLowerCase().includes(w.contains.toLowerCase()) : true;
    });
  }
  return values.some((v) => v === w);
}

function filterLabel(category: SpaceCategory, w: WhereValue): string {
  if (Array.isArray(w)) {
    return w.map(String).join(", ");
  }
  if (typeof w === "boolean") {
    return w ? t("know.yes") : t("know.no");
  }
  if (typeof w === "object" && w !== null) {
    const from = w.gte ?? w.after;
    const to = w.lte ?? w.before;
    if (w.contains) {
      return `${t("know.contains")} ${w.contains}`;
    }
    return [
      from !== undefined ? `${t("know.minimum")} ${shownValue(category, from)}` : "",
      to !== undefined ? `${t("know.maximum")} ${shownValue(category, to)}` : "",
    ]
      .filter(Boolean)
      .join(" ");
  }
  return String(w);
}

/** One category as a filter: a chip that opens what it can be set to. */
/**
 * A choice's values to filter by, as a short list to tick: each with how many items have it,
 * a field to find one once there are more than ten, the list scrolling past a dozen.
 */
function ValueChecklist({
  values,
  picked,
  onChange,
}: {
  values: { id: string; value: string; count: number }[];
  picked: string[];
  onChange: (next: string[]) => void;
}) {
  const [find, setFind] = useState("");
  const shown = find
    ? values.filter((v) => v.value.toLowerCase().includes(find.toLowerCase()))
    : values;
  return (
    <div className="flex flex-col gap-1">
      {values.length > 10 ? (
        <Input
          data-autofocus
          value={find}
          placeholder={t("know.findValue")}
          onChange={(e) => setFind(e.target.value)}
          className="h-8 text-[0.8125rem]"
        />
      ) : null}
      <ul className="max-h-72 overflow-y-auto">
        {shown.map((v) => {
          const on = picked.includes(v.value);
          return (
            <li key={v.id}>
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={on}
                onClick={() =>
                  onChange(on ? picked.filter((p) => p !== v.value) : [...picked, v.value])
                }
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[0.8125rem] text-ink-2 transition hover:bg-accent hover:text-ink"
              >
                <span
                  className={cn(
                    "grid size-3.5 shrink-0 place-items-center rounded-[4px] ring-1",
                    on ? "bg-ember text-white ring-ember" : "ring-border",
                  )}
                >
                  {on ? <Check className="size-3" /> : null}
                </span>
                <span className="min-w-0 flex-1 truncate">{v.value}</span>
                <span className="text-[0.75rem] text-ink-4 tabular-nums">{v.count}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {picked.length ? (
        <button
          type="button"
          onClick={() => onChange([])}
          className="self-start px-2 py-1 text-[0.75rem] text-ink-3 underline hover:text-ink"
        >
          {t("know.clear")}
        </button>
      ) : null}
    </div>
  );
}

export function FilterChip({
  category,
  value,
  onChange,
  startOpen = false,
}: {
  category: SpaceCategory;
  value: WhereValue | undefined;
  onChange: (next: WhereValue | undefined) => void;
  /** Open from the start: a filter just added, to pick its value. */
  startOpen?: boolean;
}) {
  const [open, setOpen] = useState(startOpen);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) {
      return;
    }
    const away = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);
  const Icon = CATEGORY_ICON[category.type];
  const range = typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
  const setRange = (key: "gte" | "lte" | "after" | "before", v: string) => {
    const next = {
      ...range,
      [key]: v === "" ? undefined : category.type === "number" ? Number(v) : v,
    };
    const clean = Object.fromEntries(Object.entries(next).filter(([, x]) => x !== undefined));
    onChange(Object.keys(clean).length ? (clean as WhereValue) : undefined);
  };
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={cn(
          "inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[0.8125rem] transition",
          value === undefined
            ? "text-ink-2 ring-1 ring-border-soft hover:ring-border"
            : "bg-ember-tint text-ink ring-1 ring-ember/30",
        )}
      >
        <Icon className="size-3.5 text-ink-3" />
        {category.name}
        {value !== undefined ? (
          <span className="font-medium">: {filterLabel(category, value)}</span>
        ) : null}
        <ChevronDown className="size-3.5 text-ink-3" />
      </button>
      {open ? (
        <div className="absolute top-full left-0 z-30 mt-1.5 w-64 max-w-[calc(100vw-32px)] rounded-xl bg-card p-1.5 shadow-overlay ring-1 ring-border-soft">
          {category.type === "choice" ? (
            <ValueChecklist
              values={category.values}
              picked={Array.isArray(value) ? value.map(String) : []}
              onChange={(next) => onChange(next.length ? next : undefined)}
            />
          ) : category.type === "boolean" ? (
            <Segmented
              value={value === true ? t("know.yes") : value === false ? t("know.no") : ""}
              options={[t("know.yes"), t("know.no")]}
              onChange={(v: string) => onChange(v === t("know.yes"))}
            />
          ) : category.type === "text" ? (
            <Input
              data-autofocus
              value={range.contains ?? ""}
              placeholder={t("know.contains")}
              onChange={(e) => onChange(e.target.value ? { contains: e.target.value } : undefined)}
              className="h-9"
            />
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {(category.type === "number"
                ? (["gte", "lte"] as const)
                : (["after", "before"] as const)
              ).map((key, i) => (
                <div key={key}>
                  <Label>{i === 0 ? t("know.minimum") : t("know.maximum")}</Label>
                  <Input
                    type={category.type === "number" ? "number" : "date"}
                    step="any"
                    value={String(range[key] ?? "")}
                    placeholder={
                      category.range
                        ? String(i === 0 ? category.range.min : category.range.max)
                        : ""
                    }
                    onChange={(e) => setRange(key, e.target.value)}
                    className="h-9"
                  />
                </div>
              ))}
            </div>
          )}
          {value !== undefined ? (
            <button
              type="button"
              onClick={() => {
                onChange(undefined);
                setOpen(false);
              }}
              className="mt-3 text-[0.8125rem] text-ink-3 underline hover:text-ink"
            >
              {t("know.clear")}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// --- the search, as a step gets it ---------------------------------------------------------------

export function SearchHits({
  spaceId,
  found,
  onOpen,
}: {
  spaceId: string;
  found: KnowledgeSearch;
  onOpen: (key: string) => void;
}) {
  if (!found.hits.length) {
    return <p className="px-3 py-4 text-[0.875rem] text-ink-3">{t("know.searchNone")}</p>;
  }
  // Pictures found by what they show, or a page's pictures by their words: a group of their own.
  const pictures = found.hits.filter((h) => h.picture === "image" && h.key.startsWith("f:"));
  const texts = found.hits.filter((h) => !pictures.includes(h));
  return (
    <div className="flex flex-col">
      <p className="px-3 pt-1 pb-2 text-[0.75rem] text-ink-3">
        {found.checked
          ? t("know.searchStats", { candidates: found.candidates, hits: found.hits.length })
          : t("know.searchUnchecked", { hits: found.hits.length })}
      </p>
      {pictures.length ? (
        <div className="flex flex-col gap-1.5 px-3 pb-2">
          <p className="font-medium text-[0.6875rem] text-ink-4 uppercase tracking-[0.12em]">
            {t("know.pictures")}
          </p>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {pictures.map((hit) => (
              <button
                key={hit.key}
                type="button"
                disabled={!hit.open}
                onClick={() => hit.open && onOpen(hit.open)}
                title={hit.title}
                className="flex w-28 shrink-0 flex-col gap-1 text-left disabled:pointer-events-none"
              >
                <img
                  src={thumbUrl(spaceId, hit.key.slice(2))}
                  alt={hit.title}
                  loading="lazy"
                  className="aspect-[4/3] w-full rounded-lg bg-paper-2 object-cover"
                />
                <span className="truncate text-[0.75rem] text-ink-3">{hit.title}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {texts.map((hit) => {
        const open = hit.open;
        return (
          <button
            key={`${hit.key}:${hit.heading}`}
            type="button"
            disabled={!open}
            // A file opens where the hit stands: `f:<id>#<page>`.
            onClick={() =>
              open && onOpen(hit.sheet && open.startsWith("f:") ? `${open}#${hit.sheet}` : open)
            }
            className="flex items-start gap-3 rounded-lg px-3 py-2.5 text-left transition hover:bg-accent disabled:pointer-events-none"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[0.875rem]">
                {hit.title}
                {hit.heading && hit.heading !== hit.title ? (
                  <span className="text-ink-3"> › {hit.heading}</span>
                ) : null}
              </span>
              <span className="line-clamp-2 text-[0.8125rem] text-ink-3">{hit.text}</span>
            </span>
            {hit.relevance !== null ? (
              <span className="shrink-0 font-medium text-[0.75rem] text-moss tabular-nums">
                {hit.relevance.toLocaleString(lang, { minimumFractionDigits: 2 })}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

// --- a new page or table -----------------------------------------------------------------------

/** What a page could ask Goose for, one click away. */
const GOOSE_EXAMPLES = ["know.gooseExample1", "know.gooseExample2", "know.gooseExample3"] as const;

/** A folder of one's own, by its titles from the top („Handbuch › Montage“). */
function ownFolders(items: KnowledgeItem[]): { id: string; label: string }[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const trail = (item: KnowledgeItem): string[] | null => {
    if (folderSources.has(item.id) || item.origin) {
      return null;
    }
    const up = item.parentId ? byId.get(item.parentId) : null;
    if (!up) {
      return [item.title];
    }
    const above = trail(up);
    return above ? [...above, item.title] : null;
  };
  return items
    .filter((i) => i.kind === "page" && i.blank)
    .flatMap((i) => {
      const titles = trail(i);
      return titles ? [{ id: i.id, label: titles.join(" › ") }] : [];
    })
    .sort((a, b) => a.label.localeCompare(b.label, lang));
}

/**
 * A new page, table or folder: where it goes and what it is called. A page can be written by
 * Goose from a few words instead, and files dropped on it go into the folder as they are.
 */
export function NewItemDialog({
  kind,
  spaceId,
  parentId = null,
  onClose,
  onMade,
}: {
  /** `folder`: a page without text, that holds what goes into it. */
  kind: "page" | "table" | "folder" | null;
  spaceId: string;
  /** The folder it goes into; the top when left out. */
  parentId?: string | null;
  onClose: () => void;
  onMade: (key: string) => void;
}) {
  const qc = useQueryClient();
  const assistant = useAssistant();
  const knowledge = useKnowledge(spaceId);
  const files = useFileActions(spaceId, false);
  const [title, setTitle] = useState("");
  const [faq, setFaq] = useState(false);
  const [into, setInto] = useState(parentId ?? "");
  const [ask, setAsk] = useState("");
  // Opened again, it starts in the folder it was opened from, empty.
  useEffect(() => {
    if (kind) {
      setInto(parentId ?? "");
      setTitle("");
      setAsk("");
      setFaq(false);
    }
  }, [kind, parentId]);
  const items = knowledge.data?.items ?? [];
  const folders = ownFolders(items);
  const folder = items.find((i) => i.id === into) ?? null;
  const goose = kind === "page" && assistant !== null;
  const asking = goose && ask.trim() !== "";
  const make = useMutation({
    mutationFn: () =>
      api.post<{ id: string }>(
        `/api/studio/spaces/${spaceId}/${kind === "table" ? "tables" : "pages"}`,
        {
          title: title.trim(),
          ...(into ? { parentId: into } : {}),
          ...(kind === "table" && faq ? { format: "faq" } : {}),
        },
      ),
    onSuccess: async ({ id }) => {
      await qc.invalidateQueries({ queryKey: keys.knowledge(spaceId) });
      onMade(`${kind === "table" ? "t" : "p"}:${id}`);
    },
  });
  const upload = useMutation({
    mutationFn: async (picked: File[]) => {
      await files.upload("document", picked, into || null);
      await qc.invalidateQueries({ queryKey: keys.knowledge(spaceId) });
    },
    onSuccess: onClose,
  });
  // Goose writes the page (write_knowledge_page) in its chat, where it can be asked for more.
  const askGoose = () => {
    if (!assistant) {
      return;
    }
    const words = [
      t("know.gooseNew"),
      folder ? t("know.gooseIn", { path: folder.path }) : "",
      title.trim() ? t("know.gooseTitled", { title: title.trim() }) : "",
    ].join("");
    assistant.setOpen(true);
    void assistant.send(`${words}: ${ask.trim()}`);
    onClose();
  };
  const error = (make.error ?? upload.error) as Error | null;
  return (
    <Dialog
      open={kind !== null}
      onClose={onClose}
      title={
        kind === "table"
          ? t("know.newTable")
          : kind === "folder"
            ? t("know.newFolder")
            : t("know.newPage")
      }
    >
      <form
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (asking) {
            askGoose();
          } else if (title.trim()) {
            make.mutate();
          }
        }}
      >
        <div className="flex flex-col gap-1.5">
          <Label>{t("know.inFolder")}</Label>
          <Select
            value={into}
            onChange={setInto}
            options={[
              { value: "", label: t("know.title") },
              ...folders.map((f) => ({ value: f.id, label: `${t("know.title")} › ${f.label}` })),
            ]}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>{t("data.title")}</Label>
          <Input
            data-autofocus
            value={title}
            maxLength={120}
            placeholder={kind === "page" ? t("know.titlePlaceholder") : undefined}
            onChange={(e) => setTitle(e.target.value)}
          />
          {goose ? (
            <p className="text-[0.75rem] text-ink-3">
              {asking ? t("know.gooseNames") : t("know.pageHint")}
            </p>
          ) : null}
        </div>
        {kind === "table" ? (
          <label className="flex items-center justify-between gap-3 text-[0.875rem]">
            {t("know.asFaq")}
            <Switch checked={faq} onChange={setFaq} />
          </label>
        ) : null}
        {goose ? (
          <div className="flex flex-col gap-1.5">
            <Label>{t("know.gooseWrite")}</Label>
            <Textarea
              value={ask}
              minRows={2}
              maxRows={6}
              placeholder={t("know.gooseWritePlaceholder")}
              onChange={(e) => setAsk(e.target.value)}
            />
            <div className="flex flex-wrap gap-1.5">
              {GOOSE_EXAMPLES.map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setAsk(t(key))}
                  className="h-7 rounded-full bg-paper-2 px-2.5 text-[0.75rem] text-ink-2 transition hover:bg-accent hover:text-ink"
                >
                  {t(key)}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {kind === "page" ? (
          <DropArea onFiles={(picked) => upload.mutate(picked)} className="h-14">
            {upload.isPending ? <Spinner className="size-4" /> : <Upload className="size-4" />}
            {t("know.dropOrUpload")}
          </DropArea>
        ) : null}
        {error ? <p className="text-[0.875rem] text-rose">{error.message}</p> : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" busy={make.isPending} disabled={!(asking || title.trim())}>
            {asking ? t("know.askGoose") : t("know.create")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

// --- Knowledge, all of it ------------------------------------------------------------------------

/**
 * Knowledge without an item picked: proposals to take, a search to try as a step would get it,
 * filters by category, what the plugins are busy with, the items, and the way to add documents,
 * pages, tables and categories.
 */
export function KnowledgeOverview({
  spaceId,
  data,
  readOnly,
  onOpen,
  status,
}: {
  spaceId: string;
  data: Knowledge;
  readOnly: boolean;
  onOpen: (key: string) => void;
  /** The plugins' sections' status lines (a source reading, say), above the items. */
  status?: ReactNode;
}) {
  const qc = useQueryClient();
  const files = useFileActions(spaceId, readOnly);
  const [where, setWhere] = useState<Where>({});
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<KnowledgeSearch | null>(null);
  const [searching, setSearching] = useState(false);
  const [making, setMaking] = useState<"page" | "table" | "category" | null>(null);
  const taken = data.categories.filter((c) => !c.proposed && c.count > 0);
  const proposed = data.categories.filter((c) => c.proposed);
  // Sub-pages stand under their page.
  const shown = data.items.filter(
    (item) =>
      !(item.kind === "page" && item.parentId) &&
      Object.entries(where).every(([name, w]) => {
        const category = data.categories.find((c) => c.name === name);
        const mine = item.categories.find((h) => h.categoryId === category?.id);
        return category && mine ? passes(category, mine.values, w) : false;
      }),
  );
  const search = async () => {
    if (!query.trim()) {
      setFound(null);
      return;
    }
    setSearching(true);
    try {
      setFound(
        await api.post<KnowledgeSearch>(`/api/studio/spaces/${spaceId}/search`, {
          query,
          ...(Object.keys(where).length ? { where } : {}),
        }),
      );
    } catch {
      setFound({ hits: [], candidates: 0, checked: false, filtered: null });
    } finally {
      setSearching(false);
    }
  };
  const take = useMutation({
    mutationFn: ({ id, keep }: { id: string; keep: boolean }) =>
      keep
        ? api.patch(`/api/studio/categories/${id}`, { proposed: false })
        : api.del(`/api/studio/categories/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.knowledge(spaceId) }),
  });
  return (
    <Section
      title={t("know.title")}
      hint={t("know.hint")}
      plain
      action={
        readOnly ? null : (
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setMaking("page")}>
              <Plus className="size-4" /> {t("know.page")}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setMaking("table")}>
              <Plus className="size-4" /> {t("know.table")}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setMaking("category")}>
              <Plus className="size-4" /> {t("know.category")}
            </Button>
          </div>
        )
      }
    >
      {proposed.length && !readOnly ? (
        <Card className="flex flex-col gap-2 p-4">
          {proposed.map((c) => {
            const Icon = CATEGORY_ICON[c.type];
            return (
              <div key={c.id} className="flex flex-wrap items-center gap-2.5">
                <Chip tone="ember">{t("know.proposed")}</Chip>
                <Icon className="size-4 text-ink-3" />
                <span className="font-medium text-[0.875rem]">{c.name}</span>
                <span className="min-w-0 flex-1 truncate text-[0.8125rem] text-ink-3">
                  {[t(`know.type.${c.type}`), c.hint].filter(Boolean).join(" · ")}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => take.mutate({ id: c.id, keep: false })}
                >
                  {t("know.dismiss")}
                </Button>
                <Button size="sm" onClick={() => take.mutate({ id: c.id, keep: true })}>
                  {t("know.accept")}
                </Button>
              </div>
            );
          })}
        </Card>
      ) : null}
      {data.items.length ? (
        <div className="flex flex-col gap-2">
          <SearchField
            value={query}
            placeholder={t("know.search")}
            busy={searching}
            onEnter={() => void search()}
            onChange={(next) => {
              setQuery(next);
              if (!next.trim()) {
                setFound(null);
              }
            }}
          />
          {taken.length ? (
            <div className="flex flex-wrap items-center gap-1.5">
              {taken.map((c) => (
                <FilterChip
                  key={c.id}
                  category={c}
                  value={where[c.name]}
                  onChange={(next) => {
                    setFound(null);
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
              {Object.keys(where).length ? (
                <button
                  type="button"
                  onClick={() => setWhere({})}
                  className="px-2 text-[0.8125rem] text-ink-3 underline hover:text-ink"
                >
                  {t("know.clear")}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {status}
      <Card className="flex flex-col p-1.5">
        {found ? (
          <SearchHits spaceId={spaceId} found={found} onOpen={onOpen} />
        ) : shown.length ? (
          shown.map((item) => (
            <ItemRow key={item.key} item={item} categories={data.categories} onOpen={onOpen} />
          ))
        ) : (
          <Empty>{t("know.empty")}</Empty>
        )}
      </Card>
      {readOnly ? null : (
        <DropArea
          accept=".pdf,.docx,.doc,.xlsx,.csv,.tsv,.txt,.md,.json,.html,.eml,image/*"
          onFiles={async (picked) => {
            await files.upload("document", picked);
            await qc.invalidateQueries({ queryKey: keys.knowledge(spaceId) });
          }}
          className="h-14 w-full"
        >
          {files.busy ? <Spinner className="size-4" /> : <Upload className="size-4" />}
          {t("know.drop")} <span className="underline">{t("know.pick")}</span>
        </DropArea>
      )}
      {files.error ? <p className="text-[0.875rem] text-rose">{files.error}</p> : null}
      {data.items.length && !(data.checked && data.embeddings) ? (
        <p className="px-1 text-[0.8125rem] text-ink-3">
          {[data.embeddings ? "" : t("know.keywordsOnly"), data.checked ? "" : t("know.unchecked")]
            .filter(Boolean)
            .join(" ")}
        </p>
      ) : null}
      <NewItemDialog
        kind={making === "page" || making === "table" ? making : null}
        spaceId={spaceId}
        onClose={() => setMaking(null)}
        onMade={(key) => {
          setMaking(null);
          onOpen(key);
        }}
      />
      <NewCategoryDialog
        spaceId={spaceId}
        open={making === "category"}
        onClose={() => setMaking(null)}
        onMade={(id) => {
          setMaking(null);
          onOpen(`c:${id}`);
        }}
      />
    </Section>
  );
}
