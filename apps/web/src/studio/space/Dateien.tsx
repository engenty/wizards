import type { KnowledgeItem, SpaceCategory } from "@engenty/wizards-shared/knowledge";
import { formatBytes } from "@engenty/wizards-shared/numbers";
import { useQuery } from "@tanstack/react-query";
import {
  BookPlus,
  ChevronRight,
  ExternalLink,
  FileCode,
  File as FileIcon,
  FileImage,
  FileSpreadsheet,
  FileText,
  Folder,
  FolderPlus,
  Laptop,
  type LucideIcon,
  PenLine,
  RefreshCw,
  Settings2,
  X,
} from "lucide-react";
import { Fragment, lazy, type ReactNode, Suspense, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { api } from "../../lib/api";
import { lang, t } from "../../lib/i18n";
import { useMe } from "../../lib/session";
import { useStudioPlugins } from "../../plugins/host";
import {
  askConfirm,
  Button,
  Card,
  cn,
  Dialog,
  IconButton,
  Input,
  Label,
  Select,
  Spinner,
  Switch,
} from "../../ui";
import { useDetail, useSettingsMenu } from "../settings-menu";
import { AudiencePicker } from "./Audience";
import {
  DraftsBar,
  editsAsText,
  type Published,
  ReplaceBar,
  ReplaceButton,
  TextDraft,
} from "./DateienEdit";
import { mountFileUrl, mountThumbUrl } from "./data";
import {
  type FolderPreview,
  type Mount,
  type MountDraft,
  type MountFile,
  type MountSee,
  type MountWizards,
  useMountAccess,
  useMountActions,
  useMountDrafts,
  useMountFiles,
  useMounts,
} from "./dateien-data";
import { ItemViewSwitch, useItemView } from "./item-view";
import { KnowledgeHeader, useKnowledge } from "./Knowledge";
import { chipsOf, MoveDialog, Tag } from "./KnowledgeTree";
import { viewerKind } from "./viewers-kind";

const Viewer = lazy(() => import("./viewers").then((m) => ({ default: m.Viewer })));

/**
 * Dateien (docs/plans/media-and-files.md, section 3): file trees another party owns, mounted in
 * the space and shown as they are there. Each mount is an entry of the menu with its folders as a
 * tree; a folder shows its files as a grid with thumbnails, a file opens in Wissen's viewers.
 * „Ordner einbinden“ chooses a folder of this computer (the system's dialog, else a path), says
 * what it found, and mounts it; a plugin's kind (a bucket, a drive) brings its own form instead. What is open is `?show=`: `d:<mount>` or `d:<mount>/<folder>`, a
 * file `m:<id>`, as a search hit opens it.
 */

type Shown = { mountId: string; folder: string } | { fileId: string } | null;

function shownOf(show: string | null): Shown {
  if (show?.startsWith("m:")) {
    return { fileId: show.slice(2) };
  }
  if (show?.startsWith("d:")) {
    const [mountId, ...rest] = show.slice(2).split("/");
    return { mountId, folder: rest.join("/") };
  }
  return null;
}

/** The folders of a mount, from its files' paths: each with the folders and files in it. */
export interface Node {
  path: string;
  name: string;
  folders: Node[];
  files: MountFile[];
  /** Files in it and below. */
  count: number;
}

export function treeOf(files: MountFile[]): Node {
  const root: Node = { path: "", name: "", folders: [], files: [], count: 0 };
  const byPath = new Map<string, Node>([["", root]]);
  const nodeOf = (path: string): Node => {
    const known = byPath.get(path);
    if (known) {
      return known;
    }
    const cut = path.lastIndexOf("/");
    const parent = nodeOf(cut < 0 ? "" : path.slice(0, cut));
    const node: Node = { path, name: path.slice(cut + 1), folders: [], files: [], count: 0 };
    parent.folders.push(node);
    byPath.set(path, node);
    return node;
  };
  for (const file of files) {
    const cut = file.path.lastIndexOf("/");
    const folder = nodeOf(cut < 0 ? "" : file.path.slice(0, cut));
    folder.files.push(file);
    for (let p: string | null = folder.path; p !== null; ) {
      (byPath.get(p) as Node).count++;
      p = p === "" ? null : p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
    }
  }
  const sort = (node: Node) => {
    node.folders.sort((a, b) => a.name.localeCompare(b.name, lang));
    node.folders.forEach(sort);
  };
  sort(root);
  return root;
}

function findNode(root: Node, path: string): Node | null {
  if (!path) {
    return root;
  }
  let node: Node | undefined = root;
  for (const part of path.split("/")) {
    node = node?.folders.find((f) => f.name === part);
  }
  return node ?? null;
}

/** One file of a mount by its id, with its mount: what a search hit opens. */
function useMountFile(spaceId: string, fileId: string | null) {
  return useQuery({
    queryKey: ["knowledge", spaceId, "dateien", "file", fileId],
    queryFn: () =>
      api.get<MountFile & { mountId: string }>(
        `/api/studio/spaces/${spaceId}/mount-files/${fileId}`,
      ),
    enabled: Boolean(fileId),
  });
}

// --- the menu ---------------------------------------------------------------------------------

export function DateienMenu({ spaceId, admin }: { spaceId: string; admin: boolean }) {
  const [params, setParams] = useSearchParams();
  const { narrow } = useSettingsMenu();
  const mounts = useMounts(spaceId);
  const shown = shownOf(params.get("show"));
  const file = useMountFile(spaceId, shown && "fileId" in shown ? shown.fileId : null);
  const [adding, setAdding] = useState(false);
  const mountId = shown
    ? "mountId" in shown
      ? shown.mountId
      : (file.data?.mountId ?? null)
    : (mounts.data?.mounts[0]?.id ?? null);
  const folder =
    shown && "folder" in shown
      ? shown.folder
      : file.data
        ? file.data.path.split("/").slice(0, -1).join("/")
        : "";
  const open = (show: string) => setParams({ show }, { replace: !narrow });
  return (
    <div className="flex flex-col gap-0.5">
      {mounts.data?.mounts.map((m) => (
        <MountRows
          key={m.id}
          spaceId={spaceId}
          mount={m}
          current={m.id === mountId}
          folder={m.id === mountId && !(shown && "fileId" in shown) ? folder : null}
          openFolder={m.id === mountId ? folder : null}
          fileId={shown && "fileId" in shown ? shown.fileId : null}
          onOpen={open}
        />
      ))}
      {admin ? (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="flex w-full items-center gap-2 rounded-lg px-1 py-1.5 text-left text-[0.875rem] text-ink-3 transition hover:bg-accent hover:text-ink"
        >
          <span className="grid size-6 place-items-center">
            <FolderPlus className="size-4" />
          </span>
          {t("dateien.mount")}
        </button>
      ) : null}
      <MountDialog
        spaceId={spaceId}
        open={adding}
        onClose={() => setAdding(false)}
        onMounted={(id) => {
          setAdding(false);
          open(`d:${id}`);
        }}
      />
    </div>
  );
}

function MountRows({
  spaceId,
  mount,
  current,
  folder,
  openFolder,
  fileId,
  onOpen,
}: {
  spaceId: string;
  mount: Mount;
  current: boolean;
  /** The folder shown, marked; null when a file is shown. */
  folder: string | null;
  /** The folder that stands open: the one shown, or the shown file's. */
  openFolder: string | null;
  /** The file shown, marked among its folder's files. */
  fileId: string | null;
  onOpen: (show: string) => void;
}) {
  const files = useMountFiles(spaceId, current ? mount : undefined);
  const tree = useMemo(() => treeOf(files.data?.files ?? []), [files.data]);
  const { filter } = useSettingsMenu();
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  // The folders around the one open stand open.
  useEffect(() => {
    if (openFolder) {
      const parts = openFolder.split("/");
      const up = parts.map((_, i) => parts.slice(0, i + 1).join("/"));
      setOpen((now) => (up.every((p) => now.has(p)) ? now : new Set([...now, ...up])));
    }
  }, [openFolder]);
  // A folder's files under its folders, as the folder's page lists them.
  const fileRows = (files: MountFile[], depth: number) =>
    (filter ? files.filter((f) => f.name.toLowerCase().includes(filter)) : files).map((f) => {
      const Icon = fileIcon(f);
      const selected = f.id === fileId;
      return (
        <li key={f.id}>
          <button
            type="button"
            onClick={() => onOpen(`m:${f.id}`)}
            aria-current={selected ? "page" : undefined}
            style={{ paddingLeft: `${depth * 12 + 24}px` }}
            className={cn(
              "flex w-full min-w-0 items-center gap-2 rounded-lg py-1.5 pr-1 text-left text-[0.875rem] transition",
              selected
                ? "bg-paper-2 font-medium text-ink"
                : "text-ink-2 hover:bg-accent hover:text-ink",
            )}
          >
            <Icon
              className={cn("size-4 shrink-0", selected ? "text-ember-strong" : "text-ink-3")}
            />
            <span className="min-w-0 flex-1 truncate">{f.name}</span>
          </button>
        </li>
      );
    });
  const row = (node: Node, depth: number) => {
    const isOpen = open.has(node.path) || Boolean(filter);
    const selected = folder === node.path;
    const folders = filter ? node.folders.filter((f) => hasMatch(f, filter)) : node.folders;
    const inside = node.folders.length + node.files.length > 0;
    return (
      <li key={node.path}>
        <div
          style={{ paddingLeft: `${depth * 12}px` }}
          className={cn(
            "group/row flex items-center rounded-lg transition",
            selected ? "bg-paper-2" : "hover:bg-accent",
          )}
        >
          <button
            type="button"
            tabIndex={inside ? 0 : -1}
            aria-label={isOpen ? t("know.collapse") : t("know.expand")}
            aria-expanded={inside ? isOpen : undefined}
            onClick={() =>
              setOpen((now) => {
                const next = new Set(now);
                if (!next.delete(node.path)) {
                  next.add(node.path);
                }
                return next;
              })
            }
            className={cn(
              "grid size-6 shrink-0 place-items-center rounded-md text-ink-4",
              inside ? "hover:text-ink" : "invisible",
            )}
          >
            <ChevronRight className={cn("size-3.5 transition-transform", isOpen && "rotate-90")} />
          </button>
          <button
            type="button"
            onClick={() => onOpen(`d:${mount.id}/${node.path}`)}
            aria-current={selected ? "page" : undefined}
            className={cn(
              "flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-1 text-left text-[0.875rem]",
              selected ? "font-medium text-ink" : "text-ink-2 group-hover/row:text-ink",
            )}
          >
            <Folder
              className={cn("size-4 shrink-0", selected ? "text-ember-strong" : "text-ink-3")}
            />
            <span className="min-w-0 flex-1 truncate">{node.name}</span>
            <span className="text-[0.75rem] text-ink-4 tabular-nums">{node.count}</span>
          </button>
        </div>
        {isOpen && inside ? (
          <ul className="flex flex-col gap-0.5 pt-0.5">
            {folders.map((f) => row(f, depth + 1))}
            {fileRows(node.files, depth + 1)}
          </ul>
        ) : null}
      </li>
    );
  };
  const atTop = current && folder === "";
  const kind = useStudioPlugins().mountKinds.find((k) => k.kind === mount.kind);
  const Mark = kind?.icon ?? Laptop;
  return (
    <>
      <button
        type="button"
        onClick={() => onOpen(`d:${mount.id}`)}
        aria-current={atTop ? "page" : undefined}
        className={cn(
          "flex w-full items-center gap-2 rounded-lg px-1 py-1.5 text-left text-[0.875rem] transition",
          atTop ? "bg-paper-2 font-medium text-ink" : "text-ink-2 hover:bg-accent hover:text-ink",
        )}
      >
        <span className="grid size-6 place-items-center">
          <Mark className={cn("size-4", atTop ? "text-ember-strong" : "text-ink-3")} />
        </span>
        <span className="min-w-0 flex-1 truncate">{mount.name}</span>
        <span className="truncate text-[0.75rem] text-ink-4">
          {mount.status === "away"
            ? t("dateien.away")
            : mount.kind === "folder"
              ? t("dateien.thisComputer")
              : (kind?.place() ?? "")}
        </span>
      </button>
      {current && (tree.folders.length || tree.files.length) ? (
        <ul className="flex flex-col gap-0.5 pb-1 pl-3">
          {(filter ? tree.folders.filter((f) => hasMatch(f, filter)) : tree.folders).map((f) =>
            row(f, 0),
          )}
          {fileRows(tree.files, 0)}
        </ul>
      ) : null}
    </>
  );
}

const hasMatch = (node: Node, filter: string): boolean =>
  node.name.toLowerCase().includes(filter) ||
  node.files.some((f) => f.name.toLowerCase().includes(filter)) ||
  node.folders.some((f) => hasMatch(f, filter));

// --- the page ---------------------------------------------------------------------------------

export function DateienPage({ spaceId, admin }: { spaceId: string; admin: boolean }) {
  const [params, setParams] = useSearchParams();
  const mounts = useMounts(spaceId);
  const shown = shownOf(params.get("show"));
  const [adding, setAdding] = useState(false);
  const fileId = shown && "fileId" in shown ? shown.fileId : null;
  const file = useMountFile(spaceId, fileId);
  const list = mounts.data?.mounts ?? [];
  const mountId = shown && "mountId" in shown ? shown.mountId : (file.data?.mountId ?? list[0]?.id);
  const mount = list.find((m) => m.id === mountId);
  const open = (show: string) => setParams({ show });
  if (mounts.isLoading) {
    return (
      <div className="flex h-40 items-center justify-center text-ink-3">
        <Spinner />
      </div>
    );
  }
  if (!list.length) {
    return (
      <section className="flex max-w-xl flex-col gap-4 py-10">
        <h1 className="font-display font-semibold text-[1.75rem] leading-tight tracking-tight">
          {t("space.dateien")}
        </h1>
        <p className="text-[0.9375rem] text-ink-2">{t("dateien.empty")}</p>
        {admin ? (
          <div>
            <Button onClick={() => setAdding(true)}>
              <FolderPlus className="size-4" /> {t("dateien.mount")}
            </Button>
          </div>
        ) : null}
        <MountDialog
          spaceId={spaceId}
          open={adding}
          onClose={() => setAdding(false)}
          onMounted={(id) => {
            setAdding(false);
            open(`d:${id}`);
          }}
        />
      </section>
    );
  }
  if (fileId) {
    return file.data && mount ? (
      <FileView spaceId={spaceId} mount={mount} file={file.data} onOpen={open} />
    ) : file.isError ? (
      <p className="py-10 text-[0.875rem] text-ink-3">{t("dateien.fileGone")}</p>
    ) : (
      <div className="flex h-40 items-center justify-center text-ink-3">
        <Spinner />
      </div>
    );
  }
  return mount ? (
    <FolderView
      spaceId={spaceId}
      mount={mount}
      folder={shown && "folder" in shown ? shown.folder : ""}
      admin={admin}
      onOpen={open}
      onGone={() => setParams({})}
    />
  ) : null;
}

/** Where a folder or a file sits: the mount, then the folders down to it. */
function Crumbs({
  mount,
  path,
  onOpen,
}: {
  mount: Mount;
  path: string;
  onOpen: (show: string) => void;
}) {
  const parts = path ? path.split("/") : [];
  return (
    <nav className="flex min-w-0 flex-wrap items-center gap-1 text-[0.75rem] text-ink-4">
      <button type="button" onClick={() => onOpen(`d:${mount.id}`)} className="hover:text-ink">
        {mount.name}
      </button>
      {parts.map((part, i) => (
        <span key={parts.slice(0, i + 1).join("/")} className="flex items-center gap-1">
          <ChevronRight className="size-3" />
          <button
            type="button"
            onClick={() => onOpen(`d:${mount.id}/${parts.slice(0, i + 1).join("/")}`)}
            className="hover:text-ink"
          >
            {part}
          </button>
        </span>
      ))}
    </nav>
  );
}

/**
 * A folder's or a file's head, as a page in Wissen has it: where it sits, its name as large as a
 * page's title, the buttons beside it, and one quiet line on it.
 */
function Head({
  crumbs,
  title,
  meta,
  actions,
}: {
  crumbs: ReactNode;
  title: string;
  meta: ReactNode[];
  actions: ReactNode;
}) {
  const shown = meta.filter(Boolean);
  return (
    <div className="flex flex-col gap-1 px-1">
      {crumbs}
      <div className="flex items-center gap-1.5">
        <h1 className="min-w-0 flex-1 truncate font-display font-semibold text-[1.75rem] leading-tight tracking-tight">
          {title}
        </h1>
        {actions}
      </div>
      {shown.length ? (
        // One line: a long part (a mount's path) is cut, the others stay whole.
        <p className="flex min-w-0 items-center gap-x-1.5 whitespace-nowrap text-[0.75rem] text-ink-4">
          {shown.map((part, i) => (
            <Fragment key={i}>
              {i ? <span aria-hidden>·</span> : null}
              {typeof part === "string" ? (
                <span title={part} className={part.length > 24 ? "min-w-0 truncate" : "shrink-0"}>
                  {part}
                </span>
              ) : (
                part
              )}
            </Fragment>
          ))}
        </p>
      ) : null}
    </div>
  );
}

/** How a mount stands, as the first part of its line: a dot in its colour and a word. */
function MountState({ mount }: { mount: Mount }) {
  const [dot, label] =
    mount.status === "away"
      ? ["bg-amber", t("dateien.away")]
      : mount.status === "scanning" || mount.pending
        ? ["bg-ember", t("dateien.reading")]
        : ["bg-moss", t("dateien.current")];
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      <span className={cn("size-1.5 rounded-full", dot)} />
      {label}
    </span>
  );
}

const labelClass = "px-1 font-medium text-[0.6875rem] text-ink-4 uppercase tracking-[0.12em]";

/** The small label above a set of folders or files, with the switch between cards and the list. */
function ItemsLabel({ label, switcher }: { label: string; switcher: boolean }) {
  return (
    <div className="flex min-h-8 items-center justify-between">
      <p className={labelClass}>{label}</p>
      {switcher ? <ItemViewSwitch /> : null}
    </div>
  );
}

function FolderView({
  spaceId,
  mount,
  folder,
  admin,
  onOpen,
  onGone,
}: {
  spaceId: string;
  mount: Mount;
  folder: string;
  admin: boolean;
  onOpen: (show: string) => void;
  onGone: () => void;
}) {
  const files = useMountFiles(spaceId, mount);
  const drafts = useMountDrafts(spaceId, mount);
  const knowledge = useKnowledge(spaceId);
  const actions = useMountActions(spaceId);
  const tree = useMemo(() => treeOf(files.data?.files ?? []), [files.data]);
  const node = findNode(tree, folder);
  const [settings, setSettings] = useState(false);
  const title = node?.name || mount.name;
  useDetail(folder ? title : null);
  const done = mount.files - mount.pending;
  const items = (list: { folders: Node[]; files: MountFile[] }) => (
    <MountItems
      spaceId={spaceId}
      mount={mount}
      folders={list.folders}
      files={list.files}
      drafts={drafts.data?.drafts ?? []}
      categories={knowledge.data?.categories ?? []}
      onOpen={onOpen}
    />
  );
  return (
    <section className="flex flex-col gap-8 pb-20">
      <div className="flex flex-col gap-3">
        <Head
          crumbs={
            folder ? (
              <Crumbs
                mount={mount}
                path={folder.split("/").slice(0, -1).join("/")}
                onOpen={onOpen}
              />
            ) : null
          }
          title={title}
          meta={[
            <MountState key="state" mount={mount} />,
            folder ? null : mount.where,
            `${t("dateien.count", { files: (node?.count ?? mount.files).toLocaleString(lang) })}${
              folder ? "" : ` · ${formatBytes(mount.bytes)}`
            }`,
            folder ? null : mount.writable ? t("dateien.writableOn") : t("dateien.readOnly"),
          ]}
          actions={
            <>
              <IconButton
                label={t("dateien.rescan")}
                className="size-8"
                onClick={() => void actions.rescan(mount.id)}
              >
                <RefreshCw className="size-4" />
              </IconButton>
              {admin ? (
                <IconButton
                  label={t("dateien.settings")}
                  className="size-8"
                  onClick={() => setSettings(true)}
                >
                  <Settings2 className="size-4" />
                </IconButton>
              ) : null}
            </>
          }
        />
        {drafts.data?.drafts.length ? (
          <DraftsBar spaceId={spaceId} mount={mount} drafts={drafts.data.drafts} />
        ) : null}
        {mount.status === "away" ? (
          <p className="px-1 text-[0.8125rem] text-ink-2">{t("dateien.awayText")}</p>
        ) : mount.pending ? (
          <Progress
            done={done}
            total={mount.files}
            line={t("dateien.indexing", {
              done: done.toLocaleString(lang),
              total: mount.files.toLocaleString(lang),
            })}
          />
        ) : mount.vectorsPending ? (
          <p className="px-1 text-[0.75rem] text-ink-4">
            {t("dateien.vectors", { count: mount.vectorsPending.toLocaleString(lang) })}
          </p>
        ) : null}
      </div>
      {!files.data ? (
        <div className="flex h-40 items-center justify-center text-ink-3">
          <Spinner />
        </div>
      ) : !node || (!node.folders.length && !node.files.length) ? (
        <p className="px-1 text-[0.875rem] text-ink-3">{t("dateien.emptyFolder")}</p>
      ) : (
        <>
          {node.folders.length ? (
            <div className="flex flex-col gap-1.5">
              <ItemsLabel label={t("know.folders")} switcher />
              {items({ folders: node.folders, files: [] })}
            </div>
          ) : null}
          {node.files.length ? (
            <div className="flex flex-col gap-1.5">
              <ItemsLabel label={t("space.dateien")} switcher={!node.folders.length} />
              {items({ folders: [], files: node.files })}
            </div>
          ) : null}
        </>
      )}
      <MountSettings
        spaceId={spaceId}
        mount={settings ? mount : null}
        onClose={() => setSettings(false)}
        onGone={onGone}
      />
    </section>
  );
}

const typeOf = (f: Pick<MountFile, "name">) =>
  f.name.includes(".") ? (f.name.split(".").pop() as string).toUpperCase().slice(0, 5) : "—";

/** A file's mark by what shows it. */
function fileIcon(f: Pick<MountFile, "mime" | "name">): LucideIcon {
  switch (viewerKind(f.mime, f.name)) {
    case "image":
      return FileImage;
    case "sheet":
      return FileSpreadsheet;
    case "html":
      return FileCode;
    case "pdf":
    case "text":
      return FileText;
    default:
      return FileIcon;
  }
}

/** A draft waiting in engenty: amber, red when the file changed at the source too. */
function DraftDot({ conflict }: { conflict: boolean }) {
  return (
    <span
      title={t("dateien.draft")}
      className={cn("size-2 shrink-0 rounded-full", conflict ? "bg-rose" : "bg-amber")}
    />
  );
}

/**
 * A folder's folders or files as Wissen shows its items (`ItemCards`): cards with a picture when
 * the file has one, how much a folder holds or a file weighs, and two category values; or a
 * dense list, as the person switched it (`ItemViewSwitch`).
 */
function MountItems({
  spaceId,
  mount,
  folders,
  files,
  drafts,
  categories,
  onOpen,
}: {
  spaceId: string;
  mount: Mount;
  folders: Node[];
  files: MountFile[];
  drafts: MountDraft[];
  categories: SpaceCategory[];
  onOpen: (show: string) => void;
}) {
  const view = useItemView();
  const entries = [
    ...folders.map((f) => ({
      key: f.path,
      show: `d:${mount.id}/${f.path}`,
      Icon: Folder,
      title: f.name,
      named: null as string | null,
      line: t("dateien.count", { files: f.count.toLocaleString(lang) }),
      size: f.count.toLocaleString(lang),
      thumb: null,
      chips: [] as string[],
      draft: undefined as MountDraft | undefined,
      pending: false,
    })),
    ...files.map((f) => ({
      key: f.id,
      show: `m:${f.id}`,
      Icon: fileIcon(f),
      title: f.name,
      // What the text calls itself, when it is more than the file's name says.
      named:
        f.title && f.title.toLowerCase() !== f.name.replace(/\.[^.]+$/, "").toLowerCase()
          ? f.title
          : null,
      line: [typeOf(f), f.pages ? t("space.pages", { n: f.pages }) : null, formatBytes(f.size)]
        .filter(Boolean)
        .join(" · "),
      size: formatBytes(f.size),
      thumb: f.thumb ? mountThumbUrl(spaceId, f.id) : null,
      // A folder's name as a category value (`folderCategory`) says what the folder says already.
      chips: chipsOf({ categories: f.categories } as KnowledgeItem, categories).filter(
        (c) => !f.path.split("/").slice(0, -1).includes(c),
      ),
      draft: drafts.find((d) => d.fileId === f.id),
      pending: f.status === "pending",
    })),
  ];
  if (view === "list") {
    return (
      <div className="flex flex-col rounded-xl bg-card p-1.5 shadow-soft ring-1 ring-border-soft">
        {entries.map((e) => (
          <button
            key={e.key}
            type="button"
            onClick={() => onOpen(e.show)}
            className="flex min-w-0 items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition hover:bg-accent"
          >
            {e.pending ? (
              <Spinner className="size-4 shrink-0 text-ink-3" />
            ) : (
              <e.Icon className="size-4 shrink-0 text-ink-3" />
            )}
            <span className="flex min-w-0 flex-1 items-baseline gap-2.5">
              <span className="shrink-0 truncate text-[0.875rem]">{e.title}</span>
              {e.named ? (
                <span className="min-w-0 truncate text-[0.8125rem] text-ink-4">{e.named}</span>
              ) : null}
            </span>
            {e.draft ? <DraftDot conflict={Boolean(e.draft.conflict)} /> : null}
            <span className="flex shrink-0 gap-1 max-sm:hidden">
              {e.chips.map((c) => (
                <Tag key={c}>{c}</Tag>
              ))}
            </span>
            <span className="w-16 shrink-0 text-right text-[0.75rem] text-ink-4 tabular-nums">
              {e.size}
            </span>
          </button>
        ))}
      </div>
    );
  }
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3">
      {entries.map((e) => (
        <button
          key={e.key}
          type="button"
          onClick={() => onOpen(e.show)}
          className="flex min-w-0 flex-col overflow-hidden rounded-xl bg-card text-left shadow-soft ring-1 ring-border-soft transition hover:ring-border"
        >
          {e.thumb ? (
            <img
              src={e.thumb}
              alt=""
              loading="lazy"
              className="aspect-[16/9] w-full border-border-soft border-b bg-paper-2 object-cover"
            />
          ) : null}
          <span className="flex min-w-0 flex-col gap-1.5 px-3.5 py-3">
            <span className="flex min-w-0 items-center gap-2">
              {e.pending ? (
                <Spinner className="size-4 shrink-0 text-ink-3" />
              ) : (
                <e.Icon className="size-4 shrink-0 text-ink-3" />
              )}
              <span className="min-w-0 flex-1 truncate font-medium text-[0.875rem]">{e.title}</span>
              {e.draft ? <DraftDot conflict={Boolean(e.draft.conflict)} /> : null}
            </span>
            {e.named ? (
              <span className="-mt-1 truncate text-[0.8125rem] text-ink-3">{e.named}</span>
            ) : null}
            <span className="truncate text-[0.75rem] text-ink-4">{e.line}</span>
            {e.chips.length ? (
              <span className="flex flex-wrap gap-1">
                {e.chips.map((c) => (
                  <Tag key={c}>{c}</Tag>
                ))}
              </span>
            ) : null}
          </span>
        </button>
      ))}
    </div>
  );
}

function Progress({ done, total, line }: { done: number; total: number; line: string }) {
  return (
    <div className="flex flex-col gap-1.5 px-1">
      <div className="h-1 overflow-hidden rounded-full bg-paper-2">
        <div
          className="h-full rounded-full bg-ember transition-[width]"
          style={{ width: `${total ? Math.round((done / total) * 100) : 0}%` }}
        />
      </div>
      <p className="text-[0.75rem] text-ink-4">{line}</p>
    </div>
  );
}

function FileView({
  spaceId,
  mount,
  file,
  onOpen,
}: {
  spaceId: string;
  mount: Mount;
  file: MountFile;
  onOpen: (show: string) => void;
}) {
  const [params] = useSearchParams();
  // A hit on a PDF page opens there: `m:<id>#<page>`.
  const page = Number(params.get("show")?.split("#")[1]) || undefined;
  // A new version of the file (published from here) is loaded anew, not from the browser's cache.
  const url = `${mountFileUrl(spaceId, file.id)}?v=${file.size}-${file.modified}`;
  const kind = viewerKind(file.mime, file.name);
  const folder = file.path.split("/").slice(0, -1).join("/");
  const knowledge = useKnowledge(spaceId);
  const actions = useMountActions(spaceId);
  const navigate = useNavigate();
  const [copying, setCopying] = useState(false);
  useDetail(file.name);
  const drafts = useMountDrafts(spaceId, mount);
  const draft = drafts.data?.drafts.find((d) => d.fileId === file.id);
  const asText = editsAsText(file);
  const [editing, setEditing] = useState(false);
  const [published, setPublished] = useState<Published>(null);
  // Another file opened: its own state.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the file's id is what resets it.
  useEffect(() => {
    setEditing(false);
    setPublished(null);
  }, [file.id]);
  // A text with a draft opens in its editor, and stays there while it is edited.
  useEffect(() => {
    if (draft && asText) {
      setEditing(true);
    }
  }, [draft, asText]);
  const writing = mount.writable && asText && editing;
  const reachable = mount.status !== "away";
  // Read, a Markdown file stands on the page as its text, as a page of Wissen does.
  const asPage = kind === "text" && /\.(md|markdown)$/i.test(file.name) && reachable;
  const done = (how: Exclude<Published, null>) => {
    setEditing(false);
    setPublished(how);
  };
  return (
    <section className="flex flex-col gap-3 pb-20">
      <Head
        crumbs={<Crumbs mount={mount} path={folder} onOpen={onOpen} />}
        title={file.name}
        meta={[
          typeOf(file),
          file.pages ? t("space.pages", { n: file.pages }) : null,
          formatBytes(file.size),
        ]}
        actions={
          <>
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              aria-label={t("space.openOriginal")}
              title={t("space.openOriginal")}
              className="inline-flex size-8 items-center justify-center rounded-full text-ink-3 transition hover:bg-accent hover:text-ink"
            >
              <ExternalLink className="size-4" />
            </a>
            <IconButton
              label={t("dateien.toKnowledge")}
              className="size-8"
              onClick={() => setCopying(true)}
            >
              <BookPlus className="size-4" />
            </IconButton>
            {mount.writable && reachable && !writing ? (
              asText ? (
                <Button
                  size="sm"
                  variant="secondary"
                  className="ml-1"
                  onClick={() => {
                    setPublished(null);
                    setEditing(true);
                  }}
                >
                  <PenLine className="size-4" /> {t("dateien.edit")}
                </Button>
              ) : (
                <ReplaceButton spaceId={spaceId} mount={mount} file={file} />
              )
            ) : null}
          </>
        }
      />
      <MoveDialog
        item={
          copying
            ? // Not in Knowledge yet: no folder is its own.
              ({
                key: `m:${file.id}`,
                kind: "file",
                title: file.name,
                parentId: "",
              } as KnowledgeItem)
            : null
        }
        items={knowledge.data?.items ?? []}
        title={t("dateien.toKnowledgeTitle", { name: file.name })}
        note={t("dateien.toKnowledgeNote")}
        onClose={() => setCopying(false)}
        onMove={async (_key, parentId) => {
          const copy = await actions.toKnowledge(file.id, parentId);
          navigate(`/space/knowledge?show=${encodeURIComponent(`f:${copy.id}`)}`);
        }}
      />
      <KnowledgeHeader
        spaceId={spaceId}
        itemKey={`m:${file.id}`}
        has={file.categories}
        originLabel={null}
        kept={false}
        review={null}
        file={null}
        readOnly={false}
        onReviewed={() => undefined}
      />
      {file.status === "skipped" ? (
        <p className="px-1 text-[0.8125rem] text-ink-3">{t("dateien.skipped")}</p>
      ) : null}
      {published ? (
        <p role="status" className="px-1 text-[0.8125rem] text-moss">
          {published === "merged" ? t("dateien.merged") : t("dateien.published")}
        </p>
      ) : null}
      {draft && !asText ? (
        <ReplaceBar spaceId={spaceId} mount={mount} file={file} draft={draft} onPublished={done} />
      ) : null}
      {writing ? (
        <TextDraft
          spaceId={spaceId}
          mount={mount}
          file={file}
          onPublished={done}
          onClose={() => setEditing(false)}
          onOpen={onOpen}
        />
      ) : asPage ? (
        // A page read stands in its own frame, as a document on the desk.
        <Card className="px-5 py-5 sm:px-10 sm:py-8">
          <Suspense
            fallback={
              <div className="flex h-40 items-center justify-center text-ink-3">
                <Spinner />
              </div>
            }
          >
            <Viewer kind="text" url={url} name={file.name} plain />
          </Suspense>
        </Card>
      ) : (
        <Card className="flex flex-col">
          {kind && reachable ? (
            <Suspense
              fallback={
                <div className="flex h-40 items-center justify-center text-ink-3">
                  <Spinner />
                </div>
              }
            >
              <Viewer kind={kind} url={url} name={file.name} page={page} />
            </Suspense>
          ) : (
            <p className="py-10 text-center text-[0.875rem] text-ink-3">
              {reachable ? t("dateien.noPreview") : t("dateien.awayText")}
            </p>
          )}
        </Card>
      )}
    </section>
  );
}

// --- mounting a folder --------------------------------------------------------------------------

function AccessFields({
  spaceId,
  see,
  wizards,
  onSee,
  onWizards,
}: {
  spaceId: string;
  see: MountSee;
  wizards: MountWizards;
  onSee: (v: MountSee) => void;
  onWizards: (v: MountWizards) => void;
}) {
  const list = useQuery({
    queryKey: ["wizards", spaceId, "dateien"],
    queryFn: () =>
      api.get<{ id: string; title: string }[]>(`/api/studio/spaces/${spaceId}/wizards`),
  });
  const picked = Array.isArray(wizards) ? wizards : [];
  return (
    <div className="flex flex-col gap-3">
      <div>
        <Label>{t("dateien.see")}</Label>
        <AudiencePicker value={see} onChange={onSee} />
      </div>
      <div>
        <Label>{t("dateien.wizards")}</Label>
        <Select
          value={Array.isArray(wizards) ? "some" : wizards}
          onChange={(v) => onWizards(v === "some" ? picked : (v as "all" | "none"))}
          options={[
            { value: "all", label: t("dateien.wizardsAll") },
            { value: "some", label: t("dateien.wizardsSome") },
            { value: "none", label: t("dateien.wizardsNone") },
          ]}
        />
        {Array.isArray(wizards) ? (
          <div className="mt-2 flex max-h-40 flex-col gap-1 overflow-y-auto">
            {list.data?.map((w) => (
              <label key={w.id} className="flex items-center gap-2 text-[0.875rem]">
                <input
                  type="checkbox"
                  checked={picked.includes(w.id)}
                  onChange={(e) =>
                    onWizards(
                      e.target.checked ? [...picked, w.id] : picked.filter((id) => id !== w.id),
                    )
                  }
                />
                <span className="truncate">{w.title}</span>
              </label>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** „Ändern erlauben“: off unless asked for; drafts are then written back with „Veröffentlichen“. */
function WritableField({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-start justify-between gap-3 rounded-lg p-3 ring-1 ring-border-soft">
      <span className="flex flex-col gap-0.5">
        <span className="font-medium text-[0.875rem]">{t("dateien.writable")}</span>
        <span className="text-[0.8125rem] text-ink-3">{t("dateien.writableNote")}</span>
      </span>
      <Switch checked={checked} onChange={onChange} />
    </label>
  );
}

function MountDialog({
  spaceId,
  open,
  onClose,
  onMounted,
}: {
  spaceId: string;
  open: boolean;
  onClose: () => void;
  onMounted: (mountId: string) => void;
}) {
  const actions = useMountActions(spaceId);
  const kinds = useStudioPlugins().mountKinds;
  const local = useMe().data?.mode === "local";
  // A folder of this computer on a local install; every kind a plugin brings.
  const choices = [...(local ? ["folder"] : []), ...kinds.map((k) => k.kind)];
  const [kind, setKind] = useState<string | null>(null);
  const chosenKind = kind ?? choices[0] ?? null;
  const plugin = kinds.find((k) => k.kind === chosenKind);
  const [chosen, setChosen] = useState<{ source: Record<string, unknown>; name: string } | null>(
    null,
  );
  const [ready, setReady] = useState(false);
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [suggest, setSuggest] = useState<string[]>([]);
  const [noDialog, setNoDialog] = useState(false);
  const [found, setFound] = useState<FolderPreview | null>(null);
  const [see, setSee] = useState<MountSee>(["team"]);
  const [wizards, setWizards] = useState<MountWizards>("all");
  const [writable, setWritable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Opened again, it starts anew.
  useEffect(() => {
    if (open) {
      setKind(null);
      setChosen(null);
      setReady(false);
      setPath("");
      setFound(null);
      setError(null);
      setSee(["team"]);
      setWizards("all");
      setWritable(false);
    }
  }, [open]);
  // The path field completes folders as one types.
  // biome-ignore lint/correctness/useExhaustiveDependencies: what is typed asks, not the actions' object.
  useEffect(() => {
    if (!open || found || !path.trim()) {
      setSuggest([]);
      return;
    }
    const timer = setTimeout(() => {
      actions.folders(path).then(
        (r) => setSuggest(r.folders.filter((f) => f !== path)),
        () => setSuggest([]),
      );
    }, 200);
    return () => clearTimeout(timer);
  }, [path, open, found]);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const review = (chosen: string) =>
    run(async () => {
      const preview = await actions.preview(chosen);
      setFound(preview);
    });
  const choose = () =>
    run(async () => {
      const { path: picked } = await actions.pick(t("dateien.pickPrompt"));
      if (picked === false) {
        setNoDialog(true);
      } else if (picked) {
        setPath(picked);
        await review(picked);
      }
    });
  // Another kind picked on the left starts its steps anew.
  const pickKind = (next: string) => {
    setKind(next);
    setChosen(null);
    setReady(false);
    setFound(null);
    setError(null);
    setNoDialog(false);
  };
  const mount = (input: Parameters<typeof actions.create>[0]) =>
    run(async () => {
      const made = await actions.create(input);
      onMounted(made.id);
    });
  const kindOf = (c: string) => kinds.find((x) => x.kind === c);
  const kindLabel = (c: string) => kindOf(c)?.label() ?? t("dateien.kindFolder");
  const hint = found
    ? found.complete
      ? t("dateien.found", {
          files: found.files.toLocaleString(lang),
          folders: found.folders.toLocaleString(lang),
          size: formatBytes(found.bytes),
        })
      : t("dateien.foundAtLeast", { files: found.files.toLocaleString(lang) })
    : plugin
      ? (plugin.hint?.() ?? "")
      : t("dateien.chooseText");
  return (
    // As „Hinzufügen“ in Wissen: the kinds on the left, the picked one's steps on the right.
    <Dialog open={open} onClose={onClose} bare wide="page">
      <div className="mx-auto flex h-[min(36rem,calc(100dvh-32px))] w-full overflow-hidden rounded-2xl bg-card shadow-overlay max-sm:h-dvh max-sm:flex-col max-sm:rounded-none">
        <nav className="flex w-56 shrink-0 flex-col gap-0.5 overflow-y-auto border-border-soft border-r bg-paper-2/60 p-2 max-sm:w-full max-sm:flex-row max-sm:overflow-x-auto max-sm:border-r-0 max-sm:border-b">
          <p className="px-2 pb-1 font-medium text-[0.6875rem] text-ink-4 uppercase tracking-[0.12em] max-sm:hidden">
            {t("dateien.mount")}
          </p>
          {choices.map((c) => {
            const Mark = kindOf(c)?.icon ?? Laptop;
            return (
              <button
                key={c}
                type="button"
                aria-current={c === chosenKind ? "true" : undefined}
                onClick={() => pickKind(c)}
                className={cn(
                  "flex h-8 w-full shrink-0 items-center gap-2 rounded-md px-2 text-left text-[0.8125rem] transition max-sm:w-auto",
                  c === chosenKind
                    ? "bg-card font-medium text-ink shadow-soft"
                    : "text-ink-2 hover:bg-accent",
                )}
              >
                <Mark className="size-4 shrink-0 text-ink-3" />
                <span className="truncate">{kindLabel(c)}</span>
              </button>
            );
          })}
        </nav>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-start justify-between gap-3 px-6 pt-5">
            <div className="min-w-0">
              <h2 className="font-display font-semibold text-lg">
                {chosenKind ? kindLabel(chosenKind) : t("dateien.mount")}
              </h2>
              {hint ? <p className="mt-1 text-[0.8125rem] text-ink-3">{hint}</p> : null}
            </div>
            <IconButton label={t("common.close")} onClick={onClose} className="-mt-1 -mr-2 size-8">
              <X className="size-4" />
            </IconButton>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-4 pb-6">
            {!chosenKind ? (
              <p className="text-[0.875rem] text-ink-3">{t("dateien.noKinds")}</p>
            ) : plugin ? (
              plugin && !ready ? (
                <div className="flex flex-col gap-4">
                  <plugin.form
                    space={spaceId}
                    onChange={(c) => {
                      setChosen(c);
                      if (c) {
                        setName(c.name);
                      }
                    }}
                  />
                  <div className="flex justify-end gap-2">
                    <Button variant="ghost" onClick={onClose}>
                      {t("common.cancel")}
                    </Button>
                    <Button disabled={!chosen} onClick={() => setReady(true)}>
                      {t("dateien.next")}
                    </Button>
                  </div>
                </div>
              ) : plugin && chosen ? (
                <div className="flex flex-col gap-4">
                  <div className="-mt-2 flex flex-col gap-1 text-[0.875rem] text-ink-2">
                    <span>{t("dateien.readsOnce")}</span>
                    <span>{t("dateien.keepsNoText")}</span>
                  </div>
                  <div>
                    <Label>{t("know.name")}</Label>
                    <Input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
                  </div>
                  <AccessFields
                    spaceId={spaceId}
                    see={see}
                    wizards={wizards}
                    onSee={setSee}
                    onWizards={setWizards}
                  />
                  <WritableField checked={writable} onChange={setWritable} />
                  {error ? <p className="text-[0.875rem] text-rose">{error}</p> : null}
                  <div className="flex justify-end gap-2">
                    <Button variant="ghost" onClick={() => setReady(false)}>
                      {t("common.back")}
                    </Button>
                    <Button
                      busy={busy}
                      onClick={() =>
                        void run(async () => {
                          // Writing asks the account for the rights to write first.
                          if (
                            writable &&
                            plugin.allowWrite &&
                            !(await plugin.allowWrite({ space: spaceId, source: chosen.source }))
                          ) {
                            throw new Error(t("dateien.writeNotAllowed"));
                          }
                          const made = await actions.create({
                            kind: plugin.kind,
                            source: chosen.source,
                            name: name.trim() || chosen.name,
                            see,
                            wizards,
                            writable,
                          });
                          onMounted(made.id);
                        })
                      }
                    >
                      {t("dateien.mountButton")}
                    </Button>
                  </div>
                </div>
              ) : null
            ) : !found ? (
              <form
                className="flex flex-col gap-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (path.trim()) {
                    void review(path.trim());
                  }
                }}
              >
                <div className="relative flex gap-2">
                  <Input
                    data-autofocus
                    value={path}
                    placeholder="~/Kunden"
                    aria-label={t("dateien.path")}
                    onChange={(e) => setPath(e.target.value)}
                    className="flex-1"
                  />
                  <Button type="button" variant="ghost" busy={busy} onClick={() => void choose()}>
                    {t("dateien.choose")}
                  </Button>
                  {suggest.length ? (
                    <ul className="absolute top-full right-0 left-0 z-10 mt-1 max-h-48 overflow-y-auto rounded-lg bg-card p-1 shadow-soft ring-1 ring-border-soft">
                      {suggest.map((s) => (
                        <li key={s}>
                          <button
                            type="button"
                            onClick={() => setPath(`${s}/`)}
                            className="w-full truncate rounded-md px-2 py-1 text-left text-[0.8125rem] hover:bg-accent"
                          >
                            {s}
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
                {noDialog ? (
                  <p className="text-[0.8125rem] text-ink-3">{t("dateien.noDialog")}</p>
                ) : null}
                <p className="text-[0.8125rem] text-ink-3">{t("dateien.chooseNote")}</p>
                {error ? <p className="text-[0.875rem] text-rose">{error}</p> : null}
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" onClick={onClose}>
                    {t("common.cancel")}
                  </Button>
                  <Button type="submit" busy={busy} disabled={!path.trim()}>
                    {t("dateien.next")}
                  </Button>
                </div>
              </form>
            ) : (
              <div className="flex flex-col gap-4">
                <div className="-mt-2 flex flex-col gap-1 text-[0.875rem] text-ink-2">
                  <span className="truncate text-ink-3">{found.path}</span>
                  <span>{t("dateien.readsOnce")}</span>
                  <span>{t("dateien.keepsNoText")}</span>
                </div>
                {found.first.length ? (
                  <ul className="flex max-h-44 flex-col overflow-y-auto rounded-lg bg-paper-2 p-1.5">
                    {found.first.map((f) => (
                      <li
                        key={f.name}
                        className="flex items-center gap-2 px-1.5 py-1 text-[0.8125rem]"
                      >
                        <Folder className="size-3.5 shrink-0 text-ink-3" />
                        <span className="min-w-0 flex-1 truncate">{f.name}</span>
                        <span className="text-ink-3 tabular-nums">{f.files}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {found.leftOut ? (
                  <p className="text-[0.8125rem] text-ink-3">
                    {t("dateien.leftOut", { count: found.leftOut })}
                  </p>
                ) : null}
                <AccessFields
                  spaceId={spaceId}
                  see={see}
                  wizards={wizards}
                  onSee={setSee}
                  onWizards={setWizards}
                />
                <WritableField checked={writable} onChange={setWritable} />
                {error ? <p className="text-[0.875rem] text-rose">{error}</p> : null}
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" onClick={() => setFound(null)}>
                    {t("common.back")}
                  </Button>
                  <Button
                    busy={busy}
                    onClick={() =>
                      void mount({
                        path: found.path,
                        see,
                        wizards,
                        writable,
                      })
                    }
                  >
                    {t("dateien.mountButton")}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </Dialog>
  );
}

function MountSettings({
  spaceId,
  mount,
  onClose,
  onGone,
}: {
  spaceId: string;
  mount: Mount | null;
  onClose: () => void;
  onGone: () => void;
}) {
  const access = useMountAccess(spaceId, mount?.id ?? null);
  const actions = useMountActions(spaceId);
  const kind = useStudioPlugins().mountKinds.find((k) => k.kind === mount?.kind);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [see, setSee] = useState<MountSee>(["team"]);
  const [wizards, setWizards] = useState<MountWizards>("all");
  const [writable, setWritable] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (access.data) {
      setName(access.data.name);
      setSee(access.data.see);
      setWizards(access.data.wizards);
      setWritable(access.data.writable);
    }
  }, [access.data]);
  return (
    <Dialog open={mount !== null} onClose={onClose} title={mount?.name ?? ""}>
      {mount && access.data ? (
        <div className="flex flex-col gap-4">
          <div>
            <Label>{t("know.name")}</Label>
            <Input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
          </div>
          <AccessFields
            spaceId={spaceId}
            see={see}
            wizards={wizards}
            onSee={setSee}
            onWizards={setWizards}
          />
          <WritableField checked={writable} onChange={setWritable} />
          {error ? <p className="text-[0.875rem] text-rose">{error}</p> : null}
          <div className="flex items-center justify-between gap-2">
            <Button
              variant="ghost"
              className="text-rose"
              onClick={async () => {
                if (await askConfirm(t("dateien.removeConfirm", { name: mount.name }))) {
                  await actions.remove(mount.id);
                  onClose();
                  onGone();
                }
              }}
            >
              {t("dateien.remove")}
            </Button>
            <Button
              busy={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  // Writing turned on for an account without the rights: it is asked for them.
                  const ask =
                    writable && !access.data?.canWrite && kind?.allowWrite && access.data?.source;
                  if (
                    ask &&
                    !(await kind.allowWrite?.({
                      space: spaceId,
                      source: access.data?.source ?? {},
                    }))
                  ) {
                    setError(t("dateien.writeNotAllowed"));
                    return;
                  }
                  await actions.update(mount.id, { name, see, wizards, writable });
                  onClose();
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t("dateien.save")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex h-24 items-center justify-center text-ink-3">
          <Spinner />
        </div>
      )}
    </Dialog>
  );
}
