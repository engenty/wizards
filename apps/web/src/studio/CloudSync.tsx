import { featureOn } from "@engenty/wizards-shared/features";
import type {
  SpaceSyncState,
  SyncConflictView,
  SyncKind,
  SyncMergeView,
  SyncRecord,
} from "@engenty/wizards-shared/sync";
import type { MergeChoice } from "@engenty/wizards-shared/sync-merge";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CloudAlert, GitMerge, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { api } from "../lib/api";
import { type Key, lang, t } from "../lib/i18n";
import { type Me, useMe } from "../lib/session";
import { Button, Chip, Spinner, Switch } from "../ui";
import { Section } from "./project/Section";

/**
 * The two-way sync of this computer's spaces with the organization in the cloud
 * (docs/plans/tenant-sync.md): where each space stands, what both sides changed differently
 * and waits for the person, and what merged by itself. The studio saves as always; the runtime
 * sends after a save and fetches before a page opens.
 */

interface SyncView {
  available: boolean;
  spaces: (SpaceSyncState & { name: string; here: boolean; inCloud: boolean })[];
  conflicts: SyncConflictView[];
  merges: SyncMergeView[];
  refusals: Record<string, string[]>;
}

const KEY = ["cloud-sync"];

/** The sync can run: this computer, an account, the switch. */
export function cloudSyncOn(me: Me | null | undefined): boolean {
  return me?.mode === "local" && Boolean(me.account) && featureOn(me.features, "twoWaySync");
}

export function useCloudSync() {
  const me = useMe();
  const on = cloudSyncOn(me.data);
  return useQuery({
    queryKey: KEY,
    queryFn: () => api.get<SyncView>("/api/studio/sync"),
    enabled: on,
    refetchInterval: on ? 20_000 : false,
  });
}

function useSyncAction<T>(fn: (input: T) => Promise<SyncView | unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (view) => {
      if (view && typeof view === "object" && "spaces" in (view as object)) {
        qc.setQueryData(KEY, view);
      } else {
        void qc.invalidateQueries({ queryKey: KEY });
      }
      // What the sync wrote is what the open pages show.
      void qc.invalidateQueries({ queryKey: ["wizard"] });
      void qc.invalidateQueries({ queryKey: ["space-page"] });
      void qc.invalidateQueries({ queryKey: ["space-table"] });
    },
  });
}

const when = (iso: string) =>
  new Date(iso).toLocaleString(lang === "de" ? "de-AT" : "en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

const ERRORS: Record<string, Key> = {
  update_here: "cloudSync.error.updateHere",
  update_cloud: "cloudSync.error.updateCloud",
  unreachable: "cloudSync.error.unreachable",
  signed_out: "cloudSync.error.signedOut",
  refused: "cloudSync.error.refused",
};

function errorLine(error: NonNullable<SpaceSyncState["error"]>): string {
  const key = error.reason ? ERRORS[error.reason] : undefined;
  return key ? t(key) : error.message;
}

const KINDS: Record<SyncKind, Key> = {
  space: "cloudSync.kind.space",
  wizard: "cloudSync.kind.wizard",
  translation: "cloudSync.kind.translation",
  message: "cloudSync.kind.message",
  page: "cloudSync.kind.page",
  table: "cloudSync.kind.table",
  row: "cloudSync.kind.row",
  category: "cloudSync.kind.category",
  file: "cloudSync.kind.file",
  connector: "cloudSync.kind.connector",
};

/** The places of an item in plain words: `steps › “File it” › title` reads `Steps › “File it” › Title`. */
const WORDS: Record<string, Key> = {
  title: "cloudSync.word.title",
  markdown: "cloudSync.word.text",
  description: "cloudSync.word.description",
  steps: "cloudSync.word.steps",
  fields: "cloudSync.word.fields",
  instructions: "cloudSync.word.instructions",
  prompt: "cloudSync.word.prompt",
  label: "cloudSync.word.label",
  cells: "cloudSync.word.cells",
  columns: "cloudSync.word.columns",
  name: "cloudSync.word.name",
  brand: "cloudSync.word.brand",
  facts: "cloudSync.word.facts",
  themes: "cloudSync.word.themes",
  files: "cloudSync.word.files",
  options: "cloudSync.word.options",
  categories: "cloudSync.word.categories",
  values: "cloudSync.word.values",
  texts: "cloudSync.word.texts",
  mcpServers: "cloudSync.word.mcpServers",
  page: "cloudSync.word.page",
};

function placeText(label: string): string {
  return label
    .split(" › ")
    .map((part) => (part.startsWith("“") || !WORDS[part] ? part : t(WORDS[part])))
    .join(" › ");
}

/**
 * Items whose own notice is on screen: the bar above every page says nothing more of them.
 * A small store, so the notice deep in a page and the bar at the top agree.
 */
const shown = new Map<string, number>();
const listeners = new Set<() => void>();
function useShowing(id: string | null) {
  useEffect(() => {
    if (!id) {
      return;
    }
    shown.set(id, (shown.get(id) ?? 0) + 1);
    for (const l of listeners) {
      l();
    }
    return () => {
      shown.set(id, (shown.get(id) ?? 1) - 1);
      if (!shown.get(id)) {
        shown.delete(id);
      }
      for (const l of listeners) {
        l();
      }
    };
  }, [id]);
}
function useShown(): string[] {
  const [, tick] = useState(0);
  useEffect(() => {
    const l = () => tick((n) => n + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return [...shown.keys()];
}

// --- the section in Settings ------------------------------------------------------------

export function CloudSyncSection() {
  const sync = useCloudSync();
  const now = useSyncAction(() => api.post<SyncView>("/api/studio/sync/now", {}));
  const toggle = useSyncAction((input: { id: string; on: boolean }) =>
    api.put<SyncView>(`/api/studio/sync/spaces/${input.id}`, { on: input.on }),
  );
  const view = sync.data;
  if (!view) {
    return sync.isLoading ? <Spinner className="size-5" /> : null;
  }
  return (
    <div className="flex flex-col gap-8">
      <Section
        title={t("cloudSync.title")}
        hint={t("cloudSync.hint")}
        action={
          <Button
            variant="secondary"
            size="sm"
            busy={now.isPending}
            onClick={() => now.mutate(undefined)}
          >
            <RefreshCw className="size-3.5" /> {t("cloudSync.now")}
          </Button>
        }
      >
        <ul className="flex flex-col divide-y divide-border-soft">
          {view.spaces.map((s) => (
            <li key={s.spaceId} className="flex items-start gap-4 py-3 first:pt-0 last:pb-0">
              <div className="min-w-0 flex-1">
                <p className="font-medium text-[0.9375rem]">{s.name}</p>
                <SpaceLine space={s} refusals={view.refusals[s.spaceId]} />
              </div>
              <Switch
                checked={s.on}
                label={t("cloudSync.spaceOn")}
                disabled={toggle.isPending}
                onChange={(on) => toggle.mutate({ id: s.spaceId, on })}
              />
            </li>
          ))}
        </ul>
      </Section>
      {view.conflicts.length ? <Conflicts view={view} /> : null}
      {view.merges.length ? <Merges merges={view.merges} /> : null}
    </div>
  );
}

function SpaceLine({
  space,
  refusals,
}: {
  space: SyncView["spaces"][number];
  refusals?: string[];
}) {
  const line = "mt-0.5 text-[0.8125rem] text-ink-3";
  if (!space.on) {
    return (
      <p className={line}>
        {t(space.here ? "cloudSync.state.hereOnly" : "cloudSync.state.cloudOnly")}
      </p>
    );
  }
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2">
      {space.error ? (
        <p className="text-[0.8125rem] text-rose">
          {errorLine(space.error)}
          {space.error.reason === "refused" && refusals?.length ? ` ${refusals.join(" · ")}` : ""}
        </p>
      ) : space.waiting ? (
        <Chip tone="warn">{t("cloudSync.state.waiting", { count: space.waiting })}</Chip>
      ) : space.conflicts ? null : (
        <Chip tone="live">{t("cloudSync.state.ok")}</Chip>
      )}
      {space.conflicts ? (
        <Chip tone="ember">{t("cloudSync.state.conflicts", { count: space.conflicts })}</Chip>
      ) : null}
      {space.syncedAt ? (
        <span className="text-[0.75rem] text-ink-3">
          {t("cloudSync.state.at", { when: when(space.syncedAt) })}
        </span>
      ) : null}
    </div>
  );
}

function Conflicts({ view }: { view: SyncView }) {
  const keepAll = useSyncAction((spaceId: string) =>
    api.post<SyncView>(`/api/studio/sync/spaces/${spaceId}/keep-cloud`, {}),
  );
  const spaces = [...new Set(view.conflicts.map((c) => c.spaceId))];
  return (
    <Section
      title={t("cloudSync.conflicts")}
      hint={t("cloudSync.conflictsHint")}
      action={
        view.conflicts.length > 1 && spaces.length === 1 ? (
          <Button
            variant="secondary"
            size="sm"
            busy={keepAll.isPending}
            onClick={() => keepAll.mutate(spaces[0])}
          >
            {t("cloudSync.keepCloudAll")}
          </Button>
        ) : null
      }
    >
      <ul className="flex flex-col divide-y divide-border-soft">
        {view.conflicts.map((c) => (
          <li key={c.id} className="py-4 first:pt-0 last:pb-0">
            <ConflictCard conflict={c} />
          </li>
        ))}
      </ul>
    </Section>
  );
}

const show = (v: unknown) =>
  v === undefined ? t("cloudSync.removed") : typeof v === "string" ? v : JSON.stringify(v, null, 1);

function ConflictCard({ conflict }: { conflict: SyncConflictView }) {
  const [picking, setPicking] = useState(false);
  const [choices, setChoices] = useState<("local" | "remote")[]>(() =>
    conflict.conflicts.map(() => "local"),
  );
  const [proposal, setProposal] = useState<SyncRecord | null>(null);
  const resolve = useSyncAction(
    (body: { take: "local" | "remote" } | { choices: MergeChoice[] } | { record: SyncRecord }) =>
      api.post<SyncView>(`/api/studio/sync/conflicts/${conflict.id}/resolve`, body),
  );
  const propose = useMutation({
    mutationFn: () =>
      api.post<{ record: SyncRecord }>(`/api/studio/sync/conflicts/${conflict.id}/propose`, {}),
    onSuccess: (answer) => setProposal(answer.record),
  });
  const said =
    conflict.deleted === "remote"
      ? t("cloudSync.conflict.deletedRemote")
      : conflict.deleted === "local"
        ? t("cloudSync.conflict.deletedLocal")
        : t("cloudSync.conflict.both");
  return (
    <div className="flex flex-col gap-3">
      <div>
        <p className="font-medium text-[0.9375rem]">
          <span className="text-ink-3">{t(KINDS[conflict.kind])} · </span>
          {conflict.title}
        </p>
        <p className="mt-0.5 text-[0.8125rem] text-ink-3">{said}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          busy={resolve.isPending}
          onClick={() => resolve.mutate({ take: "remote" })}
        >
          {t("cloudSync.keepCloud")}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          busy={resolve.isPending}
          onClick={() => resolve.mutate({ take: "local" })}
        >
          {t("cloudSync.keepLocal")}
        </Button>
        {conflict.conflicts.length ? (
          <Button size="sm" variant="ghost" onClick={() => setPicking((v) => !v)}>
            {t("cloudSync.pick")}
          </Button>
        ) : null}
        {conflict.deleted ? null : (
          <Button
            size="sm"
            variant="ghost"
            busy={propose.isPending}
            onClick={() => propose.mutate()}
          >
            {t("cloudSync.ai")}
          </Button>
        )}
      </div>
      {picking ? (
        <div className="flex flex-col gap-3 rounded-lg bg-paper-2 p-3">
          {conflict.conflicts.map((place, i) => (
            <div key={place.label} className="flex flex-col gap-1.5">
              <p className="font-medium text-[0.8125rem]">{placeText(place.label)}</p>
              {(["local", "remote"] as const).map((side) => (
                <label
                  key={side}
                  className="flex cursor-pointer items-start gap-2 text-[0.8125rem]"
                >
                  <input
                    type="radio"
                    className="mt-1"
                    checked={choices[i] === side}
                    onChange={() => setChoices((all) => all.map((c, j) => (j === i ? side : c)))}
                  />
                  <span className="min-w-0">
                    <span className="text-ink-3">
                      {t(side === "local" ? "cloudSync.here" : "cloudSync.cloud")}:{" "}
                    </span>
                    <span className="whitespace-pre-wrap break-words">{show(place[side])}</span>
                  </span>
                </label>
              ))}
            </div>
          ))}
          <div>
            <Button
              size="sm"
              busy={resolve.isPending}
              onClick={() => resolve.mutate({ choices: choices.map((take) => ({ take })) })}
            >
              {t("cloudSync.apply")}
            </Button>
          </div>
        </div>
      ) : null}
      {propose.isError ? (
        <p className="text-[0.8125rem] text-rose">
          {t("cloudSync.aiFailed", { error: (propose.error as Error).message })}
        </p>
      ) : null}
      {proposal ? (
        <div className="flex flex-col gap-2 rounded-lg bg-paper-2 p-3">
          <p className="text-[0.8125rem] text-ink-2">{t("cloudSync.aiProposal")}</p>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-[0.75rem] text-ink-2">
            {JSON.stringify(proposal, null, 2)}
          </pre>
          <div>
            <Button
              size="sm"
              busy={resolve.isPending}
              onClick={() => resolve.mutate({ record: proposal })}
            >
              {t("cloudSync.aiTake")}
            </Button>
          </div>
        </div>
      ) : null}
      {resolve.isError ? (
        <p className="text-[0.8125rem] text-rose">{(resolve.error as Error).message}</p>
      ) : null}
    </div>
  );
}

function Merges({ merges }: { merges: SyncMergeView[] }) {
  return (
    <Section title={t("cloudSync.merges")} hint={t("cloudSync.mergesHint")}>
      <ul className="flex flex-col divide-y divide-border-soft">
        {merges.map((m) => (
          <li key={m.id} className="py-4 first:pt-0 last:pb-0">
            <MergeNote merge={m} />
          </li>
        ))}
      </ul>
    </Section>
  );
}

/** One merge made by itself: what each side changed, and the way back to either side. */
function MergeNote({ merge, compact }: { merge: SyncMergeView; compact?: boolean }) {
  const seen = useSyncAction(() => api.post("/api/studio/sync/merges/seen", { ids: [merge.id] }));
  const undo = useSyncAction((take: "local" | "remote") =>
    api.post<SyncView>(`/api/studio/sync/merges/${merge.id}/undo`, { take }),
  );
  return (
    <div className="flex flex-col gap-2">
      <div className="text-[0.8125rem]">
        <p className="font-medium text-[0.9375rem]">
          {compact ? (
            t("cloudSync.merged")
          ) : (
            <>
              <span className="text-ink-3">{t(KINDS[merge.kind])} · </span>
              {merge.title}
            </>
          )}
        </p>
        {merge.local.length ? (
          <p className="mt-0.5 text-ink-3">
            {t("cloudSync.mergedHere", { places: merge.local.map(placeText).join(", ") })}
          </p>
        ) : null}
        {merge.remote.length ? (
          <p className="mt-0.5 text-ink-3">
            {t("cloudSync.mergedThere", { places: merge.remote.map(placeText).join(", ") })}
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          busy={seen.isPending}
          onClick={() => seen.mutate(undefined)}
        >
          {t("cloudSync.ok")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          busy={undo.isPending}
          onClick={() => undo.mutate("local")}
        >
          {t("cloudSync.undoLocal")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          busy={undo.isPending}
          onClick={() => undo.mutate("remote")}
        >
          {t("cloudSync.undoRemote")}
        </Button>
      </div>
    </div>
  );
}

// --- on the item, and above every page ---------------------------------------------------

/** On an open wizard, page or table: a merge made by itself, or a conflict that waits. */
export function SyncNotice({ kind, item }: { kind: SyncKind; item: string }) {
  const sync = useCloudSync();
  const conflict = sync.data?.conflicts.find((c) => c.kind === kind && c.item === item);
  const merge = sync.data?.merges.find((m) => m.kind === kind && m.item === item);
  useShowing(conflict ? conflict.id : null);
  if (conflict) {
    return (
      <div className="flex shrink-0 items-center gap-3 border-border-soft border-b bg-amber-tint px-4 py-2 text-[0.8125rem] text-ink-2 sm:px-6">
        <CloudAlert className="size-4 shrink-0 text-amber" />
        <p className="min-w-0 flex-1">{t("cloudSync.conflict.both")}</p>
        <Link to="/settings/cloud" className="shrink-0 underline transition hover:text-ink">
          {t("cloudSync.settle")}
        </Link>
      </div>
    );
  }
  if (merge) {
    return (
      <div className="flex shrink-0 items-start gap-3 border-border-soft border-b bg-moss-tint px-4 py-2 sm:px-6">
        <GitMerge className="mt-1 size-4 shrink-0 text-moss" />
        <div className="min-w-0 flex-1">
          <MergeNote merge={merge} compact />
        </div>
      </div>
    );
  }
  return null;
}

/** Above every page while something waits for the person: what both sides changed differently. */
export function CloudSyncBar({ me }: { me: Me }) {
  const sync = useCloudSync();
  const onScreen = useShown();
  const count = (sync.data?.conflicts ?? []).filter((c) => !onScreen.includes(c.id)).length;
  if (!cloudSyncOn(me) || !count) {
    return null;
  }
  return (
    <div className="flex items-center gap-3 border-border-soft border-b bg-amber-tint px-4 py-2 text-[0.8125rem] text-ink-2 sm:px-6">
      <CloudAlert className="size-4 shrink-0 text-amber" />
      <p className="min-w-0 flex-1">{t("cloudSync.bar", { count })}</p>
      <Link to="/settings/cloud" className="shrink-0 underline transition hover:text-ink">
        {t("cloudSync.settle")}
      </Link>
    </div>
  );
}
