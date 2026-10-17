import type { ProjectFileKind, ProjectFileView } from "@engenty-wizards/shared/projects";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { withBase } from "../../lib/base";

export interface ProjectFiles {
  files: ProjectFileView[];
  /** Whether documents get vectors, or the index works on keywords alone. */
  embeddings: boolean;
}

const filesKey = (projectId: string) => ["project-files", projectId];

/** The project's logos, assets and documents; asked again while one is still being read. */
export function useProjectFiles(projectId: string) {
  return useQuery({
    queryKey: filesKey(projectId),
    queryFn: () => api.get<ProjectFiles>(`/api/studio/projects/${projectId}/files`),
    refetchInterval: (query) =>
      query.state.data?.files.some((f) => f.status === "pending") ? 2000 : false,
  });
}

export function fileUrl(projectId: string, fileId: string): string {
  return withBase(`/api/studio/projects/${projectId}/files/${fileId}/content`);
}

/**
 * Uploads, changes and removals of a project's files; each one refreshes the list. `readOnly`:
 * the project is not changed here, so what shows the files offers none of these.
 */
export function useFileActions(projectId: string, readOnly = false) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: filesKey(projectId) });
  const run = async (work: () => Promise<unknown>) => {
    setError(null);
    try {
      await work();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      await refresh();
    }
  };
  return {
    busy,
    error,
    readOnly,
    /** Resolves with the files that were taken, in order. */
    upload: async (kind: ProjectFileKind, files: File[]) => {
      setBusy(true);
      const taken: ProjectFileView[] = [];
      await run(async () => {
        for (const file of files) {
          taken.push(
            await api.upload<ProjectFileView>(
              `/api/studio/projects/${projectId}/files?kind=${kind}`,
              file,
            ),
          );
          await refresh();
        }
      });
      setBusy(false);
      return taken;
    },
    /**
     * Fetches a file from a web address. A logo's address that is a web page gives the logos on
     * it instead, to pick from. Errors are the caller's to show.
     */
    fromUrl: async (kind: ProjectFileKind, url: string) => {
      const answer = await api.post<{
        file?: ProjectFileView;
        candidates?: { url: string; hint: string }[];
      }>(`/api/studio/projects/${projectId}/files/url`, { kind, url });
      if (answer.file) {
        await refresh();
      }
      return answer;
    },
    describe: (fileId: string, description: string) =>
      run(() => api.patch(`/api/studio/projects/${projectId}/files/${fileId}`, { description })),
    remove: (fileId: string) =>
      run(() => api.del(`/api/studio/projects/${projectId}/files/${fileId}`)),
    reindex: (fileId: string) =>
      run(() => api.post(`/api/studio/projects/${projectId}/files/${fileId}/reindex`)),
    order: (kind: ProjectFileKind, ids: string[]) =>
      run(() => api.put(`/api/studio/projects/${projectId}/files/order`, { kind, ids })),
  };
}

export type Layout = "list" | "cards";

/** List or cards for one section, as the person last had it in this browser. */
export function useLayout(section: string, fallback: Layout): [Layout, () => void] {
  const key = `wz.layout.${section}`;
  const [layout, setLayout] = useState<Layout>(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored === "list" || stored === "cards" ? stored : fallback;
    } catch {
      return fallback;
    }
  });
  const toggle = () =>
    setLayout((now) => {
      const next = now === "list" ? "cards" : "list";
      try {
        localStorage.setItem(key, next);
      } catch {
        // per-browser convenience only
      }
      return next;
    });
  return [layout, toggle];
}

export type SaveState = "idle" | "saving" | "saved" | "error";

/**
 * Saves `value` a moment after it stops changing, and when the section goes away. The value the
 * section starts with counts as saved.
 */
export function useAutosave<T>(value: T, save: (value: T) => Promise<unknown>, delay = 700) {
  const [state, setState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);
  const json = JSON.stringify(value);
  const saved = useRef(json);
  const latest = useRef({ value, json, save });
  latest.current = { value, json, save };
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  const flush = useCallback(() => {
    const now = latest.current;
    if (now.json === saved.current) {
      return;
    }
    saved.current = now.json;
    setState("saving");
    // One save after the other: a later one must not be overtaken by an earlier one.
    queue.current = queue.current.then(async () => {
      try {
        await now.save(now.value);
        setError(null);
        setState("saved");
      } catch (err) {
        saved.current = "";
        setError((err as Error).message);
        setState("error");
      }
    });
  }, []);

  useEffect(() => {
    if (json === saved.current) {
      return;
    }
    const timer = setTimeout(flush, delay);
    return () => clearTimeout(timer);
  }, [json, delay, flush]);
  useEffect(() => flush, [flush]);

  return { state, error };
}
