import type {
  Knowledge,
  KnowledgeItem,
  SpaceCategory,
  Where,
} from "@engenty/wizards-shared/knowledge";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  FileText,
  FolderInput,
  FolderPlus,
  FolderUp,
  type LucideIcon,
  MoreHorizontal,
  Pencil,
  PenLine,
  Plus,
  Puzzle,
  Settings2,
  Table2,
  Tag,
  Trash2,
  Upload,
} from "lucide-react";
import {
  type ComponentType,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router";
import { api } from "../../lib/api";
import { lang, t } from "../../lib/i18n";
import { keys } from "../../lib/keys";
import { Button, Card, Chip, cn, Dialog, Empty, IconButton, Input, Label, Spinner } from "../../ui";
import { useDismiss } from "../AppFrame";
import { CATEGORY_ICON } from "./Categories";
import { useFileActions } from "./data";
import { FilterChip, NewItemDialog, passes } from "./Knowledge";
import { PaletteField } from "./KnowledgePalette";
import {
  ancestorsOf,
  chipsOf,
  contentsOf,
  ItemCards,
  isFolder,
  MoveDialog,
  treeIcon,
  useMoveItem,
} from "./KnowledgeTree";
import { Section } from "./Section";
import type { SourceKind } from "./sources";
import {
  dropHoldsFolder,
  type TreeFile,
  type TreeResult,
  treeOfDrop,
  treeOfInput,
  uploadTree,
} from "./upload-tree";

/** What uploads take: documents that become pages and tables, and pictures. */
const DOCUMENTS = ".pdf,.docx,.doc,.xlsx,.csv,.tsv,.txt,.md,.json,.html,.eml,image/*";

/** How many recently changed items the start page lists while nothing narrows them down. */
const RECENT = 12;

/** An entry a plugin adds to „Hinzufügen“: it opens the plugin's section of Knowledge. */
export interface KnowledgeAdd {
  /** The section's id. */
  id: string;
  label: string;
  hint?: string;
  icon?: ComponentType<{ className?: string }>;
}

/** „gerade“, „vor 2 Std.“, „gestern“, „Mo.“, „12. Okt.“: when an item last changed, short. */
export function when(iso: string): string {
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

/**
 * An item as a quiet row: what it is, its title, where it sits and came from, two chips, when it
 * changed.
 */
function KnowledgeRow({
  item,
  items,
  categories,
  onOpen,
}: {
  item: KnowledgeItem;
  items: KnowledgeItem[];
  categories: SpaceCategory[];
  onOpen: (key: string) => void;
}) {
  const Icon = treeIcon(item);
  const where = [
    ancestorsOf(items, item)
      .map((a) => a.title)
      .join(" › "),
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
 * „Hinzufügen“: a page, a table, a folder, an upload, and what the plugins bring in. Kategorien
 * are made in their tab.
 */
function AddMenu({
  adds = [],
  kinds = [],
  onMake,
  onUpload,
  onUploadFolder,
  onPlugin,
  onKind,
}: {
  adds?: KnowledgeAdd[];
  /** The kinds of sources the plugins bring: each opens its dialog. */
  kinds?: SourceKind[];
  onMake: (kind: "page" | "table" | "folder") => void;
  onUpload: () => void;
  onUploadFolder: () => void;
  onPlugin?: (id: string) => void;
  onKind?: (kind: SourceKind) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));
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
          <AddEntry icon={FileText} label={t("know.addPage")} onPick={pick(() => onMake("page"))} />
          <AddEntry icon={Table2} label={t("know.addTable")} onPick={pick(() => onMake("table"))} />
          <AddEntry
            icon={FolderPlus}
            label={t("know.newFolder")}
            onPick={pick(() => onMake("folder"))}
          />
          {line}
          <AddEntry
            icon={Upload}
            label={t("know.upload")}
            hint={t("know.uploadHint")}
            onPick={pick(onUpload)}
          />
          <AddEntry
            icon={FolderUp}
            label={t("know.uploadFolder")}
            hint={t("know.uploadFolderHint")}
            onPick={pick(onUploadFolder)}
          />
          {kinds.length && onKind ? (
            <>
              {line}
              {kinds.map((k) => (
                <AddEntry
                  key={k.kind}
                  icon={k.icon}
                  label={k.label()}
                  hint={k.hint?.()}
                  onPick={pick(() => onKind(k))}
                />
              ))}
            </>
          ) : null}
          {adds.length && onPlugin ? (
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
        </div>
      ) : null}
    </div>
  );
}

/**
 * Uploads into a folder of Knowledge (the top for null): a hidden picker to open, and files
 * dropped anywhere on `area`.
 */
function useUpload(
  spaceId: string,
  parentId: string | null,
  readOnly: boolean,
  onFolder?: (key: string) => void,
) {
  const qc = useQueryClient();
  const files = useFileActions(spaceId, readOnly);
  const picker = useRef<HTMLInputElement>(null);
  const folderPicker = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  // A folder's upload: how far it got, then what it did.
  const [tree, setTree] = useState<{ done: number; of: number } | null>(null);
  const [treeDone, setTreeDone] = useState<TreeResult | null>(null);
  const [treeError, setTreeError] = useState<string | null>(null);
  const upload = async (picked: File[]) => {
    await files.upload("document", picked, parentId);
    await qc.invalidateQueries({ queryKey: keys.knowledge(spaceId) });
  };
  const uploadFolder = async (picked: TreeFile[]) => {
    setTreeDone(null);
    setTreeError(null);
    setTree({ done: 0, of: 0 });
    try {
      const result = await uploadTree(
        spaceId,
        parentId,
        picked,
        (file, into) => files.upload("document", [file], into),
        (done, of) => setTree({ done, of }),
      );
      setTreeDone(result);
      await qc.invalidateQueries({ queryKey: keys.knowledge(spaceId) });
      if (result.top) {
        onFolder?.(`p:${result.top}`);
      }
    } catch (err) {
      setTreeError((err as Error).message);
    } finally {
      setTree(null);
    }
  };
  return {
    busy: files.busy || Boolean(tree),
    error: files.error ?? treeError,
    over,
    /** What a folder's upload says: how far it got, or what it did. */
    note: tree
      ? t("know.uploadingFolder", { done: tree.done, n: tree.of })
      : treeDone
        ? t(treeDone.skipped ? "know.uploadedFolderSkipped" : "know.uploadedFolder", {
            folders: treeDone.folders,
            files: treeDone.files,
            skipped: treeDone.skipped,
          })
        : null,
    pick: () => picker.current?.click(),
    pickFolder: () => folderPicker.current?.click(),
    drop: {
      onDragOver: (e: React.DragEvent) => {
        if (!readOnly && e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setOver(true);
        }
      },
      onDragLeave: (e: React.DragEvent) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setOver(false);
        }
      },
      onDrop: (e: React.DragEvent) => {
        if (readOnly || !e.dataTransfer.types.includes("Files")) {
          return;
        }
        e.preventDefault();
        setOver(false);
        // A folder dropped comes in with its folders.
        if (dropHoldsFolder(e.dataTransfer)) {
          void treeOfDrop(e.dataTransfer).then(uploadFolder);
          return;
        }
        const picked = Array.from(e.dataTransfer.files);
        if (picked.length) {
          void upload(picked);
        }
      },
    },
    input: (
      <>
        <input
          ref={picker as RefObject<HTMLInputElement>}
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
        <input
          ref={folderPicker as RefObject<HTMLInputElement>}
          className="sr-only"
          type="file"
          // A folder with what is in it: the browser asks for one.
          {...{ webkitdirectory: "", directory: "" }}
          multiple
          tabIndex={-1}
          aria-hidden
          onChange={(e) => {
            const picked = Array.from(e.target.files ?? []);
            e.target.value = "";
            if (picked.length) {
              void uploadFolder(treeOfInput(picked));
            }
          }}
        />
      </>
    ),
  };
}

const overClass = "bg-paper-2 ring-2 ring-focus ring-offset-8 ring-offset-paper";

/** An empty Knowledge: below Goose, the ways in by hand, and a word on Kategorien. */
function EmptyWays({
  readOnly,
  busy,
  onUpload,
  onMake,
}: {
  readOnly: boolean;
  busy: boolean;
  onUpload: () => void;
  onMake: (kind: "page" | "table") => void;
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
          {way(PenLine, t("know.addPage"), () => onMake("page"))}
          {way(Table2, t("know.addTable"), () => onMake("table"))}
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

const labelClass = "px-1 font-medium text-[0.6875rem] text-ink-4 uppercase tracking-[0.12em]";

/**
 * Knowledge's start page behind `knowledgeTree`: what it is in one sentence, one „Hinzufügen“,
 * the search, what a step can't do yet as a notice, the folders at the top as cards and what
 * changed lately. Empty, Goose stands above it (the part's introduction) and the ways by hand
 * below. Files dropped anywhere on it are uploaded.
 */
export function KnowledgeHome({
  spaceId,
  data,
  readOnly,
  onOpen,
  onWrite,
  status,
  adds,
  kinds,
  onKind,
}: {
  spaceId: string;
  data: Knowledge;
  readOnly: boolean;
  onOpen: (key: string) => void;
  /** A new page, opened to write: blank, it would show as a folder. */
  onWrite: (key: string) => void;
  /** What the sources and the plugins' sections are busy with, above the items. */
  status?: ReactNode;
  /** What the plugins add to „Hinzufügen“. */
  adds: KnowledgeAdd[];
  /** The kinds of sources in „Hinzufügen“, and what picking one does. */
  kinds: SourceKind[];
  onKind: (kind: SourceKind, parentId: string | null) => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const upload = useUpload(spaceId, null, readOnly, onOpen);
  const [where, setWhere] = useState<Where>({});
  const [making, setMaking] = useState<"page" | "table" | "folder" | null>(null);
  const taken = data.categories.filter((c) => !c.proposed && c.count > 0);
  const proposed = data.categories.filter((c) => c.proposed);
  const filtered = Object.keys(where).length > 0;
  const folders = contentsOf(data.items, null).filter(isFolder);
  const shown = data.items
    .filter(
      (item) =>
        !isFolder(item) &&
        Object.entries(where).every(([name, w]) => {
          const category = data.categories.find((c) => c.name === name);
          const mine = item.categories.find((h) => h.categoryId === category?.id);
          return category && mine ? passes(category, mine.values, w) : false;
        }),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, filtered ? undefined : RECENT);
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
    <div {...upload.drop} className={cn("rounded-2xl transition", upload.over && overClass)}>
      <Section
        title={t("know.title")}
        hint={t("know.homeHint")}
        plain
        action={
          readOnly ? null : (
            <AddMenu
              adds={adds}
              kinds={kinds}
              onMake={setMaking}
              onUpload={upload.pick}
              onUploadFolder={upload.pickFolder}
              onPlugin={(id) => onOpen(`s:${id}`)}
              onKind={(kind) => onKind(kind, null)}
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
            <PaletteField />
            {taken.length ? (
              <div className="flex flex-wrap items-center gap-1.5">
                {taken.map((c) => (
                  <FilterChip
                    key={c.id}
                    category={c}
                    value={where[c.name]}
                    onChange={(next) => {
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
                {filtered ? (
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
        {data.items.length ? (
          <>
            {folders.length && !filtered ? (
              <div className="flex flex-col gap-1.5">
                <p className={labelClass}>{t("know.folders")}</p>
                <ItemCards items={folders} categories={data.categories} onOpen={onOpen} />
              </div>
            ) : null}
            <div className="flex flex-col gap-1.5">
              <p className={labelClass}>{t("know.recent")}</p>
              <Card className="flex flex-col p-1.5">
                {shown.length ? (
                  shown.map((item) => (
                    <KnowledgeRow
                      key={item.key}
                      item={item}
                      items={data.items}
                      categories={data.categories}
                      onOpen={onOpen}
                    />
                  ))
                ) : (
                  <p className="px-3 py-4 text-[0.875rem] text-ink-3">{t("know.searchNone")}</p>
                )}
              </Card>
            </div>
          </>
        ) : (
          <EmptyWays
            readOnly={readOnly}
            busy={upload.busy}
            onUpload={upload.pick}
            onMake={setMaking}
          />
        )}
        {upload.note ? <p className="text-[0.875rem] text-ink-3">{upload.note}</p> : null}
        {upload.error ? <p className="text-[0.875rem] text-rose">{upload.error}</p> : null}
      </Section>
      {upload.input}
      <NewItemDialog
        kind={making === "page" || making === "table" || making === "folder" ? making : null}
        spaceId={spaceId}
        onClose={() => setMaking(null)}
        onMade={(key) => {
          const kind = making;
          setMaking(null);
          if (kind === "page") {
            onWrite(key);
          } else {
            onOpen(key);
          }
        }}
      />
    </div>
  );
}

/** A folder's ⋯: renaming it, moving it, deleting it. */
function FolderMenu({
  onRename,
  onMove,
  onDelete,
  onSource,
}: {
  onRename: () => void;
  onMove: () => void;
  onDelete: () => void;
  /** A source's folder: its settings. */
  onSource?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));
  const entry =
    "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[0.8125rem] text-ink-2 transition hover:bg-accent hover:text-ink";
  const pick = (run: () => void) => () => {
    setOpen(false);
    run();
  };
  return (
    <div ref={ref} className="relative">
      <IconButton
        label={t("know.more")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="size-8"
      >
        <MoreHorizontal className="size-4" />
      </IconButton>
      {open ? (
        <div
          role="menu"
          className="absolute top-full right-0 z-50 mt-1 w-56 animate-rise rounded-xl bg-card p-1.5 shadow-overlay ring-1 ring-border-soft"
        >
          {onSource ? (
            <button type="button" role="menuitem" className={entry} onClick={pick(onSource)}>
              <Settings2 className="size-4 shrink-0" /> {t("src.menuSource")}
            </button>
          ) : null}
          <button type="button" role="menuitem" className={entry} onClick={pick(onRename)}>
            <Pencil className="size-4 shrink-0" /> {t("know.rename")}
          </button>
          <button type="button" role="menuitem" className={entry} onClick={pick(onMove)}>
            <FolderInput className="size-4 shrink-0" /> {t("know.move")}
          </button>
          <div className="mx-2 my-1.5 h-px bg-border-soft" />
          <button
            type="button"
            role="menuitem"
            className={cn(entry, "text-rose hover:bg-rose-tint hover:text-rose")}
            onClick={pick(onDelete)}
          >
            <Trash2 className="size-4 shrink-0" /> {t("know.deleteFolder")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * A folder opened: a page without text of its own, its contents as cards. „Hinzufügen“ puts what
 * it makes into the folder, files dropped on it go in, „Text schreiben“ opens the page to write.
 */
export function KnowledgeFolder({
  spaceId,
  data,
  folder,
  readOnly,
  onOpen,
  onWrite,
  onGone,
  kinds,
  onKind,
  source,
  status,
}: {
  spaceId: string;
  data: Knowledge;
  folder: KnowledgeItem;
  readOnly: boolean;
  onOpen: (key: string) => void;
  onWrite: (key: string) => void;
  onGone: () => void;
  kinds: SourceKind[];
  onKind: (kind: SourceKind, parentId: string | null) => void;
  /** The source whose folder this is. */
  source?: { id: string; label: string; address: string };
  /** What the source is busy with, above its contents. */
  status?: ReactNode;
}) {
  const qc = useQueryClient();
  // A folder a source fills is the source's: nothing is added to it or written into it by hand.
  const sourced = Boolean(folder.origin?.startsWith("source:")) && !folder.kept;
  const upload = useUpload(spaceId, folder.id, readOnly || sourced, onOpen);
  const move = useMoveItem(spaceId);
  const [making, setMaking] = useState<"page" | "table" | "folder" | null>(null);
  const [moving, setMoving] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(folder.title);
  const [deleting, setDeleting] = useState(false);
  useEffect(() => setTitle(folder.title), [folder.title]);
  const refresh = () => qc.invalidateQueries({ queryKey: keys.knowledge(spaceId) });
  const rename = useMutation({
    mutationFn: () => api.patch(`/api/studio/pages/${folder.id}`, { title: title.trim() }),
    onSuccess: async () => {
      await refresh();
      setRenaming(false);
    },
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/api/studio/pages/${folder.id}`),
    onSuccess: async () => {
      await refresh();
      setDeleting(false);
      onGone();
    },
  });
  const contents = contentsOf(data.items, folder.id);
  return (
    <div {...upload.drop} className={cn("rounded-2xl transition", upload.over && overClass)}>
      <Section
        title={folder.title}
        hint={
          source
            ? [t("src.source"), source.address].join(" · ")
            : folder.originLabel
              ? t("know.from", { label: folder.originLabel })
              : undefined
        }
        plain
        action={
          readOnly ? null : (
            <div className="flex items-center gap-2">
              {sourced ? null : (
                <>
                  <Button variant="ghost" size="sm" onClick={() => onWrite(folder.key)}>
                    <PenLine className="size-4" /> {t("know.writeText")}
                  </Button>
                  <AddMenu
                    kinds={kinds}
                    onMake={setMaking}
                    onUpload={upload.pick}
                    onUploadFolder={upload.pickFolder}
                    onKind={(kind) => onKind(kind, folder.id)}
                  />
                </>
              )}
              <FolderMenu
                onRename={() => setRenaming(true)}
                onMove={() => setMoving(true)}
                onDelete={() => setDeleting(true)}
                onSource={source ? () => onOpen(`q:${source.id}`) : undefined}
              />
            </div>
          )
        }
      >
        {status}
        {contents.length ? (
          <ItemCards items={contents} categories={data.categories} onOpen={onOpen} />
        ) : (
          <Empty>{readOnly ? t("know.emptyReadOnly") : t("know.folderEmpty")}</Empty>
        )}
        {upload.busy ? <Spinner className="size-4 text-ink-3" /> : null}
        {upload.note ? <p className="text-[0.875rem] text-ink-3">{upload.note}</p> : null}
        {upload.error ? <p className="text-[0.875rem] text-rose">{upload.error}</p> : null}
      </Section>
      {upload.input}
      <NewItemDialog
        kind={making}
        spaceId={spaceId}
        parentId={folder.id}
        onClose={() => setMaking(null)}
        onMade={(key) => {
          const kind = making;
          setMaking(null);
          if (kind === "page") {
            onWrite(key);
          } else {
            onOpen(key);
          }
        }}
      />
      <MoveDialog
        item={moving ? folder : null}
        items={data.items}
        onClose={() => setMoving(false)}
        onMove={move}
      />
      <Dialog open={renaming} onClose={() => setRenaming(false)} title={t("know.rename")}>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (title.trim()) {
              rename.mutate();
            }
          }}
        >
          <div>
            <Label>{t("data.title")}</Label>
            <Input
              data-autofocus
              value={title}
              maxLength={200}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          {rename.error ? (
            <p className="text-[0.875rem] text-rose">{(rename.error as Error).message}</p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setRenaming(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" busy={rename.isPending} disabled={!title.trim()}>
              {t("settings.save")}
            </Button>
          </div>
        </form>
      </Dialog>
      <Dialog
        open={deleting}
        onClose={() => setDeleting(false)}
        title={t("know.deleteFolderTitle", { title: folder.title })}
      >
        <p className="-mt-2 text-[0.875rem] text-ink-2">{t("know.deleteFolderBody")}</p>
        {remove.error ? (
          <p className="mt-3 text-[0.8125rem] text-rose">{(remove.error as Error).message}</p>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setDeleting(false)}>
            {t("common.cancel")}
          </Button>
          <Button variant="danger" busy={remove.isPending} onClick={() => remove.mutate()}>
            <Trash2 className="size-4" /> {t("know.deleteFolder")}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

/** Below a page with text: the tables and files that sit in it, as cards. */
export function PageContents({
  data,
  page,
  onOpen,
}: {
  data: Knowledge;
  page: KnowledgeItem;
  onOpen: (key: string) => void;
}) {
  const inside = contentsOf(data.items, page.id).filter((i) => i.kind !== "page");
  if (!inside.length) {
    return null;
  }
  return (
    <div className="flex flex-col gap-1.5">
      <p className={labelClass}>{t("know.inPage")}</p>
      <ItemCards items={inside} categories={data.categories} onOpen={onOpen} />
    </div>
  );
}
