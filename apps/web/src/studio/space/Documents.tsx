import { Markdown } from "@engenty/wizards-runner";
import { formatBytes } from "@engenty/wizards-shared/numbers";
import type { SpaceFileView } from "@engenty/wizards-shared/spaces";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, RefreshCw, Trash2 } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { api } from "../../lib/api";
import { useFeature } from "../../lib/features";
import { lang, t } from "../../lib/i18n";
import { keys } from "../../lib/keys";
import { Card, cn, IconButton, Spinner } from "../../ui";
import { fileUrl, useFileActions, useSpaceFiles } from "./data";
import { Description } from "./Files";
import { KnowledgeHeader, useKnowledge } from "./Knowledge";
import { viewerKind } from "./viewers-kind";

// pdf.js and SheetJS are large: they load with the first file opened in a viewer.
const Viewer = lazy(() => import("./viewers").then((m) => ({ default: m.Viewer })));

/** A document as the models read it: its text as Markdown, or the start of it. */
function useDocumentText(spaceId: string, file: SpaceFileView, limit: number) {
  return useQuery({
    // A document read again has another length: its text is fetched again.
    queryKey: ["space-file-text", file.id, file.chars, limit],
    queryFn: () =>
      api.get<{ text: string; chars: number }>(
        `/api/studio/spaces/${spaceId}/files/${file.id}/text?limit=${limit}`,
      ),
    enabled: file.status === "ready",
    staleTime: 60_000,
  });
}

function typeLabel(file: SpaceFileView): string {
  const ext = file.name.includes(".") ? file.name.split(".").pop() : "";
  return (ext || file.mime.split("/").pop() || "").toUpperCase().slice(0, 5);
}

const meta = (file: SpaceFileView) =>
  [typeLabel(file), file.pages ? t("space.pages", { n: file.pages }) : null, formatBytes(file.size)]
    .filter(Boolean)
    .join(" · ");

const TEXT_LIMIT = 200_000;

/**
 * A file of Knowledge that is no page and no table, opened: its categories, its description, the
 * file itself where the browser can show it (a PDF, a picture; with `knowledgeTree` also a
 * workbook, HTML and text), and the text the models read.
 */
export function FileView({
  spaceId,
  fileId,
  readOnly,
  onGone,
  page,
}: {
  spaceId: string;
  fileId: string;
  readOnly: boolean;
  onGone: () => void;
  /** Where a search found it: a PDF's page, a workbook's sheet (from 1). */
  page?: number;
}) {
  const qc = useQueryClient();
  const files = useSpaceFiles(spaceId);
  const knowledge = useKnowledge(spaceId);
  const actions = useFileActions(spaceId, readOnly);
  const file = files.data?.files.find((f) => f.id === fileId);
  const viewers = useFeature("knowledgeTree");
  const kind = file ? viewerKind(file.mime, file.name) : null;
  const shown = file
    ? viewers
      ? kind !== null
      : file.mime === "application/pdf" || file.mime.startsWith("image/")
    : false;
  const [view, setView] = useState<"original" | "text" | null>(null);
  if (!file) {
    return files.isLoading ? <Spinner className="mx-auto text-ink-3" /> : null;
  }
  const now = view ?? (shown ? "original" : "text");
  const item = knowledge.data?.items.find((i) => i.key === `f:${file.id}`);
  const src = fileUrl(spaceId, file.id);
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
          aria-label={t("space.openOriginal")}
          title={t("space.openOriginal")}
          className="inline-flex size-9 items-center justify-center rounded-full text-ink-3 transition hover:bg-accent hover:text-ink"
        >
          <ExternalLink className="size-4" />
        </a>
        {readOnly ? null : (
          <>
            <IconButton
              label={t("space.reindex")}
              onClick={async () => {
                await actions.reindex(file.id);
                await qc.invalidateQueries({ queryKey: keys.knowledge(spaceId) });
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
                  await qc.invalidateQueries({ queryKey: keys.knowledge(spaceId) });
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
        spaceId={spaceId}
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
          {shown ? tab("original", t("space.original")) : null}
          {tab("text", t("space.readText"))}
        </div>
        {now === "original" && viewers && kind ? (
          <Suspense
            fallback={
              <div className="flex h-40 items-center justify-center text-ink-3">
                <Spinner />
              </div>
            }
          >
            <Viewer kind={kind} url={src} name={file.name} page={page} />
          </Suspense>
        ) : now === "original" ? (
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
          <FileText spaceId={spaceId} file={file} />
        )}
      </Card>
    </section>
  );
}

function FileText({ spaceId, file }: { spaceId: string; file: SpaceFileView }) {
  const text = useDocumentText(spaceId, file, TEXT_LIMIT);
  if (text.isLoading || file.status === "pending") {
    return (
      <div className="flex h-40 items-center justify-center text-ink-3">
        <Spinner />
      </div>
    );
  }
  if (!text.data?.text) {
    return <p className="py-8 text-center text-[0.875rem] text-ink-3">{t("space.noText")}</p>;
  }
  return (
    <div className="overflow-x-auto p-4 sm:p-5">
      <Markdown text={text.data.text} className="text-[0.875rem]" />
      {text.data.chars > text.data.text.length ? (
        <p className="mt-3 text-[0.8125rem] text-ink-3">
          {t("space.textCut", {
            shown: text.data.text.length.toLocaleString(lang),
            total: text.data.chars.toLocaleString(lang),
          })}
        </p>
      ) : null}
    </div>
  );
}
