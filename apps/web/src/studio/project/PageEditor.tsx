import { Markdown } from "@engenty/wizards-runner";
import type { SpacePage } from "@engenty/wizards-shared/space-data";
import { mergeText } from "@engenty/wizards-shared/text-merge";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronRight, FileText, GitMerge, Plus, Trash2 } from "lucide-react";
import { type MouseEvent, useEffect, useState } from "react";
import { ApiError, api } from "../../lib/api";
import { t } from "../../lib/i18n";
import { keys } from "../../lib/keys";
import { useMe } from "../../lib/session";
import { Button, Card, Chip, cn, IconButton, Spinner } from "../../ui";
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
import { type Autosave, fileUrl, useAutosave } from "./data";
import { KnowledgeHeader, useKnowledge } from "./Knowledge";

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
  // An empty page opens to be written; a written one opens to be read.
  const [view, setView] = useState<"write" | "read" | "original">(page.markdown ? "read" : "write");
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
    await qc.invalidateQueries({ queryKey: keys.spaceData(page.projectId) });
    await qc.invalidateQueries({ queryKey: keys.knowledge(page.projectId) });
  };
  type Text = { title: string; markdown: string };
  const status: Autosave<Text> = useAutosave<Text>(
    { title: title.trim() || page.title, markdown },
    (text) => live.save(text),
  );
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
      api.post<{ id: string }>(`/api/studio/projects/${page.projectId}/pages`, {
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
    const key = onOpen ? await knowledgeKeyOf(page.projectId, href) : null;
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
  const knowledgeItems = useKnowledge(page.projectId).data?.items;
  const links = (knowledgeItems ?? [])
    .filter((i) => i.id !== page.id)
    .map((i) => ({ title: i.title, path: i.path, kind: t(KIND_WORD[i.kind]) }));
  const readOnly = page.readOnly;
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
        <nav className="-mb-1.5 flex flex-wrap items-center gap-1 px-1 text-[0.8125rem] text-ink-3">
          {know.parents.map((p) => (
            <span key={p.id} className="inline-flex items-center gap-1">
              <button type="button" onClick={() => onOpen(`p:${p.id}`)} className="hover:text-ink">
                {p.title}
              </button>
              <ChevronRight className="size-3.5" />
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
          className="-ml-1 min-w-0 flex-1 rounded-md bg-transparent px-1 font-display font-semibold text-lg outline-none hover:bg-accent focus:bg-paper focus:ring-1 focus:ring-ring disabled:hover:bg-transparent"
        />
        {live.notice === "merged" ? (
          <Chip icon={<GitMerge className="size-3" />}>
            {editingOthers[0]
              ? t("editor.mergedWith", { name: editingOthers[0].name })
              : t("editor.merged")}
          </Chip>
        ) : null}
        <PresenceStack kind="page" item={page.id} me={me} />
        {live.notice === "conflict" ? null : status.state === "saving" ? (
          <Spinner className="size-3.5 text-ink-3" />
        ) : status.state === "saved" ? (
          <Check className="size-4 text-moss" aria-label={t("settings.saved")} />
        ) : null}
        {readOnly ? null : (
          <IconButton
            label={t("data.deletePage")}
            onClick={() =>
              confirm(t("data.confirmDelete", { title: page.title })) && remove.mutate()
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
      {know ? (
        <KnowledgeHeader
          projectId={page.projectId}
          itemKey={`p:${page.id}`}
          has={know.categories}
          originLabel={know.originLabel}
          kept={know.kept}
          review={know.review}
          file={original ? null : know.file}
          readOnly={readOnly}
          onReviewed={() => reviewed.mutate()}
        />
      ) : null}
      <Card className="flex flex-col">
        {readOnly && !original ? null : (
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
              src={fileUrl(page.projectId, original.id)}
              title={original.name}
              className="h-[70dvh] w-full rounded-b-xl bg-paper-2"
            />
          ) : (
            <img
              src={fileUrl(page.projectId, original.id)}
              alt=""
              className="mx-auto max-h-[70dvh] object-contain p-4"
            />
          )
        ) : view === "write" && !readOnly ? (
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
              <Markdown text={markdown} />
            ) : (
              <p className="text-[0.875rem] text-ink-3">{t("data.pageEmpty")}</p>
            )}
          </div>
        )}
      </Card>
      {status.state === "error" && status.error ? (
        <p className="px-1 text-[0.875rem] text-rose">{status.error}</p>
      ) : null}
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
const KIND_WORD = {
  page: "know.kind.page",
  table: "know.kind.table",
  file: "know.kind.file",
} as const;

/** The item of Knowledge a link names (`pages/…`, `tables/…`, `files/…`): `p:`, `t:` or `f:`. */
async function knowledgeKeyOf(projectId: string, href: string): Promise<string | null> {
  if (!KNOWLEDGE_PATH.test(href)) {
    return null;
  }
  const found = await api
    .get<{ kind: "page" | "table" | "file"; id: string }>(
      `/api/studio/projects/${projectId}/resolve?path=${encodeURIComponent(href)}`,
    )
    .catch(() => null);
  return found ? `${found.kind[0]}:${found.id}` : null;
}
