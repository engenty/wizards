import type {
  Knowledge,
  KnowledgeItem,
  KnowledgeSearch,
  SpaceCategory,
  Where,
} from "@engenty/wizards-shared/knowledge";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  FileText,
  type LucideIcon,
  PenLine,
  Plus,
  Puzzle,
  Table2,
  Tag,
  Upload,
} from "lucide-react";
import { type ComponentType, type ReactNode, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { api } from "../../lib/api";
import { lang, t } from "../../lib/i18n";
import { keys } from "../../lib/keys";
import { Button, Card, Chip, cn, Spinner } from "../../ui";
import { CATEGORY_ICON, NewCategoryDialog, shownValue } from "./Categories";
import { useFileActions } from "./data";
import { FilterChip, itemIcon, NewItemDialog, passes, SearchHits } from "./Knowledge";
import { SearchField, Section } from "./Section";

/** What uploads take: documents that become pages and tables, and pictures. */
const DOCUMENTS = ".pdf,.docx,.doc,.xlsx,.csv,.tsv,.txt,.md,.json,.html,.eml,image/*";

/** An entry a plugin adds to „Hinzufügen“: it opens the plugin's section of Knowledge. */
export interface KnowledgeAdd {
  /** The section's id. */
  id: string;
  label: string;
  hint?: string;
  icon?: ComponentType<{ className?: string }>;
}

/** „gerade“, „vor 2 Std.“, „gestern“, „Mo.“, „12. Okt.“: when an item last changed, short. */
function when(iso: string): string {
  const then = new Date(iso);
  const minutes = (Date.now() - then.getTime()) / 60_000;
  const short = new Intl.RelativeTimeFormat(lang, { numeric: "auto", style: "short" });
  if (minutes < 1) {
    return t("know.justNow");
  }
  if (minutes < 60) {
    return short.format(-Math.round(minutes), "minute");
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.ceil((today.getTime() - then.getTime()) / 86_400_000);
  if (days <= 0) {
    return short.format(-Math.round(minutes / 60), "hour");
  }
  if (days === 1) {
    return new Intl.RelativeTimeFormat(lang, { numeric: "auto" }).format(-1, "day");
  }
  return days < 7
    ? then.toLocaleDateString(lang, { weekday: "short" })
    : then.toLocaleDateString(lang, { day: "numeric", month: "short" });
}

/** An item's first two category values, as chips: a yes shows as its category's name. */
function chipsOf(item: KnowledgeItem, categories: SpaceCategory[]): string[] {
  return categories
    .flatMap((c) => {
      const mine = item.categories.find((h) => h.categoryId === c.id);
      if (!mine) {
        return [];
      }
      if (c.type === "boolean") {
        return mine.values[0] === true ? [c.name] : [];
      }
      return mine.values.map((v) => shownValue(c, v));
    })
    .slice(0, 2);
}

/** An item as a quiet row: what it is, its title, where it came from, two chips, when it changed. */
function KnowledgeRow({
  item,
  categories,
  onOpen,
}: {
  item: KnowledgeItem;
  categories: SpaceCategory[];
  onOpen: (key: string) => void;
}) {
  const Icon = itemIcon(item);
  const where = [
    item.originLabel ?? "",
    item.rows !== null ? (item.rows === 1 ? t("know.row") : t("know.rows", { n: item.rows })) : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <button
      type="button"
      onClick={() => onOpen(item.key)}
      disabled={item.status === "pending"}
      className="flex items-center gap-3 rounded-lg px-3 py-2 text-left transition hover:bg-accent disabled:pointer-events-none"
    >
      <Icon className="size-4 shrink-0 text-ink-3" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[0.875rem]">{item.title}</span>
        {where ? <span className="block truncate text-[0.75rem] text-ink-3">{where}</span> : null}
      </span>
      <span className="flex shrink-0 items-center gap-1.5 max-sm:hidden">
        {item.status === "pending" ? (
          <Chip icon={<Spinner className="size-3" />}>{t("know.reading")}</Chip>
        ) : (
          chipsOf(item, categories).map((c) => <Chip key={c}>{c}</Chip>)
        )}
        {item.review ? (
          <Chip tone="warn" title={item.review}>
            {t("know.review")}
          </Chip>
        ) : null}
      </span>
      <span className="w-20 shrink-0 whitespace-nowrap text-right text-[0.75rem] text-ink-4 tabular-nums">
        {when(item.updatedAt)}
      </span>
    </button>
  );
}

/** One way in, in „Hinzufügen“: an icon, a name and, where it helps, what it takes. */
function AddEntry({
  icon: Icon,
  label,
  hint,
  onPick,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  hint?: string;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onPick}
      className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition hover:bg-accent"
    >
      <Icon className="mt-0.5 size-4 shrink-0 text-ink-3" />
      <span className="min-w-0">
        <span className="block font-medium text-[0.8125rem]">{label}</span>
        {hint ? <span className="block text-[0.75rem] text-ink-3">{hint}</span> : null}
      </span>
    </button>
  );
}

/**
 * „Hinzufügen“: a page, a table, an upload, and what the plugins bring in. Kategorien keep their
 * entry at the end until they have a tab of their own.
 */
function AddMenu({
  adds,
  onPage,
  onTable,
  onUpload,
  onCategory,
  onPlugin,
}: {
  adds: KnowledgeAdd[];
  onPage: () => void;
  onTable: () => void;
  onUpload: () => void;
  onCategory: () => void;
  onPlugin: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) {
      return;
    }
    const outside = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const pick = (run: () => void) => () => {
    setOpen(false);
    run();
  };
  const line = <div className="mx-2 my-1.5 h-px bg-border-soft" />;
  return (
    <div className="relative" ref={ref}>
      <Button
        size="sm"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Plus className="size-4" /> {t("know.add")}
        <ChevronDown className="-mr-1 size-4" />
      </Button>
      {open ? (
        <div
          role="menu"
          className="absolute top-10 right-0 z-50 w-72 max-w-[calc(100vw-32px)] animate-rise rounded-xl bg-card p-1.5 shadow-overlay ring-1 ring-border-soft"
        >
          <AddEntry icon={FileText} label={t("know.addPage")} onPick={pick(onPage)} />
          <AddEntry icon={Table2} label={t("know.addTable")} onPick={pick(onTable)} />
          {line}
          <AddEntry
            icon={Upload}
            label={t("know.upload")}
            hint={t("know.uploadHint")}
            onPick={pick(onUpload)}
          />
          {adds.length ? (
            <>
              {line}
              {adds.map((a) => (
                <AddEntry
                  key={a.id}
                  icon={a.icon ?? Puzzle}
                  label={a.label}
                  hint={a.hint}
                  onPick={pick(() => onPlugin(a.id))}
                />
              ))}
            </>
          ) : null}
          {line}
          <AddEntry icon={Tag} label={t("know.addCategory")} onPick={pick(onCategory)} />
        </div>
      ) : null}
    </div>
  );
}

/** An empty Knowledge: below Goose, the ways in by hand, and a word on Kategorien. */
function EmptyWays({
  readOnly,
  busy,
  onUpload,
  onPage,
  onTable,
}: {
  readOnly: boolean;
  busy: boolean;
  onUpload: () => void;
  onPage: () => void;
  onTable: () => void;
}) {
  const way = (icon: LucideIcon, label: string, run: () => void, spin = false) => {
    const Icon = icon;
    return (
      <Button variant="secondary" size="sm" onClick={run} disabled={readOnly}>
        {spin ? <Spinner className="size-4" /> : <Icon className="size-4" />} {label}
      </Button>
    );
  };
  return (
    <div className="flex flex-col gap-4">
      {readOnly ? (
        <p className="px-1 text-[0.875rem] text-ink-3">{t("know.emptyReadOnly")}</p>
      ) : (
        <div className="flex flex-wrap items-center gap-2 px-1">
          <span className="mr-1 font-medium text-[0.6875rem] text-ink-4 uppercase tracking-[0.12em]">
            {t("know.byHand")}
          </span>
          {way(Upload, t("know.upload"), onUpload, busy)}
          {way(PenLine, t("know.addPage"), onPage)}
          {way(Table2, t("know.addTable"), onTable)}
        </div>
      )}
      <div className="flex gap-3 rounded-xl px-4 py-3.5 text-[0.875rem] text-ink-3 ring-1 ring-border-soft ring-dashed">
        <Tag className="mt-0.5 size-4 shrink-0 text-ink-4" />
        <p>
          <span className="font-medium text-ink-2">{t("know.categoriesLater")}</span>{" "}
          {t("know.categoriesLaterHint")}
        </p>
      </div>
    </div>
  );
}

/**
 * Knowledge's start page behind `knowledgeTree`: what it is in one sentence, one „Hinzufügen“,
 * the search, what a step can't do yet as a notice, and the items, newest first. Empty, Goose
 * stands above it (the part's introduction) and the ways by hand below. Files dropped anywhere
 * on it are uploaded.
 */
export function KnowledgeHome({
  spaceId,
  data,
  readOnly,
  onOpen,
  status,
  adds,
}: {
  spaceId: string;
  data: Knowledge;
  readOnly: boolean;
  onOpen: (key: string) => void;
  /** The plugins' sections' status lines (a source reading, say), above the items. */
  status?: ReactNode;
  /** What the plugins add to „Hinzufügen“. */
  adds: KnowledgeAdd[];
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const files = useFileActions(spaceId, readOnly);
  const picker = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [where, setWhere] = useState<Where>({});
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<KnowledgeSearch | null>(null);
  const [searching, setSearching] = useState(false);
  const [making, setMaking] = useState<"page" | "table" | "category" | null>(null);
  const taken = data.categories.filter((c) => !c.proposed && c.count > 0);
  const proposed = data.categories.filter((c) => c.proposed);
  const shown = data.items
    .filter((item) =>
      Object.entries(where).every(([name, w]) => {
        const category = data.categories.find((c) => c.name === name);
        const mine = item.categories.find((h) => h.categoryId === category?.id);
        return category && mine ? passes(category, mine.values, w) : false;
      }),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const upload = async (picked: File[]) => {
    await files.upload("document", picked);
    await qc.invalidateQueries({ queryKey: keys.knowledge(spaceId) });
  };
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
  const lacking = [
    data.embeddings ? "" : t("know.keywordsOnly"),
    data.checked ? "" : t("know.unchecked"),
  ].filter(Boolean);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: dropping files is a shortcut for „Hochladen“.
    <div
      onDragOver={(e) => {
        if (!readOnly && e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setOver(false);
        }
      }}
      onDrop={(e) => {
        if (readOnly) {
          return;
        }
        e.preventDefault();
        setOver(false);
        const picked = Array.from(e.dataTransfer.files);
        if (picked.length) {
          void upload(picked);
        }
      }}
      className={cn(
        "rounded-2xl transition",
        over && "bg-paper-2 ring-2 ring-focus ring-offset-8 ring-offset-paper",
      )}
    >
      <Section
        title={t("know.title")}
        hint={t("know.homeHint")}
        plain
        action={
          readOnly ? null : (
            <AddMenu
              adds={adds}
              onPage={() => setMaking("page")}
              onTable={() => setMaking("table")}
              onUpload={() => picker.current?.click()}
              onCategory={() => setMaking("category")}
              onPlugin={(id) => onOpen(`s:${id}`)}
            />
          )
        }
      >
        {data.items.length && lacking.length ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl bg-amber-tint px-4 py-2.5 text-[0.8125rem] text-ink-2">
            <p className="min-w-0 flex-1">{lacking.join(" ")}</p>
            <button
              type="button"
              onClick={() => navigate("/settings/models")}
              className="shrink-0 font-medium text-ink underline underline-offset-2"
            >
              {t("know.models")}
            </button>
          </div>
        ) : null}
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
              placeholder={t("know.searchAll")}
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
        {found ? (
          <Card className="flex flex-col p-1.5">
            <SearchHits found={found} onOpen={onOpen} />
          </Card>
        ) : data.items.length ? (
          <div className="flex flex-col gap-1.5">
            <p className="px-1 font-medium text-[0.6875rem] text-ink-4 uppercase tracking-[0.12em]">
              {t("know.recent")}
            </p>
            <Card className="flex flex-col p-1.5">
              {shown.length ? (
                shown.map((item) => (
                  <KnowledgeRow
                    key={item.key}
                    item={item}
                    categories={data.categories}
                    onOpen={onOpen}
                  />
                ))
              ) : (
                <p className="px-3 py-4 text-[0.875rem] text-ink-3">{t("know.searchNone")}</p>
              )}
            </Card>
          </div>
        ) : (
          <EmptyWays
            readOnly={readOnly}
            busy={files.busy}
            onUpload={() => picker.current?.click()}
            onPage={() => setMaking("page")}
            onTable={() => setMaking("table")}
          />
        )}
        {files.error ? <p className="text-[0.875rem] text-rose">{files.error}</p> : null}
      </Section>
      <input
        ref={picker}
        className="sr-only"
        type="file"
        accept={DOCUMENTS}
        multiple
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          const picked = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (picked.length) {
            void upload(picked);
          }
        }}
      />
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
    </div>
  );
}
