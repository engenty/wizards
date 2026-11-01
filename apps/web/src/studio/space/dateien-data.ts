import type { ItemCategory } from "@engenty/wizards-shared/knowledge";
import type { AgentAccess, Audience } from "@engenty/wizards-shared/rwx";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { keys } from "../../lib/keys";

// Dateien (docs/plans/media-and-files.md, section 3): a space's mounts and their files, as the
// runtime's routes/dateien.ts gives them.

export interface Mount {
  id: string;
  name: string;
  slug: string;
  /** `folder` on this computer, else a kind a plugin brings (`s3`). */
  kind: string;
  plugin: string | null;
  where: string;
  status: "scanning" | "ready" | "away";
  error: string | null;
  files: number;
  bytes: number;
  pending: number;
  vectorsPending: number;
  scannedAt: string | null;
  folderCategoryId: string | null;
  /** Whether its files may be changed: drafts, then „Veröffentlichen“. */
  writable: boolean;
}

/** Who sees a mount besides its admins; none: the admins alone. */
export type MountSee = Audience[];
export type MountWizards = "all" | "none" | string[];
/** What an AI working for a person may do with it: nothing, read, or write drafts. */
export type MountAgents = AgentAccess;

export interface MountFile {
  id: string;
  path: string;
  name: string;
  mime: string;
  size: number;
  modified: number;
  status: "pending" | "ready" | "skipped" | "failed";
  thumb: boolean;
  pages: number | null;
  /** What its text calls itself (front matter's `title:`, first heading), when it says. */
  title: string | null;
  categories: ItemCategory[];
}

/** The file as it was read: what a draft is saved with. */
export interface DraftBase {
  size: number;
  modified: number;
  version: string | null;
  hash: string;
}

/** A file's draft, or the file as it stands when it has none. */
export interface FileDraft {
  edit: "text" | "replace";
  draft: boolean;
  text: string | null;
  baseText: string | null;
  base: DraftBase;
  conflict: { text: string | null } | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** A draft of a mount, for its folder view. */
export interface MountDraft {
  fileId: string;
  path: string;
  conflict: boolean;
  updatedAt: string;
  updatedBy: string | null;
}

export type PublishResult =
  | { ok: true; merged: boolean }
  | { ok: false; conflict: { text: string | null } };

export interface FolderPreview {
  path: string;
  name: string;
  files: number;
  folders: number;
  bytes: number;
  complete: boolean;
  top: number;
  first: { name: string; files: number }[];
  leftOut: number;
}

const base = (spaceId: string) => `/api/studio/spaces/${spaceId}`;
// Under Knowledge's key: a category set on a file refreshes its list too.
const mountsKey = (spaceId: string) => [...keys.knowledge(spaceId), "dateien"] as const;

/** Asked again every few seconds while something is still read or embedded. */
const busy = (mounts: Mount[] | undefined) =>
  mounts?.some((m) => m.status === "scanning" || m.pending > 0 || m.vectorsPending > 0);

export function useMounts(spaceId: string | undefined) {
  return useQuery({
    queryKey: mountsKey(spaceId ?? ""),
    queryFn: () => api.get<{ mounts: Mount[] }>(`${base(spaceId as string)}/mounts`),
    enabled: Boolean(spaceId),
    refetchInterval: (query) => (busy(query.state.data?.mounts) ? 3000 : false),
  });
}

export function useMountFiles(spaceId: string, mount: Mount | undefined) {
  return useQuery({
    queryKey: [...mountsKey(spaceId), mount?.id, "files"],
    queryFn: () => api.get<{ files: MountFile[] }>(`${base(spaceId)}/mounts/${mount?.id}/files`),
    enabled: Boolean(mount),
    refetchInterval: mount && (mount.status === "scanning" || mount.pending > 0) ? 3000 : false,
  });
}

export function useMountAccess(spaceId: string, mountId: string | null) {
  return useQuery({
    queryKey: [...mountsKey(spaceId), mountId, "access"],
    queryFn: () =>
      api.get<
        Mount & {
          see: MountSee;
          wizards: MountWizards;
          agents: MountAgents;
          /** Whether its account may write there now; a plugin's kind asks for the rights first. */
          canWrite: boolean;
          /** What a plugin's kind keeps, for its studio half; none for a folder. */
          source?: Record<string, unknown>;
        }
      >(`${base(spaceId)}/mounts/${mountId}`),
    enabled: Boolean(mountId),
  });
}

export function useMountActions(spaceId: string) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: mountsKey(spaceId) });
  return {
    /** The system's folder dialog: a path, null when cancelled, false where there is none. */
    pick: (prompt: string) =>
      api.post<{ path: string | null | false }>(`${base(spaceId)}/mounts/pick`, { prompt }),
    folders: (path: string) =>
      api.get<{ folders: string[] }>(
        `${base(spaceId)}/mounts/folders?path=${encodeURIComponent(path)}`,
      ),
    preview: (path: string) => api.post<FolderPreview>(`${base(spaceId)}/mounts/preview`, { path }),
    create: async (input: {
      path?: string;
      kind?: string;
      source?: Record<string, unknown>;
      name?: string;
      see: MountSee;
      wizards: MountWizards;
      agents: MountAgents;
      folderCategory?: string | null;
      writable?: boolean;
    }) => {
      const mount = await api.post<Mount>(`${base(spaceId)}/mounts`, input);
      await refresh();
      return mount;
    },
    update: async (
      mountId: string,
      patch: {
        name?: string;
        see?: MountSee;
        wizards?: MountWizards;
        agents?: MountAgents;
        writable?: boolean;
      },
    ) => {
      await api.patch(`${base(spaceId)}/mounts/${mountId}`, patch);
      await refresh();
    },
    rescan: async (mountId: string) => {
      await api.post(`${base(spaceId)}/mounts/${mountId}/rescan`);
      await refresh();
    },
    remove: async (mountId: string) => {
      await api.del(`${base(spaceId)}/mounts/${mountId}`);
      await refresh();
    },
    /** „In Wissen übernehmen“: a copy in Knowledge, in a folder or at the top. */
    toKnowledge: async (fileId: string, parentId: string | null) => {
      const copy = await api.post<{ id: string; name: string }>(
        `${base(spaceId)}/mount-files/${fileId}/knowledge`,
        { parentId },
      );
      await qc.invalidateQueries({ queryKey: keys.knowledge(spaceId) });
      return copy;
    },
  };
}

export function useMountDrafts(spaceId: string, mount: Mount | undefined) {
  return useQuery({
    queryKey: [...mountsKey(spaceId), mount?.id, "drafts"],
    queryFn: () => api.get<{ drafts: MountDraft[] }>(`${base(spaceId)}/mounts/${mount?.id}/drafts`),
    enabled: Boolean(mount?.writable),
  });
}

export function useFileDraft(spaceId: string, fileId: string, enabled: boolean) {
  return useQuery({
    queryKey: [...mountsKey(spaceId), "draft", fileId],
    queryFn: () => api.get<FileDraft>(`${base(spaceId)}/mount-files/${fileId}/draft`),
    enabled,
    // The draft is what is edited: a refetch while typing would undo the last keys.
    refetchOnWindowFocus: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/** A file's draft: kept, replaced, thrown away, published, its conflict resolved. */
export function useDraftActions(spaceId: string, mountId: string, fileId: string) {
  const qc = useQueryClient();
  const file = `${base(spaceId)}/mount-files/${fileId}`;
  const refresh = () => qc.invalidateQueries({ queryKey: mountsKey(spaceId) });
  return {
    /** Keeps a text: only the mount's list of drafts is asked again, not the text being typed. */
    save: async (input: { text: string; base?: DraftBase; baseText?: string }) => {
      const saved = await api.put<{ draft: FileDraft | null }>(`${file}/draft`, input);
      await qc.invalidateQueries({ queryKey: [...mountsKey(spaceId), mountId, "drafts"] });
      return saved;
    },
    replace: async (upload: File) => {
      const draft = await api.upload<FileDraft>(`${file}/draft/replace`, upload);
      await refresh();
      return draft;
    },
    discard: async () => {
      await api.del(`${file}/draft`);
      await refresh();
    },
    publish: async () => {
      const result = await api.post<PublishResult>(`${file}/publish`);
      await refresh();
      return result;
    },
    keepMine: async () => {
      const result = await api.post<PublishResult>(`${file}/keep-mine`);
      await refresh();
      return result;
    },
  };
}

export async function publishMount(spaceId: string, mountId: string) {
  return api.post<{ published: number; conflicts: string[] }>(
    `${base(spaceId)}/mounts/${mountId}/publish`,
  );
}
