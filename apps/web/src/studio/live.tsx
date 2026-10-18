import type { WizardDefinition } from "@engenty/wizards-shared/definition";
import { mergeDrafts } from "@engenty/wizards-shared/merge";
import { useQueryClient } from "@tanstack/react-query";
import { GitMerge, Plug } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { withBase } from "@/lib/base";
import { ApiError, api } from "../lib/api";
import { t } from "../lib/i18n";
import { readOnlyError, type WizardDetail } from "../lib/session";
import { Chip } from "../ui";

/** What the server announces when a wizard changed (see apps/runtime/src/services/draft-events.ts). */
interface DraftChange {
  kind: "draft" | "files";
  revision: number;
  source: "studio" | "mcp";
  client: string | null;
  note: string | null;
  touched: string[];
}

export interface RemoteChange {
  client: string;
  steps: string[];
  at: number;
}

/**
 * The editor's draft, kept live. Inspector edits save debounced with the revision they started
 * from. Changes made elsewhere (an MCP client, the architect, another tab) arrive over SSE and
 * are fetched; local edits not yet saved stay on screen and merge with them when their save
 * meets the newer revision.
 */
export function useLiveDraft(wizardId: string | undefined) {
  const qc = useQueryClient();
  const key = useMemo(() => ["wizard", wizardId], [wizardId]);
  const path = `/api/studio/wizards/${wizardId}`;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Saves run one after another, so each carries the revision the previous one returned.
  const queue = useRef<Promise<void>>(Promise.resolve());
  /** The local draft not yet saved, and the server draft those edits started from. */
  const pending = useRef<WizardDefinition | null>(null);
  const base = useRef<WizardDefinition | null>(null);
  const inflight = useRef(false);
  const [saving, setSaving] = useState(false);
  const [merged, setMerged] = useState(0);
  const [remote, setRemote] = useState<RemoteChange | null>(null);
  /** The server's sentence when it took no edit: the wizard is changed elsewhere. */
  const [refused, setRefused] = useState<string | null>(null);

  const busy = useCallback(() => Boolean(timer.current || inflight.current || pending.current), []);

  const refresh = useCallback(async () => {
    const fresh = await api.get<WizardDetail>(path);
    qc.setQueryData<WizardDetail>(key, (old) =>
      old && busy()
        ? { ...fresh, draft: old.draft, title: old.title, revision: old.revision, dirty: true }
        : fresh,
    );
  }, [qc, key, path, busy]);

  const flush = useCallback((): void => {
    queue.current = queue.current.then(async () => {
      const local = pending.current;
      const current = qc.getQueryData<WizardDetail>(key);
      if (!local || !current) {
        return;
      }
      pending.current = null;
      inflight.current = true;
      setSaving(true);
      try {
        const res = await api.put<{ revision: number; issues: WizardDetail["issues"] }>(
          `${path}/draft`,
          { definition: local, baseRevision: current.revision },
        );
        base.current = pending.current ? local : null;
        qc.setQueryData<WizardDetail>(key, (old) =>
          old ? { ...old, revision: res.revision, issues: res.issues } : old,
        );
      } catch (err) {
        const readOnly = readOnlyError(err);
        if (readOnly) {
          // Nothing is changed here: the edit goes, the wizard comes back as the server has it.
          pending.current = null;
          base.current = null;
          setRefused(readOnly);
          const fresh = await api.get<WizardDetail>(path).catch(() => null);
          if (fresh) {
            qc.setQueryData<WizardDetail>(key, fresh);
          }
          return;
        }
        if (!(err instanceof ApiError && err.status === 409)) {
          pending.current ??= local;
          console.error("[draft] save failed", err);
          return;
        }
        // Written elsewhere meanwhile: put the studio's edits on top of that version, save again.
        const fresh = await api.get<WizardDetail>(path);
        const draft = mergeDrafts(
          base.current ?? fresh.draft,
          pending.current ?? local,
          fresh.draft,
        );
        base.current = fresh.draft;
        pending.current = draft;
        qc.setQueryData<WizardDetail>(key, { ...fresh, draft, title: draft.title, dirty: true });
        setMerged(Date.now());
        flush();
      } finally {
        inflight.current = false;
        setSaving(false);
      }
    });
  }, [qc, key, path]);

  const save = useCallback(
    (draft: WizardDefinition) => {
      if (!wizardId) {
        return;
      }
      if (!busy()) {
        base.current = qc.getQueryData<WizardDetail>(key)?.draft ?? null;
      }
      pending.current = draft;
      qc.setQueryData<WizardDetail>(key, (old) =>
        old ? { ...old, draft, title: draft.title, dirty: true } : old,
      );
      if (timer.current) {
        clearTimeout(timer.current);
      }
      timer.current = setTimeout(() => {
        timer.current = null;
        flush();
      }, 600);
    },
    [qc, key, wizardId, busy, flush],
  );

  useEffect(() => {
    if (!wizardId) {
      return;
    }
    const source = new EventSource(withBase(`/api/studio/wizards/${wizardId}/stream`));
    source.addEventListener("change", (e) => {
      const change = JSON.parse((e as MessageEvent).data) as DraftChange;
      const current = qc.getQueryData<WizardDetail>(key);
      // Our own save comes back here too; its revision is already ours.
      if (change.kind === "draft" && current && change.revision <= current.revision) {
        return;
      }
      void refresh();
      if (change.kind === "draft" && change.source === "mcp") {
        setRemote({ client: change.client ?? "MCP", steps: change.touched, at: Date.now() });
      }
    });
    // After a reconnect: catch up on what was missed.
    source.addEventListener("hello", (e) => {
      const { revision } = JSON.parse((e as MessageEvent).data) as { revision: number };
      const current = qc.getQueryData<WizardDetail>(key);
      if (current && revision !== current.revision) {
        void refresh();
      }
    });
    return () => source.close();
  }, [qc, key, wizardId, refresh]);

  useEffect(() => {
    if (!remote) {
      return;
    }
    const id = setTimeout(() => setRemote(null), 6000);
    return () => clearTimeout(id);
  }, [remote]);

  useEffect(() => {
    if (!merged) {
      return;
    }
    const id = setTimeout(() => setMerged(0), 4000);
    return () => clearTimeout(id);
  }, [merged]);

  return { save, saving, remote, merged: merged > 0, refused };
}

/** A quiet note in the editor header: who changed the wizard, or that edits were merged. */
export function LiveChip({ remote, merged }: { remote: RemoteChange | null; merged: boolean }) {
  if (remote) {
    return (
      <Chip tone="ember">
        <Plug className="size-3" /> {t("editor.changedVia", { client: remote.client })}
      </Chip>
    );
  }
  if (merged) {
    return (
      <Chip>
        <GitMerge className="size-3" /> {t("editor.merged")}
      </Chip>
    );
  }
  return null;
}
