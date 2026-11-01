import { Markdown } from "@engenty/wizards-runner";
import type { SpacePage } from "@engenty/wizards-shared/space-data";
import { mergeText } from "@engenty/wizards-shared/text-merge";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronRight, FileText, GitMerge, Palette, Plus, Trash2 } from "lucide-react";
import { lazy, type MouseEvent, Suspense, useEffect, useRef, useState } from "react";
import { ApiError, api } from "../../lib/api";
import { useFeature } from "../../lib/features";
import { t } from "../../lib/i18n";
import { keys } from "../../lib/keys";
import { useMe } from "../../lib/session";
import { askConfirm, Button, Card, Chip, cn, IconButton, Spinner } from "../../ui";
import { CodeEditor } from "../../ui/code-editor";
import { SyncNotice } from "../CloudSync";
import { LiveConflict, type LiveEditor, useLiveEditor } from "../live/editor";
import {
  PresenceStack,
  presenceColor,
  presenceLine,
  useAlsoHere,
  useEditingOthers,
} from "../live/PresenceStack";
import { useReportPresence } from "../live/presence";
import type { Target } from "./blocks/targets";
import {
  type Autosave,
  fileUrl,
  thumbUrl,
  useAutosave,
  useFileActions,
  useSpaceFiles,
} from "./data";
import { KnowledgeHeader, useKnowledge } from "./Knowledge";
import { SourceItemNotice } from "./sources";
import { TableEmbed } from "./TableEmbed";

// TipTap is large: it loads with the first page written in blocks.
const BlockEditor = lazy(() =>
  import("./blocks/BlockEditor").then((m) => ({ default: m.BlockEditor })),
);

/** The page once it is loaded: its title and text, saved a moment after they stop changing. */
function Editor({
  page,
  onGone,
  onOpen,
}: {
  page: SpacePage;
  onGone: () => void;
  onOpen?: (key: string) => void;
}) {
  const qc = useQueryClient();
  const [title, setTitle] = useState(page.title);
  const [markdown, setMarkdown] = useState(page.markdown);
  // With the block editor a page opens in it, written or not: blocks look like the text read.
  // Without it an empty page opens to be written, a written one to be read.
  const blocks = useFeature("knowledgeTree");
  const [view, setView] = useState<"write" | "markdown" | "read" | "original">(
    blocks || !page.markdown ? "write" : "read",
  );
  const know = page.knowledge;
  const me = useMe().data?.user.id;
  // Who else is here, and where this tab writes: the heading above the caret.
  const [typing, setTyping] = useState(false);
  const [place, setPlace] = useState<{ id: string; label: string } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: each keystroke starts the 10 s again.
  useEffect(() => {
    if (!typing) {
      return;
    }
    const timer = setTimeout(() => setTyping(false), 10_000);
    return () => clearTimeout(timer);
  }, [typing, markdown, title]);
  useReportPresence("page", page.id, {
    state: typing ? "editing" : "viewing",
    place: place?.id,
    placeLabel: place?.label,
  });
  const alsoHere = useAlsoHere("page", page.id, me, typing ? place?.id : null);
  const editingOthers = useEditingOthers("page", page.id, me);
  // The section each of them writes in, marked beside its heading.
  const marks = editingOthers
    .filter((e) => e.place?.startsWith("h:") && e.placeLabel)
    .map((e) => ({
      heading: e.placeLabel ?? "",
      color: presenceColor(e.who),
      title: presenceLine(e),
    }));
  const where = (text: string, at: number) => {
    const head = headingAt(text, at);
    setPlace((was) => (was?.id === head?.id ? was : head));
  };
  const listed = async () => {
    await qc.invalidateQueries({ queryKey: keys.spaceData(page.spaceId) });
    await qc.invalidateQueries({ queryKey: keys.knowledge(page.spaceId) });
  };
  type Text = { title: string; markdown: string };
  // ⌘S / Ctrl+S saves at once: the page saves as it goes, and the keys say "now".
  const save = useRef(() => {});
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        save.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const status: Autosave<Text> = useAutosave<Text>(
    { title: title.trim() || page.title, markdown },
    (text) => live.save(text),
  );
  save.current = status.saveNow;
  // Changes from elsewhere: shown at once, or merged into the next save (studio/live/editor.ts).
  const live: LiveEditor<Text> = useLiveEditor<Text>({
    kind: "page",
    id: page.id,
    initial: { value: { title: page.title, markdown: page.markdown }, at: page.updatedAt },
    fromView: (view) => {
      const p = view as SpacePage;
      return { value: { title: p.title, markdown: p.markdown }, at: p.updatedAt };
    },
    merge: (base, mine, theirs) => {
      const body = mergeText(base.markdown, mine.markdown, theirs.markdown);
      const title =
        mine.title === theirs.title || theirs.title === base.title
          ? mine.title
          : mine.title === base.title
            ? theirs.title
            : null;
      return {
        value: { title: title ?? mine.title, markdown: body.text },
        clean: body.clean && title !== null,
      };
    },
    same: (a, b) => a.title === b.title && a.markdown === b.markdown,
    surface: {
      apply: (text) => {
        setTitle(text.title);
        setMarkdown(text.markdown);
        status.markSaved(text);
        qc.setQueryData<SpacePage>(keys.page(page.id), (old) => (old ? { ...old, ...text } : old));
      },
      hasUnsavedEdits: () => status.pending(),
      saveNow: () => status.saveNow(),
    },
    send: async (text, baseAt) => {
      try {
        const { updatedAt } = await api.patch<{ updatedAt: string }>(
          `/api/studio/pages/${page.id}`,
          { ...text, baseUpdatedAt: baseAt },
        );
        // Opened again later, the page shows what was saved.
        qc.setQueryData<SpacePage>(keys.page(page.id), (old) =>
          old ? { ...old, ...text, updatedAt } : old,
        );
        if (text.title !== page.title) {
          await listed();
        }
        return updatedAt;
      } catch (err) {
        const now =
          err instanceof ApiError && err.status === 409
            ? (err.body as { page?: SpacePage } | null)?.page
            : null;
        if (now) {
          throw new LiveConflict({
            value: { title: now.title, markdown: now.markdown },
            at: now.updatedAt,
          });
        }
        throw err;
      }
    },
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/api/studio/pages/${page.id}`),
    onSuccess: async () => {
      await listed();
      onGone();
    },
  });
  const sub = useMutation({
    mutationFn: () =>
      api.post<{ id: string }>(`/api/studio/spaces/${page.spaceId}/pages`, {
        title: t("know.addSub"),
        parentId: page.id,
      }),
    onSuccess: async ({ id }) => {
      await listed();
      onOpen?.(`p:${id}`);
    },
  });
  const reviewed = useMutation({
    mutationFn: () => api.patch(`/api/studio/pages/${page.id}`, { review: null }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.page(page.id) }),
  });
  // A link to another page of Knowledge (`pages/…`) opens it here.
  // A link to a page, table or file of Knowledge (`pages/…`, `tables/…`, `files/…`) opens it
  // here: clicked in the preview, or Cmd/Ctrl+clicked while writing.
  const open = async (href: string) => {
    const key = onOpen ? await knowledgeKeyOf(page.spaceId, href) : null;
    if (key) {
      onOpen?.(key);
    }
  };
  const follow = (e: MouseEvent) => {
    const href = (e.target as HTMLElement).closest("a")?.getAttribute("href");
    if (href && KNOWLEDGE_PATH.test(href) && onOpen) {
      e.preventDefault();
      void open(href);
    }
  };
  // What a link's address may name, offered while writing it.
  const knowledge = useKnowledge(page.spaceId);
  const spaceFiles = useSpaceFiles(page.spaceId);
  const knowledgeItems = knowledge.data?.items;
  const links = (knowledgeItems ?? [])
    .filter((i) => i.id !== page.id)
    .map((i) => ({ title: i.title, path: i.path, kind: t(KIND_WORD[i.kind]) }));
  // What a source wrote is the source's until a person takes it over.
  const fromSource = blocks && Boolean(know?.origin?.startsWith("source:")) && !know?.kept;
  const readOnly = page.readOnly || fromSource;
  // What a page can link to and show, by the paths steps name them by.
  const targets: Target[] = (knowledgeItems ?? []).map((i) => ({
    path: i.path,
    title: i.title,
    kind: i.kind === "file" && IMAGE_PATH.test(i.path) ? "image" : i.kind,
  }));
  // A picture's `files/<name>`: a file of Wissen, also one a page was read from (it stands behind
  // the page in the list, and a step still reads it by that path).
  const byName = new Map(
    (spaceFiles.data?.files ?? [])
      .filter((f) => f.kind === "document")
      .map((f) => [`files/${f.name.replace(/[/\\]/g, "-")}`.toLowerCase(), f.id]),
  );
  const resolve = (src: string) => {
    const copy = ASSET_REF.exec(src);
    if (copy) {
      return fileUrl(page.spaceId, copy[1]);
    }
    const id = byName.get(src.toLowerCase());
    return id ? fileUrl(page.spaceId, id) : src;
  };
  const files = useFileActions(page.spaceId, readOnly);
  // Files dropped or picked go into Wissen; the page links to them by their paths.
  const onFiles = async (picked: File[]) => {
    const taken = await files.upload("document", picked);
    const items = (await knowledge.refetch()).data?.items ?? [];
    await spaceFiles.refetch();
    return taken
      .map((f) => {
        // A picture is shown as itself, also once a page is read from it.
        const item = items.find((i) => i.key === `f:${f.id}`);
        const path = item?.path ?? `files/${f.name.replace(/[/\\]/g, "-")}`;
        const words = (item?.title ?? f.name).replace(/[[\]]/g, "\\$&");
        return `${f.mime.startsWith("image/") ? "!" : ""}[${words}](${path})`;
      })
      .join("\n\n");
  };
  const original =
    know?.file && (know.file.mime === "application/pdf" || know.file.mime.startsWith("image/"))
      ? know.file
      : null;
  const tab = (id: typeof view, label: string) => (
    <button
      type="button"
      aria-pressed={view === id}
      onClick={() => setView(id)}
      className={cn(
        "rounded-full px-3 py-1 text-[0.8125rem] transition",
        view === id ? "bg-paper-2 font-medium text-ink" : "text-ink-3 hover:text-ink",
      )}
    >
      {label}
    </button>
  );
  return (
    <section className="flex flex-col gap-3">
      {know?.parents.length && onOpen ? (
        <nav className="-mb-2 flex flex-wrap items-center gap-1 px-1 text-[0.75rem] text-ink-4">
          {know.parents.map((p) => (
            <span key={p.id} className="inline-flex items-center gap-1">
              <button type="button" onClick={() => onOpen(`p:${p.id}`)} className="hover:text-ink">
                {p.title}
              </button>
              <ChevronRight className="size-3" />
            </span>
          ))}
        </nav>
      ) : null}
      <div className="flex items-center gap-2 px-1">
        <input
          value={title}
          disabled={readOnly}
          maxLength={200}
          onChange={(e) => {
            setTitle(e.target.value);
            setTyping(true);
          }}
          aria-label={t("data.title")}
          className="-ml-1 min-w-0 flex-1 rounded-md bg-transparent px-1 font-display font-semibold text-[1.75rem] leading-tight tracking-tight outline-none hover:bg-accent focus:bg-paper focus:ring-1 focus:ring-ring disabled:hover:bg-transparent"
        />
        {live.notice === "merged" ? (
          <Chip icon={<GitMerge className="size-3" />}>
            {editingOthers[0]
              ? t("editor.mergedWith", { name: editingOthers[0].name })
              : t("editor.merged")}
          </Chip>
        ) : null}
        <PresenceStack kind="page" item={page.id} me={me} />
        {live.notice === "conflict" || readOnly ? null : (
          <SaveState state={status.state} error={status.error} onRetry={status.saveNow} />
        )}
        {readOnly ? null : (
          <IconButton
            label={t("data.deletePage")}
            onClick={async () =>
              (await askConfirm(t("data.confirmDelete", { title: page.title }))) && remove.mutate()
            }
            className="hover:text-rose"
          >
            <Trash2 className="size-4" />
          </IconButton>
        )}
      </div>
      {alsoHere && live.notice !== "conflict" ? (
        <p className="-mt-1 px-1 text-[0.8125rem] text-ink-3">
          {t("presence.alsoHere", { name: alsoHere.name })}
        </p>
      ) : null}
      {live.notice === "conflict" ? (
        <div
          role="status"
          className="flex flex-wrap items-center gap-2 rounded-lg bg-paper-2 px-3 py-2 text-[0.8125rem]"
        >
          <GitMerge className="size-4 shrink-0 text-ink-3" />
          <span className="min-w-0 flex-1">{t("data.changedElsewhere")}</span>
          <Button size="sm" variant="ghost" onClick={live.takeTheirs}>
            {t("data.takeTheirs")}
          </Button>
          <Button size="sm" onClick={live.keepMine}>
            {t("data.keepMine")}
          </Button>
        </div>
      ) : null}
      {fromSource ? (
        <SourceItemNotice
          spaceId={page.spaceId}
          itemKey={`p:${page.id}`}
          label={know?.originLabel ?? ""}
          readOnly={page.readOnly}
        />
      ) : null}
      {know ? (
        <KnowledgeHeader
          spaceId={page.spaceId}
          itemKey={`p:${page.id}`}
          has={know.categories}
          // The notice above names the source already.
          originLabel={fromSource ? null : know.originLabel}
          kept={know.kept}
          review={know.review}
          file={original ? null : know.file}
          readOnly={readOnly}
          onReviewed={() => reviewed.mutate()}
        />
      ) : null}
      <Card className="flex flex-col">
        {/* Writing in blocks, the switch stands at the end of the editor's toolbar. */}
        {(readOnly && !original) || (blocks && view === "write" && !readOnly) ? null : blocks ? (
          <div className="flex items-center gap-1 border-border-soft border-b px-2 py-1.5">
            {tab("write", readOnly ? t("data.preview") : t("data.write"))}
            {readOnly ? null : tab("markdown", t("blocks.markdown"))}
            {original ? tab("original", t("know.original")) : null}
            <span className="ml-auto truncate px-2 text-[0.75rem] text-ink-4 max-sm:hidden">
              {view === "original" && original
                ? original.name
                : view === "markdown"
                  ? t("data.markdownHint")
                  : readOnly
                    ? null
                    : t("blocks.hint")}
            </span>
          </div>
        ) : (
          <div className="flex items-center gap-1 border-border-soft border-b px-2 py-1.5">
            {readOnly ? null : tab("write", t("data.write"))}
            {tab("read", t("data.preview"))}
            {original ? tab("original", t("know.original")) : null}
            <span className="ml-auto truncate px-2 text-[0.75rem] text-ink-4 max-sm:hidden">
              {view === "original" && original ? original.name : t("data.markdownHint")}
            </span>
          </div>
        )}
        {view === "original" && original ? (
          original.mime === "application/pdf" ? (
            <iframe
              src={fileUrl(page.spaceId, original.id)}
              title={original.name}
              className="h-[70dvh] w-full rounded-b-xl bg-paper-2"
            />
          ) : (
            <img
              src={fileUrl(page.spaceId, original.id)}
              alt=""
              className="mx-auto max-h-[70dvh] object-contain p-4"
            />
          )
        ) : blocks && view === "write" ? (
          // Blocks for writing and reading alike; a change from elsewhere replaces only the
          // blocks it touched (blocks/BlockEditor.tsx).
          <Suspense fallback={<Spinner className="m-5 size-4 text-ink-3" />}>
            <BlockEditor
              text={markdown}
              onChange={(next) => {
                setMarkdown(next);
                setTyping(true);
              }}
              readOnly={readOnly}
              targets={targets}
              self={know?.path}
              onFiles={readOnly ? undefined : onFiles}
              resolve={resolve}
              onOpen={(href) => void open(href)}
              embed={{
                test: (href) => href.startsWith("tables/"),
                render: (href) => <TableEmbed spaceId={page.spaceId} href={href} onOpen={onOpen} />,
              }}
              onHeading={(head) => setPlace((was) => (was?.id === head?.id ? was : head))}
              marks={marks}
              ariaLabel={page.title}
              tools={
                readOnly ? undefined : (
                  <>
                    {tab("write", t("data.write"))}
                    {tab("markdown", t("blocks.markdown"))}
                    {original ? tab("original", t("know.original")) : null}
                  </>
                )
              }
            />
          </Suspense>
        ) : (view === "write" || view === "markdown") && !readOnly ? (
          // A change from elsewhere arrives as `markdown` and is applied as the smallest
          // change: the caret stays, and undo leaves it alone (ui/code-editor).
          <CodeEditor
            value={markdown}
            onChange={(next) => {
              setMarkdown(next);
              setTyping(true);
            }}
            onCaret={where}
            marks={marks}
            links={links}
            onLink={(href) => void open(href)}
            language="markdown"
            ariaLabel={page.title}
            placeholder={t("data.pageEmpty")}
            className="min-h-[50vh] [&_.cm-editor]:min-h-[50vh] sm:[&_.cm-content]:py-5 sm:[&_.cm-line]:px-5"
          />
        ) : (
          <div className="min-h-40 p-4 sm:p-5" onClick={follow}>
            {markdown.trim() ? (
              <Markdown
                text={markdown.replace(/asset:\/\/([A-Za-z0-9_-]{6,40})/g, (_, id: string) =>
                  fileUrl(page.spaceId, id),
                )}
              />
            ) : (
              <p className="text-[0.875rem] text-ink-3">{t("data.pageEmpty")}</p>
            )}
          </div>
        )}
      </Card>
      {status.state === "error" && status.error ? (
        <p className="px-1 text-[0.875rem] text-rose">{status.error}</p>
      ) : null}
      <PagePictures spaceId={page.spaceId} markdown={markdown} />
      {know && onOpen && (know.children.length || !readOnly) ? (
        <div className="mt-3 flex flex-col gap-1.5">
          <div className="flex items-center justify-between px-1">
            <p className="font-medium text-[0.6875rem] text-ink-4 uppercase tracking-[0.12em]">
              {know.children.length ? t("know.subPages") : null}
            </p>
            {readOnly ? null : (
              <Button variant="ghost" size="sm" busy={sub.isPending} onClick={() => sub.mutate()}>
                <Plus className="size-4" /> {t("know.addSub")}
              </Button>
            )}
          </div>
          {know.children.length ? (
            <Card className="flex flex-col p-1.5">
              {know.children.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => onOpen(`p:${c.id}`)}
                  className="flex items-center gap-3 rounded-lg px-3 py-2 text-left transition hover:bg-accent"
                >
                  <FileText className="size-4 shrink-0 text-ink-3" />
                  <span className="min-w-0 flex-1 truncate text-[0.875rem]">{c.title}</span>
                </button>
              ))}
            </Card>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/** A copy of a picture in the space, as a page points at it. */
const ASSET_REF = /^asset:\/\/([A-Za-z0-9_-]{6,40})$/;

/** The pictures a page shows from the space (`![alt](asset://ID)`), each once. */
function picturesOf(markdown: string): { id: string; alt: string }[] {
  const out = new Map<string, string>();
  for (const m of markdown.matchAll(/!\[([^\]\n]*)\]\(asset:\/\/([A-Za-z0-9_-]{6,40})\)/g)) {
    if (!out.has(m[2])) {
      out.set(m[2], m[1].trim());
    }
  }
  return [...out].map(([id, alt]) => ({ id, alt }));
}

/** „Bilder“: the pictures the page shows, each one to take into the brand. */
function PagePictures({ spaceId, markdown }: { spaceId: string; markdown: string }) {
  const qc = useQueryClient();
  const media = useFeature("knowledgeMedia");
  const [taken, setTaken] = useState<string[]>([]);
  const take = useMutation({
    mutationFn: (id: string) => api.post(`/api/studio/spaces/${spaceId}/files/${id}/brand`, {}),
    onSuccess: async (_, id) => {
      setTaken((was) => [...was, id]);
      await qc.invalidateQueries({ queryKey: keys.files(spaceId) });
    },
  });
  const pictures = picturesOf(markdown);
  if (!media || !pictures.length) {
    return null;
  }
  return (
    <div className="mt-3 flex flex-col gap-1.5">
      <p className="px-1 font-medium text-[0.6875rem] text-ink-4 uppercase tracking-[0.12em]">
        {t("know.pictures")}
      </p>
      <div className="flex gap-3 overflow-x-auto px-1 pb-1">
        {pictures.map((p) => (
          <figure key={p.id} className="flex w-40 shrink-0 flex-col gap-1.5">
            <a href={fileUrl(spaceId, p.id)} target="_blank" rel="noreferrer">
              <img
                src={thumbUrl(spaceId, p.id)}
                alt={p.alt}
                loading="lazy"
                className="aspect-[4/3] w-full rounded-lg bg-paper-2 object-cover"
              />
            </a>
            {p.alt ? (
              <figcaption className="truncate text-[0.75rem] text-ink-3">{p.alt}</figcaption>
            ) : null}
            {taken.includes(p.id) ? (
              <span className="inline-flex items-center gap-1 text-[0.75rem] text-moss">
                <Check className="size-3.5" /> {t("know.inBrand")}
              </span>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                busy={take.isPending && take.variables === p.id}
                onClick={() => take.mutate(p.id)}
                className="self-start"
              >
                <Palette className="size-3.5" /> {t("know.toBrand")}
              </Button>
            )}
          </figure>
        ))}
      </div>
      {take.error ? (
        <p className="px-1 text-[0.8125rem] text-rose">{(take.error as Error).message}</p>
      ) : null}
    </div>
  );
}

/** A page of the space: a title and markdown, written and read in place. */
export function PageEditor({
  pageId,
  onGone,
  onOpen,
}: {
  pageId: string;
  onGone: () => void;
  /** Opens another item of Knowledge: a parent, a sub-page, a page a link names. */
  onOpen?: (key: string) => void;
}) {
  const page = useQuery({
    queryKey: keys.page(pageId),
    queryFn: () => api.get<SpacePage>(`/api/studio/pages/${pageId}`),
    // What the person writes is the truth while the page is open.
    refetchOnWindowFocus: false,
  });
  if (!page.data) {
    return page.isError ? (
      <p className="text-[0.875rem] text-rose">{(page.error as Error).message}</p>
    ) : null;
  }
  return (
    <>
      <SyncNotice kind="page" item={pageId} />
      <Editor key={page.data.id} page={page.data} onGone={onGone} onOpen={onOpen} />
    </>
  );
}

/** The heading above a place in the text: the section someone writes in. */
function headingAt(text: string, at: number): { id: string; label: string } | null {
  const before = text.slice(0, at).split("\n");
  for (let i = before.length - 1; i >= 0; i--) {
    const m = /^#{1,6}\s+(.+?)\s*#*$/.exec(before[i] ?? "");
    if (m?.[1]) {
      return { id: `h:${m[1].toLowerCase()}`, label: m[1] };
    }
  }
  return null;
}

const KNOWLEDGE_PATH = /^(pages|tables|files)\//;
const IMAGE_PATH = /\.(png|jpe?g|gif|webp|avif|svg)$/i;
const KIND_WORD = {
  page: "know.kind.page",
  table: "know.kind.table",
  file: "know.kind.file",
} as const;

/** The item of Knowledge a link names (`pages/…`, `tables/…`, `files/…`): `p:`, `t:` or `f:`. */
async function knowledgeKeyOf(spaceId: string, href: string): Promise<string | null> {
  if (!KNOWLEDGE_PATH.test(href)) {
    return null;
  }
  const found = await api
    .get<{ kind: "page" | "table" | "file"; id: string }>(
      `/api/studio/spaces/${spaceId}/resolve?path=${encodeURIComponent(href)}`,
    )
    .catch(() => null);
  return found ? `${found.kind[0]}:${found.id}` : null;
}

/**
 * Whether the page's last change is saved, in words beside the title: the page saves a moment
 * after typing stops, ⌘S at once. A failed save says why and can be tried again.
 */
function SaveState({
  state,
  error,
  onRetry,
}: {
  state: "idle" | "saving" | "saved" | "error";
  error: string | null;
  onRetry: () => void;
}) {
  if (state === "error") {
    return (
      <span
        className="inline-flex items-center gap-1.5 text-[0.75rem] text-rose"
        title={error ?? ""}
      >
        {t("editor.notSaved")}
        <button type="button" onClick={onRetry} className="underline hover:no-underline">
          {t("editor.retrySave")}
        </button>
      </span>
    );
  }
  if (state === "idle") {
    return null;
  }
  return (
    <span
      className="inline-flex items-center gap-1.5 text-[0.75rem] text-ink-3"
      title={t("editor.saveHint")}
    >
      {state === "saving" ? (
        <Spinner className="size-3" />
      ) : (
        <Check className="size-3.5 text-moss" />
      )}
      {state === "saving" ? t("editor.saving") : t("settings.saved")}
    </span>
  );
}
