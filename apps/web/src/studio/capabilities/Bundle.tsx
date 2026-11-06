import type {
  BundleFormat,
  BundleLeftOut,
  BundleOrigin,
  BundleRemoval,
  BundleUpdateAnswer,
  BundleUpdated,
  BundleView,
} from "@engenty/wizards-shared/bundles";
import type { SkillMode } from "@engenty/wizards-shared/skills";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, RefreshCw, ScrollText, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { Link } from "react-router";
import { api } from "../../lib/api";
import { type Key, lang, t } from "../../lib/i18n";
import { keys } from "../../lib/keys";
import { askConfirm, Button, Card, cn } from "../../ui";
import { ModeSwitch } from "../space/Skills";

/*
 * A Connector that brings skills (docs/plans/capabilities-next.md, piece 4), as the studio shows
 * it once it is in a space. There is no word for the thing: it is a Connector with its Skills,
 * and „Plugin“ only names where it came from. `BundleNote` says that origin and offers
 * „Aktualisieren“ where it changed; `BundleSkills` lists the skills on the Connector's page;
 * `useBundleRemoval` asks once, naming the wizards that use its connection, and removes all of
 * it. The runtime's record is a `bundle`; only admins read it.
 */

export const bundlesKey = (spaceId: string) => ["bundles", spaceId] as const;

/** What came together in a space, for its admins; nothing for a member. */
export function useBundles(spaceId: string | undefined, admin: boolean) {
  return useQuery({
    queryKey: bundlesKey(spaceId ?? ""),
    queryFn: () => api.get<{ bundles: BundleView[] }>(`/api/studio/spaces/${spaceId}/bundles`),
    enabled: Boolean(spaceId) && admin,
    select: (data) => data.bundles,
  });
}

/** Whose plugin it was: the open format at a plugin's root is the one Cursor reads. */
export const formatName = (format: BundleFormat) =>
  format === "claude" ? "Claude Code" : "Cursor";

/** Where it came from, as a person names it: `owner/name` and a folder, or the file. */
export function originText(origin: BundleOrigin): string {
  const folder = origin.path ? `/${origin.path}` : "";
  return origin.kind === "github" ? `${origin.repo}${folder}` : `${origin.file}${folder}`;
}

/** The origin's page on GitHub; null for a file. */
export function originUrl(origin: BundleOrigin): string | null {
  if (origin.kind !== "github") {
    return null;
  }
  const tail =
    origin.ref || origin.path
      ? `/tree/${origin.ref ?? "HEAD"}${origin.path ? `/${origin.path}` : ""}`
      : "";
  return `https://github.com/${origin.repo}${tail}`;
}

const day = (iso: string) =>
  new Date(iso).toLocaleDateString(lang, { day: "numeric", month: "long" });

/** „a, b und c“; in English without the comma before „and“. */
const list = (parts: string[]) =>
  new Intl.ListFormat(lang === "en" ? "en-GB" : lang, {
    style: "long",
    type: "conjunction",
  }).format(parts);

const LEFT_OUT_WORDS: Partial<Record<BundleLeftOut["kind"], Key>> = {
  command: "bundle.its.commands",
  agent: "bundle.its.agents",
  hook: "bundle.its.hooks",
  rule: "bundle.its.rules",
};

/** „Seine Befehle und Hooks nutzt engenty nicht.“; null where the plugin held nothing else. */
function leftOutSentence(leftOut: BundleLeftOut[]): string | null {
  const kinds = (Object.keys(LEFT_OUT_WORDS) as BundleLeftOut["kind"][]).filter((kind) =>
    leftOut.some((l) => l.kind === kind),
  );
  if (leftOut.some((l) => l.kind === "server")) {
    kinds.push("server");
  }
  if (!kinds.length) {
    return null;
  }
  const words = kinds.map((kind) =>
    kind === "server" ? t("bundle.its.servers") : t(LEFT_OUT_WORDS[kind] as Key),
  );
  return t("bundle.its.unused", { what: list(words) });
}

/** What it brought: this connector, or how many, and how many skills. */
function broughtSentence(bundle: BundleView, onConnector: boolean): string {
  const parts: string[] = [];
  if (bundle.connectors.length === 1) {
    parts.push(
      onConnector
        ? t("bundle.brought.thisConnector")
        : t("bundle.brought.connector", { name: bundle.connectors[0].name }),
    );
  } else if (bundle.connectors.length) {
    parts.push(t("bundle.brought.connectors", { n: bundle.connectors.length }));
  }
  if (bundle.skills.length) {
    parts.push(
      t(bundle.skills.length === 1 ? "bundle.brought.skill" : "bundle.brought.skills", {
        n: bundle.skills.length,
      }),
    );
  }
  return t("bundle.brought", { what: list(parts) });
}

/** After a change: the lists that show a bundle's parts read again. */
function useReload(spaceId: string) {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: bundlesKey(spaceId) }),
      qc.invalidateQueries({ queryKey: keys.connectors(spaceId) }),
      qc.invalidateQueries({ queryKey: keys.skills(spaceId) }),
      qc.invalidateQueries({ queryKey: ["space-connections", spaceId] }),
      qc.invalidateQueries({ queryKey: ["skill"] }),
    ]);
}

/**
 * Where a Connector and its Skills came from: the plugin, its origin and version, what it
 * brought, and what of it engenty does not use. An admin sees the source and takes an update
 * where the origin changed; one that came from a file takes a new file.
 */
export function BundleNote({
  bundle,
  writable,
  onConnector,
}: {
  bundle: BundleView;
  writable: boolean;
  /** On the page of its own connector: „diesen Connector“. */
  onConnector?: boolean;
}) {
  const reload = useReload(bundle.spaceId);
  const file = useRef<HTMLInputElement>(null);
  const base = `/api/studio/bundles/${encodeURIComponent(bundle.id)}`;
  const check = useQuery({
    queryKey: ["bundle-update", bundle.id, bundle.hash],
    queryFn: () => api.get<BundleUpdateAnswer>(`${base}/update`),
    enabled: writable && bundle.origin.kind === "github",
    staleTime: 5 * 60_000,
    retry: false,
  });
  const take = useMutation({
    mutationFn: (upload: File | null) => {
      if (upload) {
        const form = new FormData();
        form.set("file", upload);
        return api.post<BundleUpdated>(`${base}/update`, form);
      }
      return api.post<BundleUpdated>(`${base}/update`, { hash: check.data?.update?.hash });
    },
    onSuccess: reload,
  });
  const update = check.data?.update ?? null;
  const newer = update ? update.skills.added.length + update.skills.changed.length : 0;
  const url = originUrl(bundle.origin);
  const unused = leftOutSentence(bundle.leftOut);
  return (
    <div className="flex flex-col gap-1.5 rounded-xl bg-paper-2 p-3.5 sm:px-5">
      <p className="font-medium text-[0.875rem]">
        {t("bundle.cameWith", { name: bundle.name, client: formatName(bundle.format) })}
      </p>
      <p className="text-[0.8125rem] text-ink-2">
        {[
          originText(bundle.origin),
          bundle.version ? t("bundle.version", { version: bundle.version }) : "",
          t("bundle.asOf", { when: day(bundle.updatedAt) }),
          broughtSentence(bundle, Boolean(onConnector)),
          unused ?? "",
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
      {url || writable ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          {url ? (
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-8 items-center gap-2 rounded-full bg-card px-3 font-medium text-[0.8125rem] ring-1 ring-border transition hover:bg-accent coarse:h-10"
            >
              <ExternalLink className="size-4" aria-hidden="true" /> {t("bundle.source")}
            </a>
          ) : null}
          {writable && update ? (
            <Button
              size="sm"
              variant="secondary"
              busy={take.isPending}
              onClick={() => take.mutate(null)}
            >
              <RefreshCw className="size-4" />
              {newer
                ? t(newer === 1 ? "bundle.update.skill" : "bundle.update.skills", { n: newer })
                : t("bundle.update")}
            </Button>
          ) : null}
          {writable && bundle.origin.kind === "upload" ? (
            <>
              <Button
                size="sm"
                variant="secondary"
                busy={take.isPending}
                onClick={() => file.current?.click()}
              >
                <Upload className="size-4" /> {t("bundle.update.file")}
              </Button>
              <input
                ref={file}
                type="file"
                accept=".zip,.plugin"
                className="hidden"
                onChange={(e) => {
                  const picked = e.target.files?.[0];
                  e.target.value = "";
                  if (picked) {
                    take.mutate(picked);
                  }
                }}
              />
            </>
          ) : null}
        </div>
      ) : null}
      {writable && update ? (
        <p className="text-[0.8125rem] text-ink-3">{updateSentence(update)}</p>
      ) : null}
      {take.error ? (
        <p className="text-[0.8125rem] text-rose">{(take.error as Error).message}</p>
      ) : null}
      {take.data?.notTaken.map((n) => (
        <p key={n.key} className="text-[0.8125rem] text-rose">
          {t("bundle.update.notTaken", { key: n.key, detail: n.detail })}
        </p>
      ))}
    </div>
  );
}

/** What an update brings, in a sentence: skills new, changed and gone, servers new and gone. */
function updateSentence(update: NonNullable<BundleUpdateAnswer["update"]>): string {
  const parts = [
    update.skills.added.length
      ? t("bundle.update.added", { names: list(update.skills.added) })
      : "",
    update.skills.changed.length
      ? t("bundle.update.changed", { names: list(update.skills.changed) })
      : "",
    update.skills.removed.length
      ? t("bundle.update.removed", { names: list(update.skills.removed) })
      : "",
    update.servers.added.length
      ? t("bundle.update.servers", { names: list(update.servers.added.map((s) => s.key)) })
      : "",
    update.servers.removed.length
      ? t("bundle.update.serversGone", { names: list(update.servers.removed.map((s) => s.name)) })
      : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" ") : t("bundle.update.only");
}

/**
 * The Skills a Connector brought, on its page: each with when it counts, the ones that are off
 * behind a line. They are read only; a copy on the skill's own page is the space's to change.
 */
export function BundleSkills({ bundle, writable }: { bundle: BundleView; writable: boolean }) {
  const reload = useReload(bundle.spaceId);
  const [all, setAll] = useState(false);
  const mode = useMutation({
    mutationFn: ({ id, next }: { id: string; next: SkillMode }) =>
      api.patch(`/api/studio/skills/${id}`, { mode: next }),
    onSuccess: reload,
  });
  if (!bundle.skills.length) {
    return null;
  }
  const on = bundle.skills.filter((k) => k.mode !== "off");
  const off = bundle.skills.length - on.length;
  // While one is switched, the list keeps its place: the skill moves when the page is opened anew.
  const shown = all ? bundle.skills : on;
  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 px-1">
        <h3 className="font-display font-semibold text-base">{t("space.skills")}</h3>
        <span className="text-[0.8125rem] text-ink-3">
          {t("bundle.skills.hint", { n: bundle.skills.length, on: on.length })}
        </span>
      </div>
      {shown.length ? (
        <Card className="flex flex-col divide-y divide-border-soft p-0">
          {shown.map((skill) => (
            <div
              key={skill.id}
              className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5 sm:flex-nowrap"
            >
              <ScrollText className="size-4 shrink-0 text-ink-3" aria-hidden="true" />
              <Link
                to={`/capabilities/skills?show=k:${skill.id}`}
                className="min-w-0 flex-1 rounded-lg max-sm:basis-[calc(100%-2rem)]"
              >
                <span
                  className={cn(
                    "font-medium font-mono text-[0.8125rem] hover:underline",
                    skill.mode === "off" && "text-ink-3",
                  )}
                >
                  {skill.name}
                </span>
                <span className="mt-0.5 block truncate text-[0.8125rem] text-ink-3">
                  {skill.description}
                </span>
              </Link>
              <ModeSwitch
                value={skill.mode}
                disabled={!writable || mode.isPending}
                onChange={(next) => mode.mutate({ id: skill.id, next })}
              />
            </div>
          ))}
        </Card>
      ) : null}
      {mode.error ? (
        <p className="px-1 text-[0.8125rem] text-rose">{(mode.error as Error).message}</p>
      ) : null}
      {off && !all ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[0.8125rem] text-ink-3">
          <span>{t(off === 1 ? "bundle.skills.offOne" : "bundle.skills.off", { n: off })}</span>
          <button type="button" className="underline hover:text-ink" onClick={() => setAll(true)}>
            {t("bundle.skills.showOff")}
          </button>
        </div>
      ) : null}
    </section>
  );
}

/** „Connector, Verbindung und Skills“: what a bundle is made of, as its remove button names it. */
export function partsOf(bundle: Pick<BundleView, "connectors" | "connections" | "skills">): string {
  const parts: string[] = [];
  if (bundle.connectors.length) {
    parts.push(
      t(bundle.connectors.length === 1 ? "bundle.part.connector" : "bundle.part.connectors"),
    );
  }
  if (bundle.connections.length) {
    parts.push(
      t(bundle.connections.length === 1 ? "bundle.part.connection" : "bundle.part.connections"),
    );
  }
  if (bundle.skills.length) {
    parts.push(t(bundle.skills.length === 1 ? "bundle.part.skill" : "bundle.part.skills"));
  }
  return list(parts);
}

/** What goes, and the wizards that use its connection, as the question before removing says it. */
function removalText(name: string, removal: BundleRemoval): string {
  const goes: string[] = [];
  if (removal.connectors.length) {
    goes.push(
      t(removal.connectors.length === 1 ? "bundle.goes.connector" : "bundle.goes.connectors", {
        names: list(removal.connectors.map((c) => c.name)),
      }),
    );
  }
  if (removal.connections.length) {
    goes.push(
      t(removal.connections.length === 1 ? "bundle.goes.connection" : "bundle.goes.connections", {
        names: list(removal.connections.map((c) => c.name)),
      }),
    );
  }
  if (removal.skills.length) {
    goes.push(
      t(removal.skills.length === 1 ? "bundle.goes.skill" : "bundle.goes.skills", {
        n: removal.skills.length,
      }),
    );
  }
  const wizards = removal.wizards.length
    ? t(removal.wizards.length === 1 ? "bundle.goes.wizard" : "bundle.goes.wizards", {
        names: list(removal.wizards.map((w) => t("bundle.quoted", { name: w.title }))),
      })
    : removal.connections.length
      ? t("bundle.goes.noWizard")
      : "";
  return [t("bundle.removeConfirm", { name, what: list(goes) }), wizards, t("bundle.removeUndo")]
    .filter(Boolean)
    .join(" ");
}

/**
 * Removing what came together: asks once, naming the connector, its connections, the skills and
 * the wizards that use a connection, then removes all of it.
 */
export function useBundleRemoval(spaceId: string, onGone?: () => void) {
  const reload = useReload(spaceId);
  return useMutation({
    mutationFn: async (bundle: Pick<BundleView, "id" | "name">) => {
      const base = `/api/studio/bundles/${encodeURIComponent(bundle.id)}`;
      const removal = await api.get<BundleRemoval>(`${base}/removal`);
      if (
        !(await askConfirm(removalText(bundle.name, removal), { action: t("connectors.remove") }))
      ) {
        return false;
      }
      await api.del(base);
      return true;
    },
    onSuccess: async (removed) => {
      if (removed) {
        await reload();
        onGone?.();
      }
    },
  });
}

/** The button that removes a Connector with everything it brought. */
export function BundleRemove({ bundle, onGone }: { bundle: BundleView; onGone?: () => void }) {
  const remove = useBundleRemoval(bundle.spaceId, onGone);
  return (
    <div className="flex flex-col gap-2 px-1">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="min-w-48 flex-1 text-[0.8125rem] text-ink-3">{t("bundle.removeHint")}</p>
        <Button
          variant="danger"
          size="sm"
          busy={remove.isPending}
          onClick={() => remove.mutate(bundle)}
        >
          {t("bundle.remove", { what: partsOf(bundle) })}
        </Button>
      </div>
      {remove.error ? (
        <p className="text-[0.8125rem] text-rose">{(remove.error as Error).message}</p>
      ) : null}
    </div>
  );
}
