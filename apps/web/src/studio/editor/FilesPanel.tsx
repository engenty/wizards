import { formatBytes } from "@engenty-wizards/shared/numbers";
import type { WorkspaceFile } from "@engenty-wizards/shared/workspace";
import { useQueryClient } from "@tanstack/react-query";
import { Download, FileCode2, FileJson, FileText, Image, Trash2, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { api } from "../../lib/api";
import { lang, t } from "../../lib/i18n";
import { IconButton, Spinner } from "../../ui";

function fileIcon(f: WorkspaceFile) {
  if (f.mime.startsWith("image/")) {
    return Image;
  }
  if (f.mime.includes("json")) {
    return FileJson;
  }
  if (f.mime === "text/html" || f.mime.includes("javascript") || f.mime === "text/css") {
    return FileCode2;
  }
  return FileText;
}

/**
 * The wizard's workspace: what the widgets and steps use on every run. `readOnly`: the files
 * are there to see and to download, nothing is added or removed.
 */
export function FilesPanel({
  wizardId,
  files,
  readOnly,
}: {
  wizardId: string;
  files: WorkspaceFile[];
  readOnly?: boolean;
}) {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const depth = useRef(0);
  const [drag, setDrag] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const base = `/api/studio/wizards/${wizardId}/files`;
  const refresh = () => qc.invalidateQueries({ queryKey: ["wizard", wizardId] });

  const upload = async (list: FileList | null) => {
    if (!list?.length) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      for (const file of Array.from(list)) {
        const res = await fetch(`${base}/${encodeURIComponent(file.name).replace(/%2F/g, "/")}`, {
          method: "PUT",
          credentials: "include",
          headers: {
            "content-type": file.type || "application/octet-stream",
            "accept-language": lang,
          },
          body: file,
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? res.statusText);
        }
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const remove = async (path: string) => {
    if (!window.confirm(t("files.confirmDelete", { path }))) {
      return;
    }
    setError(null);
    try {
      await api.del(`${base}/${path}`);
    } catch (err) {
      setError((err as Error).message);
    }
    await refresh();
  };

  const total = files.reduce((n, f) => n + f.size, 0);
  return (
    // The whole panel takes files dropped on it; entering and leaving its children is counted,
    // so the drop sign does not flicker while the files pass over the list.
    <div
      className="relative flex min-h-full flex-col px-5 py-5"
      onDragEnter={(e) => {
        if (readOnly || !e.dataTransfer.types.includes("Files")) {
          return;
        }
        e.preventDefault();
        depth.current += 1;
        setDrag(true);
      }}
      onDragOver={(e) => {
        if (!readOnly && e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }
      }}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) {
          setDrag(false);
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        depth.current = 0;
        setDrag(false);
        if (!readOnly) {
          void upload(e.dataTransfer.files);
        }
      }}
    >
      {drag ? (
        <div className="pointer-events-none absolute inset-3 z-10 flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-ember border-dashed bg-ember-veil text-[0.875rem] text-ember-strong">
          <Upload className="size-6" />
          {t("files.drop")}
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        {readOnly ? null : (
          <button
            type="button"
            onClick={() => input.current?.click()}
            className="inline-flex h-9 items-center gap-1.5 rounded-full bg-paper-2 px-3.5 font-medium text-[0.8125rem] text-ink-2 hover:bg-paper-3 hover:text-ink"
          >
            {busy ? <Spinner className="size-3.5" /> : <Upload className="size-3.5" />}
            {t("files.upload")}
          </button>
        )}
        <span className="ml-auto text-[0.75rem] text-ink-4">
          {t("files.count", { n: files.length, size: formatBytes(total) })}
        </span>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          onChange={(e) => void upload(e.target.files)}
        />
      </div>
      {error ? (
        <div className="mt-3 rounded-lg bg-rose-tint px-3 py-2 text-[0.8125rem] text-rose">
          {error}
        </div>
      ) : null}
      <ul className="mt-4 flex flex-col">
        {files.map((f) => {
          const Icon = fileIcon(f);
          return (
            <li
              key={f.path}
              className="group flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-paper-2"
            >
              <Icon className="size-4 shrink-0 text-ink-3" />
              <span className="min-w-0 flex-1 truncate font-mono text-[0.75rem]">{f.path}</span>
              <span className="text-[0.75rem] text-ink-4 tabular-nums">{formatBytes(f.size)}</span>
              <a
                href={`${base}/${f.path}`}
                className="inline-flex size-8 items-center justify-center rounded-full text-ink-3 opacity-0 hover:text-ink group-hover:opacity-100"
                aria-label={t("files.download")}
              >
                <Download className="size-4" />
              </a>
              {readOnly ? null : (
                <IconButton
                  label={t("files.delete")}
                  className="opacity-0 hover:text-rose group-hover:opacity-100"
                  onClick={() => void remove(f.path)}
                >
                  <Trash2 className="size-4" />
                </IconButton>
              )}
            </li>
          );
        })}
      </ul>
      {files.length === 0 ? (
        <div className="mt-6 rounded-xl border border-border border-dashed px-4 py-8 text-center text-[0.8125rem] text-ink-4">
          {t(readOnly ? "files.none" : "files.empty")}
        </div>
      ) : null}
      {/* What the tab is, at the foot of the pane: there to read once, not in the way. */}
      {readOnly ? null : (
        <p className="mt-auto pt-6 text-[0.6875rem] text-ink-4 leading-relaxed">
          {t("files.explain")}
        </p>
      )}
    </div>
  );
}
