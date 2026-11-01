import type { KnowledgeItem, SpaceCategory } from "@engenty/wizards-shared/knowledge";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowUpToLine,
  ChevronRight,
  Folder,
  FolderInput,
  FolderPlus,
  LayoutGrid,
  type LucideIcon,
  MoreHorizontal,
  Pencil,
  PenLine,
  RefreshCw,
  Settings2,
  Trash2,
} from "lucide-react";
import { type DragEvent, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../../lib/api";
import { lang, t } from "../../lib/i18n";
import { keys } from "../../lib/keys";
import { askConfirm, Button, cn, Dialog, Input } from "../../ui";
import { useDismiss } from "../AppFrame";
import { useSettingsMenu } from "../settings-menu";
import { shownValue } from "./Categories";
import { useItemView } from "./item-view";
import { itemIcon } from "./Knowledge";

/**
 * Knowledge as a tree: a page holds sub-pages, tables and files (`parentId`), and a page without
 * text of its own is a folder. The tree in Wissen's menu, moving by drag and drop and by
 * „Verschieben nach …“, and the cards a folder shows its contents as.
 */

/** A page without text of its own shows as a folder. */
export const isFolder = (item: KnowledgeItem) => item.kind === "page" && item.blank;

export function treeIcon(item: KnowledgeItem): LucideIcon {
  return isFolder(item) ? (folderMarks.get(item.id) ?? Folder) : itemIcon(item);
}

/**
 * The marks of the folders sources fill, by the folder's id: the icon of the source's kind (a
 * globe for a website). Set by the page that knows the space's sources.
 */
export const folderMarks = new Map<string, LucideIcon>();

/** The source that fills a folder, by the folder's id. Set with `folderMarks`. */
export const folderSources = new Map<string, string>();

/** What a folder holds (null: the top), in its order. */
export function contentsOf(items: KnowledgeItem[], parentId: string | null): KnowledgeItem[] {
  return items
    .filter((i) => i.parentId === parentId)
    .sort((a, b) => a.position - b.position || a.title.localeCompare(b.title, lang));
}

/** The folders an item sits in, outermost first. */
export function ancestorsOf(items: KnowledgeItem[], item: KnowledgeItem): KnowledgeItem[] {
  const out: KnowledgeItem[] = [];
  const seen = new Set<string>();
  for (let at = item.parentId; at && !seen.has(at); ) {
    seen.add(at);
    const parent = items.find((i) => i.kind === "page" && i.id === at);
    if (!parent) {
      break;
    }
    out.unshift(parent);
    at = parent.parentId;
  }
  return out;
}

/** Whether `item` is `page` or sits somewhere inside it. */
function within(items: KnowledgeItem[], item: KnowledgeItem, page: KnowledgeItem): boolean {
  return item.key === page.key || ancestorsOf(items, item).some((a) => a.key === page.key);
}

/** Moves an item into a folder (null: the top), at a place among its contents or at the end. */
export function useMoveItem(spaceId: string | undefined) {
  const qc = useQueryClient();
  return async (key: string, parentId: string | null, index?: number) => {
    await api.post(`/api/studio/spaces/${spaceId}/knowledge/move`, { key, parentId, index });
    await qc.invalidateQueries({ queryKey: keys.knowledge(spaceId) });
  };
}

/** An item's first two category values: a yes shows as its category's name. */
export function chipsOf(item: KnowledgeItem, categories: SpaceCategory[]): string[] {
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

/**
 * What a card says under its title: how much a folder holds, a table's rows, where it stands.
 * Where it came from the folder or the tree says already.
 */
function cardLine(item: KnowledgeItem): string {
  return [
    item.kind === "page" && item.children
      ? item.children === 1
        ? t("know.item")
        : t("know.items", { n: item.children })
      : "",
    item.rows !== null ? (item.rows === 1 ? t("know.row") : t("know.rows", { n: item.rows })) : "",
    item.place ?? "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** A category value on a card or a row: small and only outlined, so the text stays first. */
export function Tag({ children }: { children: string }) {
  return (
    <span className="inline-flex h-[1.125rem] max-w-full items-center truncate rounded-[5px] px-1.5 text-[0.6875rem] text-ink-3 ring-1 ring-border-soft ring-inset">
      {children}
    </span>
  );
}

/**
 * Items as cards (the start of their text, how much they hold, two category values) or as a
 * list, as the person switched it (`ItemViewSwitch`).
 */
export function ItemCards({
  items,
  categories,
  onOpen,
}: {
  items: KnowledgeItem[];
  categories: SpaceCategory[];
  onOpen: (key: string) => void;
}) {
  const view = useItemView();
  if (view === "list") {
    return (
      <div className="flex flex-col rounded-xl bg-card p-1.5 shadow-soft ring-1 ring-border-soft">
        {items.map((item) => {
          const Icon = treeIcon(item);
          const chips = chipsOf(item, categories);
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => onOpen(item.key)}
              disabled={item.status === "pending"}
              className="flex min-w-0 items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition hover:bg-accent disabled:opacity-60"
            >
              <Icon className="size-4 shrink-0 text-ink-3" />
              <span className="min-w-0 flex-1 truncate text-[0.875rem]">{item.title}</span>
              <span className="flex shrink-0 gap-1 max-sm:hidden">
                {chips.map((c) => (
                  <Tag key={c}>{c}</Tag>
                ))}
              </span>
            </button>
          );
        })}
      </div>
    );
  }
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3">
      {items.map((item) => {
        const Icon = treeIcon(item);
        const line = cardLine(item);
        const chips = chipsOf(item, categories);
        return (
          <button
            key={item.key}
            type="button"
            onClick={() => onOpen(item.key)}
            disabled={item.status === "pending"}
            className="flex min-w-0 flex-col gap-1.5 rounded-xl bg-card px-3.5 py-3 text-left shadow-soft ring-1 ring-border-soft transition hover:ring-border disabled:opacity-60"
          >
            <span className="flex min-w-0 items-center gap-2">
              <Icon className="size-4 shrink-0 text-ink-3" />
              <span className="truncate font-medium text-[0.875rem]">{item.title}</span>
            </span>
            {item.excerpt ? (
              <span className="line-clamp-4 text-[0.8125rem] text-ink-2 leading-5">
                {item.excerpt}
              </span>
            ) : null}
            {line ? <span className="truncate text-[0.75rem] text-ink-4">{line}</span> : null}
            {chips.length ? (
              <span className="flex flex-wrap gap-1">
                {chips.map((c) => (
                  <Tag key={c}>{c}</Tag>
                ))}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/**
 * „Verschieben nach …“: the folders an item can go into, as a tree, and the top. A page's path
 * follows it; a table's and a file's stay.
 */
export function MoveDialog({
  item,
  items,
  onClose,
  onMove,
  title,
  note,
}: {
  item: KnowledgeItem | null;
  items: KnowledgeItem[];
  onClose: () => void;
  onMove: (key: string, parentId: string | null) => Promise<void>;
  /** In place of „… verschieben“ and its note: another way of putting something in a folder. */
  title?: string;
  note?: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: another item starts without the last one's error.
  useEffect(() => setError(null), [item?.key]);
  const go = async (parentId: string | null) => {
    if (!item) {
      return;
    }
    setBusy(true);
    try {
      await onMove(item.key, parentId);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const rows: { item: KnowledgeItem; depth: number }[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const page of contentsOf(items, parentId)) {
      if (page.kind !== "page" || (item && within(items, page, item))) {
        continue;
      }
      rows.push({ item: page, depth });
      walk(page.id, depth + 1);
    }
  };
  walk(null, 0);
  const row = (
    key: string,
    label: string,
    Icon: LucideIcon,
    depth: number,
    here: boolean,
    to: string | null,
  ) => (
    <button
      key={key}
      type="button"
      disabled={busy || here}
      onClick={() => void go(to)}
      style={{ paddingLeft: `${depth * 16 + 10}px` }}
      className="flex w-full items-center gap-2.5 rounded-lg py-2 pr-3 text-left text-[0.875rem] transition hover:bg-accent disabled:pointer-events-none disabled:text-ink-4"
    >
      <Icon className="size-4 shrink-0 text-ink-3" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {here ? <span className="text-[0.75rem]">{t("know.here")}</span> : null}
    </button>
  );
  return (
    <Dialog
      open={item !== null}
      onClose={onClose}
      title={item ? (title ?? t("know.moveTitle", { title: item.title })) : ""}
    >
      {item ? (
        <div className="flex flex-col gap-3">
          <p className="-mt-2 text-[0.8125rem] text-ink-3">
            {note ??
              (item.kind === "page"
                ? t("know.movePage")
                : t("know.moveKeeps", { path: item.path }))}
          </p>
          <div className="flex max-h-80 flex-col overflow-y-auto">
            {row("top", t("know.top"), ArrowUpToLine, 0, item.parentId === null, null)}
            {rows.map((r) =>
              row(
                r.item.key,
                r.item.title,
                treeIcon(r.item),
                r.depth + 1,
                item.parentId === r.item.id,
                r.item.id,
              ),
            )}
          </div>
          {error ? <p className="text-[0.8125rem] text-rose">{error}</p> : null}
        </div>
      ) : null}
    </Dialog>
  );
}

/**
 * A row's ⋯, by what the row is: a source's folder (its settings, read now, rename, move,
 * remove the source), an item of the space's own (rename, a folder inside, move, delete), or
 * an item a source wrote (take it over to write it, move). What can't be undone is red and asks
 * first.
 */
function RowMenu({
  item,
  spaceId,
  picked,
  onPick,
  onNewFolder,
  onMoveTo,
}: {
  item: KnowledgeItem;
  spaceId: string;
  picked: string | null;
  onPick: (key: string) => void;
  onNewFolder: (parentId: string) => void;
  onMoveTo: (item: KnowledgeItem) => void;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  // The menu stands over the page, at its button: the tree's scrolling would cut it off.
  const [at, setAt] = useState<{ top: number; right: number } | null>(null);
  useDismiss(menu, open, () => setOpen(false));
  const sourceId = folderSources.get(item.id) ?? null;
  const written = !sourceId && Boolean(item.origin) && !item.kept;
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: keys.knowledge(spaceId) });
    await qc.invalidateQueries({ queryKey: ["sources", spaceId] });
  };
  const run = (work: () => Promise<unknown>, gone = false) => {
    setOpen(false);
    setError(null);
    void work()
      .then(async () => {
        await refresh();
        if (gone && picked === item.key) {
          onPick("all");
        }
      })
      .catch((err: Error) => setError(err.message));
  };
  const remove = async () => {
    setOpen(false);
    if (sourceId) {
      if (
        await askConfirm(t("src.removeTitle", { label: item.title }), {
          detail: t("src.removeBody"),
          action: t("src.remove"),
        })
      ) {
        run(() => api.del(`/api/studio/spaces/${spaceId}/sources/${sourceId}`), true);
      }
      return;
    }
    if (
      await askConfirm(t("data.confirmDelete", { title: item.title }), {
        detail: item.kind === "page" && item.children ? t("know.deleteInside") : undefined,
      })
    ) {
      run(
        () =>
          item.kind === "page"
            ? api.del(`/api/studio/pages/${item.id}`)
            : item.kind === "table"
              ? api.del(`/api/studio/tables/${item.id}`)
              : api.del(`/api/studio/spaces/${spaceId}/files/${item.id}`),
        true,
      );
    }
  };
  const rename = (title: string) =>
    run(() =>
      item.kind === "page"
        ? api.patch(`/api/studio/pages/${item.id}`, { title })
        : item.kind === "table"
          ? api.patch(`/api/studio/tables/${item.id}`, { title })
          : api.patch(`/api/studio/spaces/${spaceId}/files/${item.id}`, { name: title }),
    );
  const entry =
    "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[0.8125rem] text-ink-2 transition hover:bg-accent hover:text-ink";
  const danger =
    "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[0.8125rem] text-rose transition hover:bg-rose-tint";
  const menuItem = (Icon: LucideIcon, label: string, act: () => void, cls = entry) => (
    <button key={label} type="button" role="menuitem" className={cls} onClick={act}>
      <Icon className="size-4 shrink-0" /> {label}
    </button>
  );
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label={t("know.more")}
        title={t("know.more")}
        aria-haspopup="menu"
        aria-expanded={open}
        // Its own press doesn't count as one outside the menu: it toggles.
        onPointerDown={(e) => e.nativeEvent.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          setAt({ top: r.bottom + 4, right: window.innerWidth - r.right });
          setOpen((o) => !o);
        }}
        className={cn(
          "grid size-6 place-items-center rounded-md text-ink-3 opacity-0 transition hover:bg-paper-3 hover:text-ink focus-visible:opacity-100 group-hover/row:opacity-100",
          (open || error) && "opacity-100",
          error && "text-rose",
        )}
      >
        <MoreHorizontal className="size-4" />
      </button>
      {open && at
        ? createPortal(
            <div
              ref={menu}
              role="menu"
              style={{ top: at.top, right: at.right }}
              className="fixed z-50 w-60 animate-rise rounded-xl bg-card p-1.5 shadow-overlay ring-1 ring-border-soft"
            >
              {error ? <p className="px-2.5 py-1.5 text-[0.75rem] text-rose">{error}</p> : null}
              {sourceId ? (
                <>
                  {menuItem(Settings2, t("src.menuSource"), () => {
                    setOpen(false);
                    onPick(`q:${sourceId}`);
                  })}
                  {menuItem(RefreshCw, t("src.refresh"), () =>
                    run(() => api.post(`/api/studio/spaces/${spaceId}/sources/${sourceId}/run`)),
                  )}
                </>
              ) : null}
              {written
                ? menuItem(PenLine, t("src.takeOver"), async () => {
                    setOpen(false);
                    if (
                      await askConfirm(t("src.takeOverTitle"), {
                        detail: t("src.takeOverDetail", { label: item.originLabel ?? "" }),
                        action: t("src.takeOver"),
                        danger: false,
                      })
                    ) {
                      run(() =>
                        api.post(`/api/studio/spaces/${spaceId}/knowledge/keep`, { key: item.key }),
                      );
                    }
                  })
                : menuItem(Pencil, t("know.rename"), () => {
                    setOpen(false);
                    setRenaming(true);
                  })}
              {item.kind === "page" && !written
                ? menuItem(FolderPlus, t("know.newFolderIn"), () => {
                    setOpen(false);
                    onNewFolder(item.id);
                  })
                : null}
              {menuItem(FolderInput, t("know.move"), () => {
                setOpen(false);
                onMoveTo(item);
              })}
              {written ? null : (
                <>
                  <div className="mx-2 my-1 h-px bg-border-soft" aria-hidden />
                  {menuItem(
                    Trash2,
                    sourceId ? t("src.remove") : t("common.delete"),
                    () => void remove(),
                    danger,
                  )}
                </>
              )}
            </div>,
            document.body,
          )
        : null}
      <RenameDialog
        open={renaming}
        title={item.title}
        onClose={() => setRenaming(false)}
        onSave={(title) => {
          setRenaming(false);
          if (title.trim() && title.trim() !== item.title) {
            rename(title.trim());
          }
        }}
      />
    </div>
  );
}

/** A new name for a row, in a small dialog. */
function RenameDialog({
  open,
  title,
  onClose,
  onSave,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  onSave: (title: string) => void;
}) {
  const [value, setValue] = useState(title);
  // biome-ignore lint/correctness/useExhaustiveDependencies: opened again, it starts from the name as it is.
  useEffect(() => setValue(title), [open]);
  return (
    <Dialog open={open} onClose={onClose} title={t("know.renameTitle", { title })}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          onSave(value);
        }}
      >
        <Input autoFocus value={value} onChange={(e) => setValue(e.target.value)} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("confirm.cancel")}
          </Button>
          <Button type="submit" disabled={!value.trim()}>
            {t("know.rename")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

type Zone = "before" | "after" | "into";

/** The drag in progress: what is dragged, and where it would land. */
interface Drag {
  key: string;
  over: string | null;
  zone: Zone;
}

const DRAG_TYPE = "application/x-engenty-knowledge";

/**
 * Wissen's menu as a tree: „Alles“, then the folders, pages, tables and files at the top, each
 * page opening to what it holds. Rows are dragged onto a page (into it) or between rows (beside
 * them); onto „Alles“, to the top. While the menu is searched, the matching items stand flat.
 */
export function KnowledgeTree({
  spaceId,
  items,
  picked,
  all,
  readOnly,
  onPick,
  onMove,
  onNewFolder,
  onMoveTo,
}: {
  spaceId: string;
  items: KnowledgeItem[];
  /** The item open beside the menu. */
  picked: string | null;
  /** „Alles“ is open: no item picked. */
  all: boolean;
  readOnly: boolean;
  onPick: (key: string) => void;
  onMove: (key: string, parentId: string | null, index?: number) => Promise<void>;
  onNewFolder: (parentId: string | null) => void;
  onMoveTo: (item: KnowledgeItem) => void;
}) {
  const { filter } = useSettingsMenu();
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [drag, setDrag] = useState<Drag | null>(null);
  // The folders around what is open stand open, and a page opened shows what it holds.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new pick, or its item arriving, opens its folders.
  useEffect(() => {
    const item = items.find((i) => i.key === picked);
    if (item) {
      const up = [
        ...ancestorsOf(items, item).map((a) => a.id),
        ...(item.kind === "page" ? [item.id] : []),
      ];
      if (up.some((id) => !open.has(id))) {
        setOpen((now) => new Set([...now, ...up]));
      }
    }
  }, [picked, items.length]);
  const toggle = (id: string) =>
    setOpen((now) => {
      const next = new Set(now);
      if (!next.delete(id)) {
        next.add(id);
      }
      return next;
    });
  const dragged = drag ? items.find((i) => i.key === drag.key) : undefined;

  const onDragOver = (e: DragEvent, item: KnowledgeItem | null) => {
    if (!drag || !dragged) {
      return;
    }
    // Never into itself or what it holds.
    if (item && dragged.kind === "page" && within(items, item, dragged)) {
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    let zone: Zone = "into";
    if (item) {
      const rect = e.currentTarget.getBoundingClientRect();
      const at = (e.clientY - rect.top) / rect.height;
      zone =
        item.kind === "page"
          ? at < 0.25
            ? "before"
            : at > 0.75
              ? "after"
              : "into"
          : at < 0.5
            ? "before"
            : "after";
    }
    const over = item?.key ?? null;
    if (drag.over !== over || drag.zone !== zone) {
      setDrag({ ...drag, over, zone });
    }
  };
  const onDrop = (e: DragEvent, item: KnowledgeItem | null) => {
    if (!drag || !dragged) {
      return;
    }
    e.preventDefault();
    const { zone } = drag;
    setDrag(null);
    if (!item) {
      void onMove(dragged.key, null);
      return;
    }
    if (zone === "into") {
      if (item.key !== dragged.key) {
        setOpen((now) => new Set([...now, item.id]));
        void onMove(dragged.key, item.id);
      }
      return;
    }
    const siblings = contentsOf(items, item.parentId).filter((i) => i.key !== dragged.key);
    const at = siblings.findIndex((i) => i.key === item.key);
    void onMove(dragged.key, item.parentId, at + (zone === "after" ? 1 : 0));
  };

  const row = (item: KnowledgeItem, depth: number) => {
    const Icon = treeIcon(item);
    const inside = item.kind === "page" ? contentsOf(items, item.id) : [];
    const isOpen = open.has(item.id);
    const selected = picked === item.key;
    const target = drag?.over === item.key ? drag.zone : null;
    return (
      <li key={item.key}>
        <div
          draggable={!readOnly && !filter}
          onDragStart={(e) => {
            e.dataTransfer.setData(DRAG_TYPE, item.key);
            e.dataTransfer.effectAllowed = "move";
            setDrag({ key: item.key, over: null, zone: "into" });
          }}
          onDragEnd={() => setDrag(null)}
          onDragOver={(e) => onDragOver(e, item)}
          onDrop={(e) => onDrop(e, item)}
          style={{ paddingLeft: `${depth * 12}px` }}
          className={cn(
            "group/row relative flex items-center rounded-lg transition",
            selected ? "bg-paper-2" : "hover:bg-accent",
            target === "into" && "bg-ember-tint ring-1 ring-ember/40",
            drag?.key === item.key && "opacity-50",
          )}
        >
          {target === "before" || target === "after" ? (
            <span
              aria-hidden
              className={cn(
                "pointer-events-none absolute right-1 left-1 h-0.5 rounded-full bg-ember",
                target === "before" ? "-top-px" : "-bottom-px",
              )}
            />
          ) : null}
          <button
            type="button"
            tabIndex={inside.length ? 0 : -1}
            aria-label={isOpen ? t("know.collapse") : t("know.expand")}
            aria-expanded={inside.length ? isOpen : undefined}
            onClick={() => inside.length && toggle(item.id)}
            className={cn(
              "grid size-6 shrink-0 place-items-center rounded-md text-ink-4",
              inside.length ? "hover:text-ink" : "invisible",
            )}
          >
            <ChevronRight className={cn("size-3.5 transition-transform", isOpen && "rotate-90")} />
          </button>
          <button
            type="button"
            onClick={() => onPick(item.key)}
            disabled={item.status === "pending"}
            aria-current={selected ? "page" : undefined}
            className={cn(
              "flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-1 text-left text-[0.875rem]",
              selected ? "font-medium text-ink" : "text-ink-2 group-hover/row:text-ink",
            )}
          >
            <Icon
              className={cn("size-4 shrink-0", selected ? "text-ember-strong" : "text-ink-3")}
            />
            <span className="min-w-0 flex-1 truncate">{item.title}</span>
            {isFolder(item) && item.children ? (
              <span className="text-[0.75rem] text-ink-4 tabular-nums group-hover/row:hidden">
                {item.children}
              </span>
            ) : null}
          </button>
          {readOnly ? null : (
            <span className="shrink-0 pr-1">
              <RowMenu
                item={item}
                spaceId={spaceId}
                picked={picked}
                onPick={onPick}
                onNewFolder={onNewFolder}
                onMoveTo={onMoveTo}
              />
            </span>
          )}
        </div>
        {inside.length && isOpen ? (
          <ul className="flex flex-col gap-0.5 pt-0.5">{inside.map((i) => row(i, depth + 1))}</ul>
        ) : null}
      </li>
    );
  };

  const found = filter ? items.filter((i) => i.title.toLowerCase().includes(filter)) : null;
  return (
    <div className="flex flex-col gap-0.5">
      <div
        onDragOver={(e) => onDragOver(e, null)}
        onDrop={(e) => onDrop(e, null)}
        className={cn(
          "rounded-lg",
          drag &&
            drag.over === null &&
            drag.zone === "into" &&
            "bg-ember-tint ring-1 ring-ember/40",
        )}
      >
        <button
          type="button"
          onClick={() => onPick("all")}
          aria-current={all ? "page" : undefined}
          className={cn(
            "flex w-full items-center gap-2 rounded-lg px-1 py-1.5 text-left text-[0.875rem] transition",
            all ? "bg-paper-2 font-medium text-ink" : "text-ink-2 hover:bg-accent hover:text-ink",
          )}
        >
          <span className="grid size-6 place-items-center">
            <LayoutGrid className={cn("size-4", all ? "text-ember-strong" : "text-ink-3")} />
          </span>
          {t("know.all")}
        </button>
      </div>
      <ul className="flex flex-col gap-0.5">
        {found ? found.map((i) => row({ ...i }, 0)) : contentsOf(items, null).map((i) => row(i, 0))}
      </ul>
      {found && !found.length ? (
        <p className="px-2 py-1 text-[0.8125rem] text-ink-3">{t("know.searchNone")}</p>
      ) : null}
    </div>
  );
}
