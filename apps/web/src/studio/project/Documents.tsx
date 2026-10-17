import { Markdown } from "@engenty-wizards/runner";
import { formatBytes } from "@engenty-wizards/shared/numbers";
import type { ProjectFileView } from "@engenty-wizards/shared/projects";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { api } from "../../lib/api";
import { lang, t } from "../../lib/i18n";
import { Card, cn, IconButton, Spinner } from "../../ui";
import { fileUrl, useFileActions, useProjectFiles } from "./data";
import { Description } from "./Files";
import { KnowledgeHeader, useKnowledge } from "./Knowledge";

/** A document as the models read it: its text as Markdown, or the start of it. */
function useDocumentText(projectId: string, file: ProjectFileView, limit: number) {
  return useQuery({
    // A document read again has another length: its text is fetched again.
    queryKey: ["project-file-text", file.id, file.chars, limit],
    queryFn: () =>
      api.get<{ text: string; chars: number }>(
        `/api/studio/projects/${projectId}/files/${file.id}/text?limit=${limit}`,
      ),
    enabled: file.status === "ready",
    staleTime: 60_000,
  });
}

function typeLabel(file: ProjectFileView): string {
  const ext = file.name.includes(".") ? file.name.split(".").pop() : "";
  return (ext || file.mime.split("/").pop() || "").toUpperCase().slice(0, 5);
}

const meta = (file: ProjectFileView) =>
  [
    typeLabel(file),
    file.pages ? t("project.pages", { n: file.pages }) : null,
    formatBytes(file.size),
  ]
    .filter(Boolean)
    .join(" · ");

const TEXT_LIMIT = 200_000;

/**
 * A file of Knowledge that is no page and no table, opened: its categories, its description, the
 * file itself where the browser can show it (a PDF, a picture), and the text the models read.
 */
export function FileView({
  projectId,
  fileId,
  readOnly,
  onGone,
}: {
  projectId: string;
  fileId: string;
  readOnly: boolean;
  onGone: () => void;
}) {
  const qc = useQueryClient();
  const files = useProjectFiles(projectId);
  const knowledge = useKnowledge(projectId);
  const actions = useFileActions(projectId, readOnly);
  const file = files.data?.files.find((f) => f.id === fileId);
  const shown = file ? file.mime === "application/pdf" || file.mime.startsWith("image/") : false;
  const [view, setView] = useState<"original" | "text" | null>(null);
  if (!file) {
    return files.isLoading ? <Spinner className="mx-auto text-ink-3" /> : null;
  }
  const now = view ?? (shown ? "original" : "text");
  const item = knowledge.data?.items.find((i) => i.key === `f:${file.id}`);
  const src = fileUrl(projectId, file.id);
  const tab = (id: "original" | "text", label: string) => (
    <button
      type="button"
      aria-pressed={now === id}
      onClick={() => setView(id)}
      className={cn(
        "rounded-full px-3 py-1 text-[0.8125rem] transition",
        now === id ? "bg-paper-2 font-medium text-ink" : "text-ink-3 hover:text-ink",
      )}
    >
      {label}
    </button>
  );
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-2 px-1">
        <h2 className="min-w-0 flex-1 truncate font-display font-semibold text-lg">{file.name}</h2>
        <span className="text-[0.8125rem] text-ink-3 max-sm:hidden">{meta(file)}</span>
        <a
          href={src}
          target="_blank"
          rel="noreferrer"
          aria-label={t("project.openOriginal")}
          title={t("project.openOriginal")}
          className="inline-flex size-9 items-center justify-center rounded-full text-ink-3 transition hover:bg-accent hover:text-ink"
        >
          <ExternalLink className="size-4" />
        </a>
        {readOnly ? null : (
          <>
            <IconButton
              label={t("project.reindex")}
              onClick={async () => {
                await actions.reindex(file.id);
                await qc.invalidateQueries({ queryKey: ["knowledge", projectId] });
              }}
            >
              <RefreshCw className="size-4" />
            </IconButton>
            <IconButton
              label={t("know.deleteFile")}
              className="hover:text-rose"
              onClick={async () => {
                if (confirm(t("data.confirmDelete", { title: file.name }))) {
                  await actions.remove(file.id);
                  await qc.invalidateQueries({ queryKey: ["knowledge", projectId] });
                  onGone();
                }
              }}
            >
              <Trash2 className="size-4" />
            </IconButton>
          </>
        )}
      </div>
      <KnowledgeHeader
        projectId={projectId}
        itemKey={`f:${file.id}`}
        has={item?.categories ?? []}
        originLabel={item?.originLabel ?? null}
        kept={false}
        review={null}
        file={null}
        readOnly={readOnly}
        onReviewed={() => undefined}
      />
      <div className="px-1">
        <Description file={file} actions={actions} />
      </div>
      {file.status === "failed" ? (
        <p className="px-1 text-[0.875rem] text-rose">{file.error}</p>
      ) : null}
      <Card className="flex flex-col">
        <div className="flex items-center gap-1 border-border-soft border-b px-2 py-1.5">
          {shown ? tab("original", t("project.original")) : null}
          {tab("text", t("project.readText"))}
        </div>
        {now === "original" ? (
          file.mime === "application/pdf" ? (
            <iframe
              src={src}
              title={file.name}
              className="h-[70dvh] w-full rounded-b-xl bg-paper-2"
            />
          ) : (
            <img src={src} alt="" className="mx-auto max-h-[70dvh] object-contain p-4" />
          )
        ) : (
          <FileText projectId={projectId} file={file} />
        )}
      </Card>
    </section>
  );
}

function FileText({ projectId, file }: { projectId: string; file: ProjectFileView }) {
  const text = useDocumentText(projectId, file, TEXT_LIMIT);
  if (text.isLoading || file.status === "pending") {
    return (
      <div className="flex h-40 items-center justify-center text-ink-3">
        <Spinner />
      </div>
    );
  }
  if (!text.data?.text) {
    return <p className="py-8 text-center text-[0.875rem] text-ink-3">{t("project.noText")}</p>;
  }
  return (
    <div className="overflow-x-auto p-4 sm:p-5">
      <Markdown text={text.data.text} className="text-[0.875rem]" />
      {text.data.chars > text.data.text.length ? (
        <p className="mt-3 text-[0.8125rem] text-ink-3">
          {t("project.textCut", {
            shown: text.data.text.length.toLocaleString(lang),
            total: text.data.chars.toLocaleString(lang),
          })}
        </p>
      ) : null}
    </div>
  );
}
