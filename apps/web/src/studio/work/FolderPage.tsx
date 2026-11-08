import { useQuery } from "@tanstack/react-query";
import {
  FileText,
  FolderOpen,
  HardDrive,
  Link2,
  MessageSquare,
  Pencil,
  Sparkles,
  Unlink,
} from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { api } from "../../lib/api";
import { withBase } from "../../lib/base";
import { useFeature } from "../../lib/features";
import { t } from "../../lib/i18n";
import { useCurrentSpace } from "../../lib/session";
import { Button, cn } from "../../ui";
import { useCrumbs } from "../AppFrame";
import { useCreateChat, useFolderContents, useRenameSection, useSidebar } from "./chats";

/**
 * A folder of Work, opened like a project (docs/plans/org-spaces.md): start a chat in it, its
 * chats, and beside them its Infos, what every chat in it should know. The AI of each chat in the
 * folder reads them first.
 */
export function FolderPage({ id }: { id: string }) {
  const { space } = useCurrentSpace();
  const { data } = useSidebar(space?.id, "");
  const folder = data?.sections.find((s) => s.id === id);
  const chats = (data?.chats ?? []).filter((c) => c.sectionId === id && !c.archived && !c.parentId);
  const createChat = useCreateChat();
  const contents = useFolderContents(id).data;
  const rename = useRenameSection();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [infos, setInfos] = useState("");
  useEffect(() => {
    setInfos(folder?.infos ?? "");
  }, [folder?.infos]);
  useCrumbs(folder ? [{ label: folder.name }] : []);
  if (!folder) {
    return <div className="flex-1" />;
  }
  const start = async (e: FormEvent) => {
    e.preventDefault();
    const chat = await createChat.mutateAsync({
      spaceId: space?.id,
      sectionId: id,
      parentId: null,
    });
    navigate(`/work/c/${chat.id}`);
  };
  const save = async () => {
    setEditing(false);
    if (infos !== (folder.infos ?? "")) {
      await rename.mutateAsync({ id, infos });
    }
  };
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto grid w-full max-w-5xl gap-8 px-6 py-8 md:grid-cols-[minmax(0,1fr)_16rem]">
        <div className="grid min-w-0 content-start gap-5">
          <div className="flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-xl bg-card text-ink-2 ring-1 ring-border-soft">
              <FolderOpen className="size-5" />
            </span>
            <h1 className="min-w-0 truncate font-display font-semibold text-[1.375rem] text-ink">
              {folder.name}
            </h1>
          </div>
          <form onSubmit={start}>
            <Button type="submit" busy={createChat.isPending}>
              {t("work.newChatIn", { name: folder.name })}
            </Button>
          </form>
          <ul className="grid">
            {chats.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => navigate(`/work/c/${c.id}`)}
                  className="flex w-full items-center gap-3 border-border-soft border-b px-1 py-2.5 text-left transition hover:bg-ink/5"
                >
                  <MessageSquare className="size-4 shrink-0 text-ink-3" />
                  <span className="flex min-w-0 flex-1 flex-col leading-tight">
                    <span className="truncate text-[0.875rem] text-ink">
                      {c.title || t("work.untitled")}
                    </span>
                    {c.last ? (
                      <span className="truncate text-[0.75rem] text-ink-3">
                        {c.last.author}: {c.last.text}
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            ))}
            {chats.length ? null : (
              <li className="px-1 py-2.5 text-[0.875rem] text-ink-3">{t("work.folderEmpty")}</li>
            )}
          </ul>
        </div>
        <aside className="grid content-start gap-2.5">
          <section className="grid gap-1.5 rounded-xl bg-card p-3 ring-1 ring-border-soft">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-[0.8125rem] text-ink">{t("work.folderInfos")}</h2>
              {editing ? null : (
                <button
                  type="button"
                  aria-label={t("work.folderInfosEdit")}
                  onClick={() => setEditing(true)}
                  className="grid size-6 place-items-center rounded-md text-ink-3 hover:bg-ink/10 hover:text-ink"
                >
                  <Pencil className="size-3.5" />
                </button>
              )}
            </div>
            {editing ? (
              <textarea
                // biome-ignore lint/a11y/noAutofocus: opened on purpose to write
                autoFocus
                value={infos}
                rows={6}
                maxLength={20_000}
                aria-label={t("work.folderInfos")}
                onChange={(e) => setInfos(e.target.value)}
                onBlur={save}
                className="w-full resize-y rounded-lg bg-background p-2 text-[0.8125rem] text-ink outline-none ring-1 ring-border focus:ring-ember/60"
              />
            ) : (
              <p
                className={cn(
                  "whitespace-pre-wrap text-[0.8125rem]",
                  folder.infos ? "text-ink-2" : "text-ink-4",
                )}
              >
                {folder.infos || t("work.folderInfosEmpty")}
              </p>
            )}
          </section>
          <section className="grid gap-1.5 rounded-xl bg-card p-3 ring-1 ring-border-soft">
            <h2 className="font-semibold text-[0.8125rem] text-ink">{t("work.folderFiles")}</h2>
            <FolderDrive
              spaceId={space?.id ?? ""}
              mountId={folder.mountId ?? null}
              onLink={(mountId) => rename.mutate({ id, mountId })}
            />
            {contents?.files.length ? (
              contents.files.map((f) => (
                <a
                  key={f.id}
                  href={withBase(f.url)}
                  target="_blank"
                  rel="noreferrer"
                  className="flex min-w-0 items-center gap-2 text-[0.8125rem] text-ink-2 hover:text-ink"
                >
                  <FileText className="size-3.5 shrink-0 text-ink-3" />
                  <span className="truncate">{f.name}</span>
                </a>
              ))
            ) : (
              <p className="text-[0.8125rem] text-ink-4">{t("work.folderFilesEmpty")}</p>
            )}
          </section>
          <section className="grid gap-1.5 rounded-xl bg-card p-3 ring-1 ring-border-soft">
            <h2 className="font-semibold text-[0.8125rem] text-ink">{t("work.folderResults")}</h2>
            {contents?.results.length ? (
              contents.results.map((r) => (
                <button
                  key={r.runId}
                  type="button"
                  onClick={() => navigate(`/work/r/${r.runId}`)}
                  className="flex min-w-0 items-center gap-2 text-left text-[0.8125rem] text-ink-2 hover:text-ink"
                >
                  <Sparkles className="size-3.5 shrink-0 text-ember-strong" />
                  <span className="truncate">{r.title}</span>
                </button>
              ))
            ) : (
              <p className="text-[0.8125rem] text-ink-4">{t("work.folderResultsEmpty")}</p>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}

interface Mount {
  id: string;
  name: string;
}

/**
 * The folder's drive: one of its space's mounted folders or drives (Dateien), linked to the folder.
 * Its files then are the folder's, and the AI of its chats looks there first. Behind `dateien`.
 */
function FolderDrive({
  spaceId,
  mountId,
  onLink,
}: {
  spaceId: string;
  mountId: string | null;
  onLink: (mountId: string | null) => void;
}) {
  const on = useFeature("dateien");
  const mounts = useQuery({
    queryKey: ["space-mounts", spaceId],
    queryFn: () => api.get<{ mounts: Mount[] }>(`/api/studio/spaces/${spaceId}/mounts`),
    enabled: on && Boolean(spaceId),
  }).data?.mounts;
  const files = useQuery({
    queryKey: ["space-mounts", spaceId, mountId, "files"],
    queryFn: () =>
      api.get<{ files: { id: string; path: string }[] }>(
        `/api/studio/spaces/${spaceId}/mounts/${mountId}/files`,
      ),
    enabled: on && Boolean(spaceId && mountId),
  }).data?.files;
  if (!on || !mounts?.length) {
    return null;
  }
  const linked = mounts.find((m) => m.id === mountId);
  if (linked) {
    return (
      <div className="grid gap-1">
        <div className="flex items-center gap-2 rounded-lg bg-background px-2 py-1.5 text-[0.8125rem] ring-1 ring-border-soft">
          <Link2 className="size-3.5 shrink-0 text-cobalt" />
          <span className="min-w-0 flex-1 truncate">{linked.name}</span>
          <button
            type="button"
            aria-label={t("work.folderUnlink")}
            title={t("work.folderUnlink")}
            onClick={() => onLink(null)}
            className="grid size-5 place-items-center rounded text-ink-3 hover:text-ink"
          >
            <Unlink className="size-3" />
          </button>
        </div>
        {files?.slice(0, 5).map((f) => (
          <span key={f.id} className="truncate pl-1 text-[0.75rem] text-ink-3">
            {f.path}
          </span>
        ))}
        {files && files.length > 5 ? (
          <span className="pl-1 text-[0.75rem] text-ink-4">
            {t("work.folderMoreFiles", { n: files.length - 5 })}
          </span>
        ) : null}
      </div>
    );
  }
  return (
    <label className="flex items-center gap-2 text-[0.8125rem] text-ink-3">
      <HardDrive className="size-3.5 shrink-0" />
      <select
        value=""
        aria-label={t("work.folderLink")}
        onChange={(e) => e.target.value && onLink(e.target.value)}
        className="min-w-0 flex-1 rounded-md bg-background px-1.5 py-1 text-ink ring-1 ring-border"
      >
        <option value="">{t("work.folderLink")}</option>
        {mounts.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>
    </label>
  );
}
