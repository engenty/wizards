import type { KnowledgeItem } from "@engenty/wizards-shared/knowledge";
import { formatBytes } from "@engenty/wizards-shared/numbers";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronRight,
  ExternalLink,
  Folder,
  FolderPlus,
  Laptop,
  RefreshCw,
  Settings2,
} from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { api } from "../../lib/api";
import { lang, t } from "../../lib/i18n";
import {
  Button,
  Card,
  Chip,
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
import { mountFileUrl, mountThumbUrl } from "./data";
import {
  type FolderPreview,
  type Mount,
  type MountFile,
  type MountSee,
  type MountWizards,
  useMountAccess,
  useMountActions,
  useMountFiles,
  useMounts,
} from "./dateien-data";
import { KnowledgeHeader, useKnowledge } from "./Knowledge";
import { chipsOf } from "./KnowledgeTree";
import { viewerKind } from "./viewers-kind";

const Viewer = lazy(() => import("./viewers").then((m) => ({ default: m.Viewer })));

/**
 * Dateien (docs/plans/media-and-files.md, section 3): file trees another party owns, mounted in
 * the space and shown as they are there. Each mount is an entry of the menu with its folders as a
 * tree; a folder shows its files as a grid with thumbnails, a file opens in Wissen's viewers.
 * „Ordner einbinden“ chooses a folder of this computer (the system's dialog, else a path), says
 * what it found, and mounts it. What is open is `?show=`: `d:<mount>` or `d:<mount>/<folder>`, a
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
interface Node {
  path: string;
  name: string;
  folders: Node[];
  files: MountFile[];
  /** Files in it and below. */
  count: number;
}

function treeOf(files: MountFile[]): Node {
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
          folder={m.id === mountId ? folder : null}
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
  onOpen,
}: {
  spaceId: string;
  mount: Mount;
  current: boolean;
  folder: string | null;
  onOpen: (show: string) => void;
}) {
  const files = useMountFiles(spaceId, current ? mount : undefined);
  const tree = useMemo(() => treeOf(files.data?.files ?? []), [files.data]);
  const { filter } = useSettingsMenu();
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  // The folders around the one open stand open.
  useEffect(() => {
    if (folder) {
      const parts = folder.split("/");
      const up = parts.map((_, i) => parts.slice(0, i + 1).join("/"));
      setOpen((now) => (up.every((p) => now.has(p)) ? now : new Set([...now, ...up])));
    }
  }, [folder]);
  const row = (node: Node, depth: number) => {
    const isOpen = open.has(node.path) || Boolean(filter);
    const selected = folder === node.path;
    const folders = filter ? node.folders.filter((f) => hasMatch(f, filter)) : node.folders;
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
            tabIndex={node.folders.length ? 0 : -1}
            aria-label={isOpen ? t("know.collapse") : t("know.expand")}
            aria-expanded={node.folders.length ? isOpen : undefined}
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
              node.folders.length ? "hover:text-ink" : "invisible",
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
        {isOpen && folders.length ? (
          <ul className="flex flex-col gap-0.5 pt-0.5">{folders.map((f) => row(f, depth + 1))}</ul>
        ) : null}
      </li>
    );
  };
  const atTop = current && folder === "";
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
          <Laptop className={cn("size-4", atTop ? "text-ember-strong" : "text-ink-3")} />
        </span>
        <span className="min-w-0 flex-1 truncate">{mount.name}</span>
        <span className="truncate text-[0.75rem] text-ink-4">
          {mount.status === "away" ? t("dateien.away") : t("dateien.thisComputer")}
        </span>
      </button>
      {current && tree.folders.length ? (
        <ul className="flex flex-col gap-0.5 pb-1 pl-3">
          {(filter ? tree.folders.filter((f) => hasMatch(f, filter)) : tree.folders).map((f) =>
            row(f, 0),
          )}
        </ul>
      ) : null}
    </>
  );
}

const hasMatch = (node: Node, filter: string): boolean =>
  node.name.toLowerCase().includes(filter) || node.folders.some((f) => hasMatch(f, filter));

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
        <h1 className="font-display font-semibold text-2xl">{t("space.dateien")}</h1>
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
    <nav className="flex min-w-0 flex-wrap items-center gap-1 text-[0.8125rem] text-ink-3">
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
  const knowledge = useKnowledge(spaceId);
  const actions = useMountActions(spaceId);
  const tree = useMemo(() => treeOf(files.data?.files ?? []), [files.data]);
  const node = findNode(tree, folder);
  const [settings, setSettings] = useState(false);
  const title = node?.name || mount.name;
  useDetail(folder ? title : null);
  const done = mount.files - mount.pending;
  return (
    <section className="flex flex-col gap-4 pb-20">
      <div className="flex flex-col gap-1.5 px-1">
        {folder ? <Crumbs mount={mount} path={folder} onOpen={onOpen} /> : null}
        <div className="flex items-center gap-3">
          <h1 className="min-w-0 flex-1 truncate font-display font-semibold text-xl">{title}</h1>
          {mount.status === "away" ? (
            <Chip tone="warn">{t("dateien.away")}</Chip>
          ) : mount.status === "scanning" || mount.pending ? (
            <Chip tone="ember">{t("dateien.reading")}</Chip>
          ) : (
            <Chip tone="live">{t("dateien.current")}</Chip>
          )}
          <IconButton label={t("dateien.rescan")} onClick={() => void actions.rescan(mount.id)}>
            <RefreshCw className="size-4" />
          </IconButton>
          {admin ? (
            <IconButton label={t("dateien.settings")} onClick={() => setSettings(true)}>
              <Settings2 className="size-4" />
            </IconButton>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[0.8125rem] text-ink-3">
          <span className="truncate">{mount.where}</span>
          <span>
            {t("dateien.count", { files: mount.files.toLocaleString(lang) })} ·{" "}
            {formatBytes(mount.bytes)}
          </span>
          <span>{t("dateien.readOnly")}</span>
        </div>
        {mount.status === "away" ? (
          <p className="text-[0.8125rem] text-ink-2">{t("dateien.awayText")}</p>
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
          <p className="text-[0.8125rem] text-ink-3">
            {t("dateien.vectors", { count: mount.vectorsPending.toLocaleString(lang) })}
          </p>
        ) : null}
      </div>
      {!files.data ? (
        <div className="flex h-40 items-center justify-center text-ink-3">
          <Spinner />
        </div>
      ) : !node || (!node.folders.length && !node.files.length) ? (
        <p className="px-1 py-6 text-[0.875rem] text-ink-3">{t("dateien.emptyFolder")}</p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-3">
          {node.folders.map((f) => (
            <button
              key={f.path}
              type="button"
              onClick={() => onOpen(`d:${mount.id}/${f.path}`)}
              className="flex min-w-0 flex-col gap-1.5 text-left"
            >
              <span className="grid aspect-square place-items-center rounded-xl bg-paper-2 ring-1 ring-border-soft transition hover:ring-border">
                <Folder className="size-8 text-ink-3" />
              </span>
              <span className="truncate font-medium text-[0.8125rem]">{f.name}</span>
              <span className="text-[0.75rem] text-ink-3">
                {t("dateien.count", { files: f.count.toLocaleString(lang) })}
              </span>
            </button>
          ))}
          {node.files.map((f) => {
            const chips = knowledge.data
              ? chipsOf({ categories: f.categories } as KnowledgeItem, knowledge.data.categories)
              : [];
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => onOpen(`m:${f.id}`)}
                className="flex min-w-0 flex-col gap-1.5 text-left"
              >
                {f.thumb ? (
                  <img
                    src={mountThumbUrl(spaceId, f.id)}
                    alt=""
                    loading="lazy"
                    className="aspect-square w-full rounded-xl bg-paper-2 object-cover ring-1 ring-border-soft transition hover:ring-border"
                  />
                ) : (
                  <span className="grid aspect-square place-items-center rounded-xl bg-paper-2 font-semibold text-[0.8125rem] text-ink-3 ring-1 ring-border-soft transition hover:ring-border">
                    {f.status === "pending" ? <Spinner /> : typeOf(f)}
                  </span>
                )}
                <span className="truncate text-[0.8125rem]">{f.name}</span>
                {chips.length ? (
                  <span className="flex flex-wrap gap-1">
                    {chips.map((c) => (
                      <Chip key={c}>{c}</Chip>
                    ))}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
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

function Progress({ done, total, line }: { done: number; total: number; line: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="h-1.5 overflow-hidden rounded-full bg-paper-2">
        <div
          className="h-full rounded-full bg-ember transition-[width]"
          style={{ width: `${total ? Math.round((done / total) * 100) : 0}%` }}
        />
      </div>
      <p className="text-[0.8125rem] text-ink-3">{line}</p>
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
  const url = mountFileUrl(spaceId, file.id);
  const kind = viewerKind(file.mime, file.name);
  const folder = file.path.split("/").slice(0, -1).join("/");
  useDetail(file.name);
  return (
    <section className="flex flex-col gap-4 pb-20">
      <div className="flex flex-col gap-1.5 px-1">
        <Crumbs mount={mount} path={folder} onOpen={onOpen} />
        <div className="flex items-center gap-2">
          <h1 className="min-w-0 flex-1 truncate font-display font-semibold text-xl">
            {file.name}
          </h1>
          <span className="text-[0.8125rem] text-ink-3 max-sm:hidden">
            {[file.pages ? t("space.pages", { n: file.pages }) : null, formatBytes(file.size)]
              .filter(Boolean)
              .join(" · ")}
          </span>
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            aria-label={t("space.openOriginal")}
            title={t("space.openOriginal")}
            className="inline-flex size-9 items-center justify-center rounded-full text-ink-3 transition hover:bg-accent hover:text-ink"
          >
            <ExternalLink className="size-4" />
          </a>
        </div>
      </div>
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
      <Card className="flex flex-col">
        {kind && mount.status !== "away" ? (
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
            {mount.status === "away" ? t("dateien.awayText") : t("dateien.noPreview")}
          </p>
        )}
      </Card>
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
        <Select
          value={see}
          onChange={(v) => onSee(v as MountSee)}
          options={[
            { value: "all", label: t("dateien.seeAll") },
            { value: "admins", label: t("dateien.seeAdmins") },
          ]}
        />
        <p className="mt-1 text-[0.8125rem] text-ink-3">
          {see === "all" ? t("dateien.seeAllLine") : t("dateien.seeAdminsLine")}
        </p>
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
  const [path, setPath] = useState("");
  const [suggest, setSuggest] = useState<string[]>([]);
  const [noDialog, setNoDialog] = useState(false);
  const [found, setFound] = useState<FolderPreview | null>(null);
  const [byFolder, setByFolder] = useState(true);
  const [category, setCategory] = useState("");
  const [see, setSee] = useState<MountSee>("all");
  const [wizards, setWizards] = useState<MountWizards>("all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Opened again, it starts anew.
  useEffect(() => {
    if (open) {
      setPath("");
      setFound(null);
      setError(null);
      setSee("all");
      setWizards("all");
      setByFolder(true);
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
      setCategory(preview.name);
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
  const values = found?.first.map((f) => f.name) ?? [];
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={
        found
          ? found.complete
            ? t("dateien.found", {
                files: found.files.toLocaleString(lang),
                folders: found.folders.toLocaleString(lang),
                size: formatBytes(found.bytes),
              })
            : t("dateien.foundAtLeast", { files: found.files.toLocaleString(lang) })
          : t("dateien.mount")
      }
    >
      {!found ? (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (path.trim()) {
              void review(path.trim());
            }
          }}
        >
          <p className="-mt-2 text-[0.875rem] text-ink-2">{t("dateien.chooseText")}</p>
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
          {noDialog ? <p className="text-[0.8125rem] text-ink-3">{t("dateien.noDialog")}</p> : null}
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
                <li key={f.name} className="flex items-center gap-2 px-1.5 py-1 text-[0.8125rem]">
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
          {values.length ? (
            <div className="flex flex-col gap-2 rounded-lg p-3 ring-1 ring-border-soft">
              <label className="flex items-center justify-between gap-3 text-[0.875rem]">
                <span className="font-medium">{t("dateien.byFolder")}</span>
                <Switch checked={byFolder} onChange={setByFolder} />
              </label>
              {byFolder ? (
                <>
                  <Input
                    value={category}
                    maxLength={60}
                    aria-label={t("dateien.categoryName")}
                    onChange={(e) => setCategory(e.target.value)}
                  />
                  <span className="text-[0.8125rem] text-ink-3">
                    {t("dateien.byFolderHint", {
                      name: category,
                      values: values.slice(0, 4).join(", ") + (values.length > 4 ? " …" : ""),
                    })}
                  </span>
                </>
              ) : null}
            </div>
          ) : null}
          <AccessFields
            spaceId={spaceId}
            see={see}
            wizards={wizards}
            onSee={setSee}
            onWizards={setWizards}
          />
          {error ? <p className="text-[0.875rem] text-rose">{error}</p> : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setFound(null)}>
              {t("common.back")}
            </Button>
            <Button
              busy={busy}
              onClick={() =>
                void run(async () => {
                  const mount = await actions.create({
                    path: found.path,
                    see,
                    wizards,
                    folderCategory:
                      byFolder && values.length && category.trim() ? category.trim() : null,
                  });
                  onMounted(mount.id);
                })
              }
            >
              {t("dateien.mountButton")}
            </Button>
          </div>
        </div>
      )}
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
  const [name, setName] = useState("");
  const [see, setSee] = useState<MountSee>("all");
  const [wizards, setWizards] = useState<MountWizards>("all");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (access.data) {
      setName(access.data.name);
      setSee(access.data.see);
      setWizards(access.data.wizards);
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
          <div className="flex items-center justify-between gap-2">
            <Button
              variant="ghost"
              className="text-rose"
              onClick={async () => {
                if (confirm(t("dateien.removeConfirm", { name: mount.name }))) {
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
                try {
                  await actions.update(mount.id, { name, see, wizards });
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
