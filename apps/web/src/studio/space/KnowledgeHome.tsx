import type {
  Knowledge,
  KnowledgeItem,
  SpaceCategory,
  Where,
} from "@engenty/wizards-shared/knowledge";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  Files,
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
  X,
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
import { Mascot } from "../../brand";
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
  IconButton,
  Input,
  Label,
  Spinner,
  Textarea,
} from "../../ui";
import { useDismiss } from "../AppFrame";
import { useAssistant } from "../assistant/chat";
import { CATEGORY_ICON } from "./Categories";
import { useFileActions } from "./data";
import { ItemViewSwitch } from "./item-view";
import { FilterChip, NewItemForm, passes } from "./Knowledge";
import { PaletteField } from "./KnowledgePalette";
import {
  ancestorsOf,
  chipsOf,
  contentsOf,
  folderSources,
  ItemCards,
  isFolder,
  MoveDialog,
  treeIcon,
  useMoveItem,
  Tag as ValueTag,
} from "./KnowledgeTree";
import { Section } from "./Section";
import { SourceCards, type SourceKind, SourcePane } from "./sources";
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

/**
 * How many recently changed items the start page lists while nothing narrows them down: enough
 * to fill a tall window.
 */
const RECENT = 40;

/** An entry a plugin adds to „Hinzufügen“: it opens the plugin's section of Knowledge. */
export interface KnowledgeAdd {
  /** The section's id. */
  id: string;
  label: string;
  hint?: string;
  icon?: ComponentType<{ className?: string }>;
}

/** „gerade“, „vor 5m“, „vor 2h“, „gestern“, „Mo.“, „12. Okt.“: when an item last changed, short. */
export function when(iso: string): string {
  const then = new Date(iso);
  const minutes = (Date.now() - then.getTime()) / 60_000;
  if (minutes < 1) {
    return t("know.justNow");
  }
  if (minutes < 60) {
    return t("know.ago", { span: `${Math.round(minutes)}m` });
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.ceil((today.getTime() - then.getTime()) / 86_400_000);
  if (days <= 0) {
    return t("know.ago", { span: `${Math.round(minutes / 60)}h` });
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
  const path = ancestorsOf(items, item)
    .map((a) => a.title)
    .join(" › ");
  const where = [
    path,
    // A source's folder already names where it came from.
    item.originLabel && !path.startsWith(item.originLabel) ? item.originLabel : "",
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
          chipsOf(item, categories).map((c) => <ValueTag key={c}>{c}</ValueTag>)
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

/** What „Hinzufügen“ offers on its left; picked, its details fill the right. */
type AddWay = "start" | "page" | "table" | "folder" | "upload" | `kind:${string}`;

/**
 * „Hinzufügen“ as a dialog: the ways in on the left (made here, from this computer, sources),
 * the one picked on the right. Files or folders dropped anywhere on it are uploaded into the
 * folder it was opened in.
 */
function AddDialog({
  open,
  initial,
  spaceId,
  parentId,
  folderPath,
  upload,
  kinds = [],
  adds = [],
  onClose,
  onOpen,
  onWrite,
  onPlugin,
}: {
  open: boolean;
  initial: AddWay;
  spaceId: string;
  parentId: string | null;
  /** The folder's path (`pages/…`), for Goose to know where; none at the top. */
  folderPath?: string;
  upload: Uploads;
  kinds?: SourceKind[];
  adds?: KnowledgeAdd[];
  onClose: () => void;
  onOpen: (key: string) => void;
  /** A new page opens to be written. */
  onWrite: (key: string) => void;
  onPlugin?: (id: string) => void;
}) {
  const assistant = useAssistant();
  // Without Goose the first way is the upload: the start is a prompt for Goose and a drop zone.
  const first: AddWay = initial === "start" && !assistant ? "upload" : initial;
  const [way, setWay] = useState<AddWay>(first);
  useEffect(() => {
    if (open) {
      setWay(first);
    }
  }, [open, first]);
  // An upload started here closes the dialog once it is done; the page says what came in.
  const started = useRef(false);
  useEffect(() => {
    if (upload.busy) {
      started.current = true;
    } else if (started.current) {
      started.current = false;
      if (!upload.error) {
        onClose();
      }
    }
  }, [upload.busy, upload.error, onClose]);
  const kind = way.startsWith("kind:") ? kinds.find((k) => `kind:${k.kind}` === way) : undefined;
  // The sources fold away until wanted; one of them picked keeps them open.
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const showSources = sourcesOpen || Boolean(kind);
  const entry = (id: AddWay, Icon: ComponentType<{ className?: string }>, label: string) => (
    <button
      key={id}
      type="button"
      aria-current={way === id ? "true" : undefined}
      onClick={() => setWay(id)}
      className={cn(
        "flex h-8 w-full shrink-0 items-center gap-2 rounded-md px-2 text-left text-[0.8125rem] transition max-sm:w-auto",
        way === id ? "bg-card font-medium text-ink shadow-soft" : "text-ink-2 hover:bg-accent",
      )}
    >
      <Icon className="size-4 shrink-0 text-ink-3" />
      <span className="truncate">{label}</span>
    </button>
  );
  const group = (label: string) => (
    <p className="px-2 pt-3 pb-1 font-medium text-[0.6875rem] text-ink-4 uppercase tracking-[0.12em] first:pt-0 max-sm:hidden">
      {label}
    </p>
  );
  const title =
    way === "start"
      ? t("know.addAskTitle")
      : way === "page"
        ? t("know.addPage")
        : way === "table"
          ? t("know.addTable")
          : way === "folder"
            ? t("know.newFolder")
            : way === "upload"
              ? t("know.upload")
              : (kind?.label() ?? "");
  // Drops stop here: the page behind takes them too, and would upload them twice.
  const stop = (run: (e: React.DragEvent) => void) => (e: React.DragEvent) => {
    e.stopPropagation();
    run(e);
  };
  return (
    <Dialog open={open} onClose={onClose} bare wide="page">
      <div
        onDragOver={stop(upload.drop.onDragOver)}
        onDragLeave={stop(upload.drop.onDragLeave)}
        onDrop={stop((e) => {
          setWay("upload");
          upload.drop.onDrop(e);
        })}
        className="relative mx-auto flex h-[min(36rem,calc(100dvh-32px))] w-full overflow-hidden rounded-2xl bg-card shadow-overlay max-sm:h-dvh max-sm:flex-col max-sm:rounded-none"
      >
        <nav className="flex w-56 shrink-0 flex-col gap-0.5 overflow-y-auto border-border-soft border-r bg-paper-2/60 p-2 max-sm:w-full max-sm:flex-row max-sm:overflow-x-auto max-sm:border-r-0 max-sm:border-b">
          {assistant ? (
            // Goose as it looks everywhere: its own face, with room below before the rest.
            <button
              type="button"
              aria-current={way === "start" ? "true" : undefined}
              onClick={() => setWay("start")}
              className={cn(
                "mb-2 flex h-11 w-full shrink-0 items-center gap-2.5 rounded-lg px-2 text-left text-[0.875rem] transition max-sm:mb-0 max-sm:w-auto",
                way === "start"
                  ? "bg-card font-medium text-ink shadow-soft"
                  : "text-ink-2 hover:bg-accent",
              )}
            >
              <Mascot kind="round" size={26} helmet interactive={false} />
              <span className="truncate">{t("know.addStart")}</span>
            </button>
          ) : null}
          {group(t("know.addOwn"))}
          {entry("page", FileText, t("know.addPage"))}
          {entry("table", Table2, t("know.addTable"))}
          {entry("folder", FolderPlus, t("know.newFolder"))}
          {group(t("know.addFromComputer"))}
          {entry("upload", Upload, t("know.upload"))}
          {kinds.length || adds.length ? (
            <button
              type="button"
              aria-expanded={showSources}
              onClick={() => setSourcesOpen(!showSources)}
              className="flex w-full items-center gap-1 px-2 pt-3 pb-1 text-left font-medium text-[0.6875rem] text-ink-4 uppercase tracking-[0.12em] hover:text-ink-2 max-sm:w-auto max-sm:pt-0"
            >
              <span className="flex-1">{t("know.sources")}</span>
              <ChevronDown
                className={cn("size-3.5 transition-transform", showSources ? null : "-rotate-90")}
              />
            </button>
          ) : null}
          {showSources ? kinds.map((k) => entry(`kind:${k.kind}`, k.icon, k.label())) : null}
          {showSources && onPlugin
            ? adds.map((a) => {
                const Icon = a.icon ?? Puzzle;
                return (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => {
                      onClose();
                      onPlugin(a.id);
                    }}
                    className="flex h-8 w-full shrink-0 items-center gap-2 rounded-md px-2 text-left text-[0.8125rem] text-ink-2 transition hover:bg-accent max-sm:w-auto"
                  >
                    <Icon className="size-4 shrink-0 text-ink-3" />
                    <span className="truncate">{a.label}</span>
                  </button>
                );
              })
            : null}
        </nav>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-start justify-between gap-3 px-6 pt-5 pb-1">
            <h2 className="min-w-0 font-display font-semibold text-lg">{title}</h2>
            <IconButton label={t("common.close")} onClick={onClose} className="-mt-1 -mr-2 size-8">
              <X className="size-4" />
            </IconButton>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-3 pb-6">
            {way === "start" && assistant ? (
              <StartPane
                upload={upload}
                onAsk={(text) => {
                  assistant.setOpen(true);
                  void assistant.send(
                    folderPath ? `${text}\n\n${t("know.gooseWhere", { path: folderPath })}` : text,
                  );
                  onClose();
                }}
              />
            ) : way === "page" || way === "table" || way === "folder" ? (
              <NewItemForm
                key={way}
                kind={way}
                spaceId={spaceId}
                parentId={parentId}
                drop={false}
                onClose={onClose}
                onMade={(key) => {
                  onClose();
                  way === "page" ? onWrite(key) : onOpen(key);
                }}
              />
            ) : way === "upload" ? (
              <UploadPane upload={upload} />
            ) : kind ? (
              <SourcePane
                key={kind.kind}
                spaceId={spaceId}
                kind={kind}
                parentId={parentId}
                onTaken={(taken) => {
                  onClose();
                  if (taken.folderId) {
                    onOpen(`p:${taken.folderId}`);
                  }
                }}
              />
            ) : null}
          </div>
        </div>
        {upload.over ? (
          <div className="pointer-events-none absolute inset-2 grid place-items-center rounded-xl bg-paper/80 text-[0.875rem] text-ink ring-2 ring-focus ring-dashed">
            <span className="inline-flex items-center gap-2">
              <Upload className="size-4" /> {t("know.dropHere")}
            </span>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

/** „Hinzufügen“'s start: say what should come in, and Goose does it; or drop files. */
function StartPane({ upload, onAsk }: { upload: Uploads; onAsk: (text: string) => void }) {
  const [text, setText] = useState("");
  const ask = () => text.trim() && onAsk(text.trim());
  return (
    <div className="flex flex-col gap-5">
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          ask();
        }}
      >
        <Textarea
          data-autofocus
          value={text}
          minRows={4}
          maxRows={10}
          placeholder={t("know.addAskPlaceholder")}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // ⌘/Ctrl + Enter sends; Enter alone makes a new line.
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              ask();
            }
          }}
        />
        <div className="flex flex-wrap items-center gap-1.5">
          {(["know.addExample1", "know.addExample2", "know.addExample3"] as const).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setText(t(key))}
              className="h-7 rounded-full bg-paper-2 px-2.5 text-[0.75rem] text-ink-2 transition hover:bg-accent hover:text-ink"
            >
              {t(key)}
            </button>
          ))}
          <span className="flex-1" />
          <Button type="submit" size="sm" disabled={!text.trim()}>
            {t("know.askGoose")}
          </Button>
        </div>
      </form>
      <UploadBox upload={upload} />
      {upload.error ? <p className="text-[0.8125rem] text-rose">{upload.error}</p> : null}
    </div>
  );
}

/** Uploading: files or a whole folder, picked or dropped. A folder keeps its sub folders. */
function UploadPane({ upload }: { upload: Uploads }) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[0.8125rem] text-ink-3">{t("know.uploadPaneHint")}</p>
      <UploadBox upload={upload} />
      {upload.error ? <p className="text-[0.8125rem] text-rose">{upload.error}</p> : null}
    </div>
  );
}

/** The drop zone with its two pickers: files, or a folder with what is in it. */
function UploadBox({ upload }: { upload: Uploads }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl px-4 py-10 text-center ring-1 ring-border ring-dashed">
      {upload.busy ? (
        <Spinner className="size-5 text-ink-3" />
      ) : (
        <Upload className="size-5 text-ink-3" />
      )}
      <p className="text-[0.875rem] text-ink-2">{upload.note ?? t("know.dropHere")}</p>
      <div className="flex flex-wrap justify-center gap-2">
        <Button size="sm" variant="secondary" onClick={upload.pick} disabled={upload.busy}>
          <Files className="size-4" /> {t("know.pickFiles")}
        </Button>
        <Button size="sm" variant="secondary" onClick={upload.pickFolder} disabled={upload.busy}>
          <FolderUp className="size-4" /> {t("know.pickFolder")}
        </Button>
      </div>
    </div>
  );
}

type Uploads = ReturnType<typeof useUpload>;

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

/** The small label above a set of items, with the switch between cards and the list. */
function ItemsLabel({ label, switcher = true }: { label: string; switcher?: boolean }) {
  return (
    <div className="flex h-7 items-center justify-between">
      <p className={labelClass}>{label}</p>
      {switcher ? <ItemViewSwitch /> : null}
    </div>
  );
}

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
  /** The kinds of sources in „Hinzufügen“. */
  kinds: SourceKind[];
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const upload = useUpload(spaceId, null, readOnly, onOpen);
  const [where, setWhere] = useState<Where>({});
  const [making, setMaking] = useState<AddWay | null>(null);
  const taken = data.categories.filter((c) => !c.proposed && c.count > 0);
  const proposed = data.categories.filter((c) => c.proposed);
  const filtered = Object.keys(where).length > 0;
  // At the top: the sources' folders apart, then the folders and pages of the space's own.
  const top = contentsOf(data.items, null);
  const sourceFolders = top.filter((i) => folderSources.has(i.id));
  const ownTop = top.filter((i) => !folderSources.has(i.id));
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
        page
        title={t("know.title")}
        hint={t("know.homeHint")}
        plain
        action={
          readOnly ? null : (
            <Button size="sm" onClick={() => setMaking("start")}>
              <Plus className="size-4" /> {t("know.add")}
            </Button>
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
            {sourceFolders.length && !filtered ? (
              <div className="flex flex-col gap-2">
                <ItemsLabel label={t("know.sources")} />
                <SourceCards
                  spaceId={spaceId}
                  folderIds={sourceFolders.map((f) => f.id)}
                  onOpen={onOpen}
                />
              </div>
            ) : null}
            {ownTop.length && !filtered ? (
              <div className="flex flex-col gap-2">
                <ItemsLabel label={t("know.ownTop")} switcher={!sourceFolders.length} />
                <ItemCards items={ownTop} categories={data.categories} onOpen={onOpen} />
              </div>
            ) : null}
            <div className="flex flex-col gap-2">
              <ItemsLabel label={t("know.recent")} switcher={false} />
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
      <AddDialog
        open={making !== null}
        initial={making ?? "start"}
        spaceId={spaceId}
        parentId={null}
        upload={upload}
        kinds={kinds}
        adds={adds}
        onClose={() => setMaking(null)}
        onOpen={onOpen}
        onWrite={onWrite}
        onPlugin={(id) => onOpen(`s:${id}`)}
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
  const [making, setMaking] = useState<AddWay | null>(null);
  const [moving, setMoving] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(folder.title);
  const [deleting, setDeleting] = useState(false);
  useEffect(() => setTitle(folder.title), [folder.title]);
  const refresh = () => qc.invalidateQueries({ queryKey: keys.knowledge(spaceId) });
  const rename = useMutation({
    mutationFn: (to: string) => api.patch(`/api/studio/pages/${folder.id}`, { title: to }),
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
        page
        title={folder.title}
        onTitle={readOnly ? undefined : (to) => rename.mutate(to)}
        hint={
          source ? (
            // The source's own page: how often it reads, what it took, its log.
            <button
              type="button"
              onClick={() => onOpen(`q:${source.id}`)}
              title={t("src.menuSource")}
              className="text-left underline-offset-2 transition hover:text-ink hover:underline"
            >
              {[t("src.source"), source.address].join(" · ")}
            </button>
          ) : folder.originLabel ? (
            t("know.from", { label: folder.originLabel })
          ) : undefined
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
                  <Button size="sm" onClick={() => setMaking("start")}>
                    <Plus className="size-4" /> {t("know.add")}
                  </Button>
                </>
              )}
              <ItemViewSwitch />
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
      <AddDialog
        open={making !== null}
        initial={making ?? "start"}
        spaceId={spaceId}
        parentId={folder.id}
        folderPath={folder.path}
        upload={upload}
        kinds={kinds}
        onClose={() => setMaking(null)}
        onOpen={onOpen}
        onWrite={onWrite}
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
              rename.mutate(title.trim());
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
      <ItemsLabel label={t("know.inPage")} />
      <ItemCards items={inside} categories={data.categories} onOpen={onOpen} />
    </div>
  );
}
