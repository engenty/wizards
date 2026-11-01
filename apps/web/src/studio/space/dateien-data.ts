import type { ItemCategory } from "@engenty/wizards-shared/knowledge";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { keys } from "../../lib/keys";

// Dateien (docs/plans/media-and-files.md, section 3): a space's mounts and their files, as the
// runtime's routes/dateien.ts gives them.

export interface Mount {
  id: string;
  name: string;
  slug: string;
  kind: "folder";
  where: string;
  status: "scanning" | "ready" | "away";
  error: string | null;
  files: number;
  bytes: number;
  pending: number;
  vectorsPending: number;
  scannedAt: string | null;
  folderCategoryId: string | null;
}

export type MountSee = "all" | "admins";
export type MountWizards = "all" | "none" | string[];

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
  categories: ItemCategory[];
}

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
      api.get<Mount & { see: MountSee; wizards: MountWizards }>(
        `${base(spaceId)}/mounts/${mountId}`,
      ),
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
      path: string;
      see: MountSee;
      wizards: MountWizards;
      folderCategory: string | null;
    }) => {
      const mount = await api.post<Mount>(`${base(spaceId)}/mounts`, input);
      await refresh();
      return mount;
    },
    update: async (
      mountId: string,
      patch: { name?: string; see?: MountSee; wizards?: MountWizards },
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
  };
}
