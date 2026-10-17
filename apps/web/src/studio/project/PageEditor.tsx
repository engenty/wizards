import { Markdown } from "@engenty-wizards/runner";
import type { SpacePage } from "@engenty-wizards/shared/space-data";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronRight, FileText, Plus, Trash2 } from "lucide-react";
import { type MouseEvent, useState } from "react";
import { api } from "../../lib/api";
import { t } from "../../lib/i18n";
import { Button, Card, cn, IconButton, Spinner } from "../../ui";
import { fileUrl, useAutosave } from "./data";
import { KnowledgeHeader } from "./Knowledge";

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
  const listed = async () => {
    await qc.invalidateQueries({ queryKey: ["space-data", page.projectId] });
    await qc.invalidateQueries({ queryKey: ["knowledge", page.projectId] });
  };
  const status = useAutosave({ title: title.trim() || page.title, markdown }, async (patch) => {
    await api.patch(`/api/studio/pages/${page.id}`, patch);
    // Opened again later, the page shows what was saved.
    qc.setQueryData<SpacePage>(["space-page", page.id], (old) =>
      old ? { ...old, ...patch } : old,
    );
    if (patch.title !== page.title) {
      await listed();
    }
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
    onSuccess: () => qc.invalidateQueries({ queryKey: ["space-page", page.id] }),
  });
  // A link to another page of Knowledge (`pages/…`) opens it here.
  const follow = async (e: MouseEvent) => {
    const href = (e.target as HTMLElement).closest("a")?.getAttribute("href");
    if (!(href?.startsWith("pages/") && onOpen)) {
      return;
    }
    e.preventDefault();
    const found = await api
      .get<{ kind: string; id: string }>(
        `/api/studio/projects/${page.projectId}/resolve?path=${encodeURIComponent(href)}`,
      )
      .catch(() => null);
    if (found?.kind === "page") {
      onOpen(`p:${found.id}`);
    }
  };
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
          onChange={(e) => setTitle(e.target.value)}
          aria-label={t("data.title")}
          className="-ml-1 min-w-0 flex-1 rounded-md bg-transparent px-1 font-display font-semibold text-lg outline-none hover:bg-accent focus:bg-paper focus:ring-1 focus:ring-ring disabled:hover:bg-transparent"
        />
        {status.state === "saving" ? (
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
          <textarea
            value={markdown}
            onChange={(e) => setMarkdown(e.target.value)}
            aria-label={page.title}
            placeholder={t("data.pageEmpty")}
            className="field-sizing-content min-h-[50vh] w-full resize-none bg-transparent p-4 font-mono text-[0.8125rem] leading-relaxed outline-none placeholder:text-ink-4 sm:p-5"
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
    queryKey: ["space-page", pageId],
    queryFn: () => api.get<SpacePage>(`/api/studio/pages/${pageId}`),
    // What the person writes is the truth while the page is open.
    refetchOnWindowFocus: false,
  });
  if (!page.data) {
    return page.isError ? (
      <p className="text-[0.875rem] text-rose">{(page.error as Error).message}</p>
    ) : null;
  }
  return <Editor key={page.data.id} page={page.data} onGone={onGone} onOpen={onOpen} />;
}
