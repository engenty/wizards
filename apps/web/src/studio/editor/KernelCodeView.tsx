import type { WorkspaceFile } from "@engenty/wizards-shared/workspace";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileCode2, FileText, Folder, Image } from "lucide-react";
import { type ReactNode, useState } from "react";
import { withBase } from "../../lib/base";
import { t } from "../../lib/i18n";
import { keys } from "../../lib/keys";
import { cn } from "../../ui";
import { CodeEditor } from "../../ui/code-editor";
import { type KernelWizard, useKernelCards } from "./KernelFlow";

/** The wizard's own file: what `wizard.json` holds, shown beside the files of the workspace. */
export const WIZARD_JSON = "wizard.json";

const fileUrl = (wizardId: string, path: string) =>
  withBase(`/api/studio/wizards/${wizardId}/files/${path}`);

const isText = (file: WorkspaceFile | undefined) =>
  Boolean(file && (file.mime.startsWith("text/") || /json|javascript|xml/.test(file.mime)));

/**
 * The files of a wizard in version 0.3.0 as code: the file that is open in an editor, and beside
 * it, where `list` is set, every file to pick from: as the wizard's steps, in the order of the flow
 * under their titles, or as the folders they lie in. A file is written on Speichern, and only while it is the version that was
 * read. `wizard.json` is shown and not changed here.
 */
export function KernelCodeView({
  wizard,
  path,
  onPath,
  list,
  readOnly,
  end,
}: {
  wizard: KernelWizard;
  /** The file that is open. */
  path: string;
  onPath?: (path: string) => void;
  /** The files to pick from, beside the editor. */
  list?: boolean;
  readOnly?: boolean;
  /** At the end of the view's bar: what the views share, such as the column's switch. */
  end?: ReactNode;
}) {
  const { wizardId, files } = wizard;
  const { steps } = useKernelCards(wizard);
  const qc = useQueryClient();
  const file = files.find((f) => f.path === path);
  const own = path === WIZARD_JSON;
  const text = isText(file);
  const loaded = useQuery({
    queryKey: ["wizard-file", wizardId, path, file?.hash],
    queryFn: async () => {
      const res = await fetch(fileUrl(wizardId, path), { credentials: "include" });
      if (!res.ok) throw new Error(res.statusText);
      return res.text();
    },
    enabled: text,
  });
  // What is typed and not yet written, by file: it stays while another file is looked at.
  const [nav, setNav] = useState<"steps" | "folders">("steps");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draft = drafts[path];
  const saved = own ? JSON.stringify(wizard.file, null, 2) : (loaded.data ?? "");
  const changed = draft !== undefined && draft !== saved;
  const drop = (which: string) => setDrafts(({ [which]: _, ...rest }) => rest);
  const write = useMutation({
    mutationFn: async () => {
      const res = await fetch(fileUrl(wizardId, path), {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": file?.mime ?? "text/plain", "if-match": file?.hash ?? "" },
        body: draft,
      });
      if (!res.ok) {
        const said = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(said?.error ?? res.statusText);
      }
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: keys.wizard(wizardId) });
      drop(path);
    },
  });
  const save = () => {
    if (changed && !write.isPending) write.mutate();
  };

  // The steps as the flow has them, then every other file by its path.
  const stepFiles = steps
    .map((step) => ({ step, path: `steps/${step.id}.ts` }))
    .filter((one) => files.some((f) => f.path === one.path));
  const others = files.filter((f) => !stepFiles.some((one) => one.path === f.path));
  const row = (to: string, label: string, Icon: typeof FileText, tone?: string, note?: string) => (
    <button
      key={to}
      type="button"
      aria-current={to === path || undefined}
      onClick={() => onPath?.(to)}
      className={cn(
        "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[0.8125rem] text-ink-2 hover:bg-paper-2",
        to === path && "bg-paper-2 font-medium text-ink",
      )}
    >
      <span className={cn("inline-flex size-5 shrink-0 items-center justify-center rounded", tone)}>
        <Icon className="size-3.5" />
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {drafts[to] !== undefined ? (
        <span
          className="size-1.5 shrink-0 rounded-full bg-ember"
          title={t("kernel.code.unsaved")}
        />
      ) : note ? (
        <span className="shrink-0 font-mono text-[0.6875rem] text-ink-3">{note}</span>
      ) : null}
    </button>
  );
  /** A folder's entries, as a file browser lists them: its folders first, each with what it holds. */
  const paths = [WIZARD_JSON, ...files.map((f) => f.path)];
  const folder = (dir: string, depth: number): ReactNode[] => {
    const inside = paths.filter((one) => one.startsWith(dir)).map((one) => one.slice(dir.length));
    const dirs = [
      ...new Set(inside.filter((one) => one.includes("/")).map((one) => one.split("/")[0])),
    ];
    const own = inside.filter((one) => !one.includes("/"));
    return [
      ...dirs.sort().flatMap((name) => [
        <span
          key={`${dir}${name}/`}
          className="flex items-center gap-2 px-2 py-1.5 text-[0.8125rem] text-ink-3"
          style={{ paddingLeft: `${0.5 + depth * 0.875}rem` }}
        >
          <Folder className="size-3.5 shrink-0" />
          {name}
        </span>,
        ...folder(`${dir}${name}/`, depth + 1),
      ]),
      ...own.sort().map((name) => {
        const to = `${dir}${name}`;
        const mime = files.find((f) => f.path === to)?.mime ?? "";
        return (
          <div key={to} style={{ paddingLeft: `${depth * 0.875}rem` }}>
            {row(
              to,
              name,
              mime.startsWith("image/") ? Image : to.endsWith(".md") ? FileText : FileCode2,
            )}
          </div>
        );
      }),
    ];
  };
  const GROUP =
    "px-2 pt-3 pb-1 font-medium text-[0.6875rem] text-ink-3 uppercase tracking-[0.07em]";

  const writes = !(own || readOnly || !text);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* The view's bar: the open file and where it stands, what writes it, and the bar's end. */}
      <div className="flex h-12 shrink-0 items-center gap-2 overflow-x-auto border-border-soft border-b px-3 text-[0.8125rem] [scrollbar-width:none]">
        <span className="shrink-0 px-1 font-mono text-[0.75rem] text-ink-2">{path}</span>
        {writes ? (
          <span
            className={cn(
              "inline-flex min-w-0 items-center gap-1.5 truncate",
              write.error ? "text-rose" : "text-ink-3",
            )}
          >
            {changed && !write.error ? (
              <span className="size-1.5 shrink-0 rounded-full bg-ember" />
            ) : null}
            {write.error
              ? (write.error as Error).message
              : changed
                ? t("kernel.code.unsaved")
                : t("kernel.code.saved")}
          </span>
        ) : null}
        <span className="flex-1" />
        {writes ? (
          <>
            <button
              type="button"
              disabled={!changed}
              onClick={() => {
                drop(path);
                write.reset();
              }}
              className="shrink-0 rounded-full px-3 py-1 text-ink-2 hover:bg-paper-2 disabled:opacity-40"
            >
              {t("dateien.discard")}
            </button>
            <button
              type="button"
              disabled={!changed || write.isPending}
              onClick={save}
              className="shrink-0 rounded-full bg-ember px-3 py-1 font-medium text-white disabled:opacity-40"
            >
              {t("settings.save")}
            </button>
          </>
        ) : null}
        {end}
      </div>
      <div className="flex min-h-0 flex-1 max-md:flex-col">
        {list ? (
          <nav className="flex w-60 shrink-0 flex-col overflow-y-auto p-2 max-md:max-h-56 max-md:w-full">
            {/* The same files two ways: as the wizard's steps, or as the folders they lie in. */}
            <div className="mb-2 flex gap-0.5 rounded-full bg-paper-2 p-0.5 text-[0.8125rem]">
              {(["steps", "folders"] as const).map((one) => (
                <button
                  key={one}
                  type="button"
                  aria-pressed={nav === one}
                  onClick={() => setNav(one)}
                  className={cn(
                    "flex-1 rounded-full px-2.5 py-1 text-ink-3",
                    nav === one &&
                      "bg-card font-medium text-ink shadow-[0_0_0_1px_var(--border-soft)]",
                  )}
                >
                  {t(one === "steps" ? "chat.steps" : "editor.files")}
                </button>
              ))}
            </div>
            {nav === "steps" ? (
              <div className="flex flex-col gap-px">
                {row(WIZARD_JSON, WIZARD_JSON, FileCode2)}
                <span className={GROUP}>{t("chat.steps")}</span>
                {stepFiles.map(({ step, path: to }) =>
                  row(to, step.title, step.icon, step.tone, `${step.id}.ts`),
                )}
                {others.length ? <span className={GROUP}>{t("editor.files")}</span> : null}
                {others.map((f) =>
                  row(f.path, f.path, f.mime.startsWith("image/") ? Image : FileText),
                )}
              </div>
            ) : (
              <div className="flex flex-col gap-px">{folder("", 0)}</div>
            )}
          </nav>
        ) : null}
        <div
          className="flex min-h-0 min-w-0 flex-1 flex-col"
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "s") {
              e.preventDefault();
              save();
            }
          }}
        >
          <div className="min-h-0 flex-1 overflow-auto">
            {own || text ? (
              loaded.isLoading ? null : (
                <CodeEditor
                  key={path}
                  value={draft ?? saved}
                  onChange={(next) => setDrafts((all) => ({ ...all, [path]: next }))}
                  language={path.endsWith(".md") ? "markdown" : "typescript"}
                  ariaLabel={path}
                  readOnly={readOnly || own}
                />
              )
            ) : file?.mime.startsWith("image/") ? (
              <img src={fileUrl(wizardId, path)} alt={path} className="m-4 max-h-96 rounded-md" />
            ) : (
              <p className="p-4 text-[0.875rem] text-ink-3">{file ? file.mime : path}</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
