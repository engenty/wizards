import type {
  BundleChoice,
  BundleImported,
  BundleImportRequest,
  BundleLeftOut,
  BundleLeftOutKind,
  BundlePreview,
  BundlePreviewAnswer,
  BundleServerChoice,
  BundleServerPreview,
} from "@engenty/wizards-shared/bundles";
import type { SignInChoice } from "@engenty/wizards-shared/connectors";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ScrollText } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { api } from "../lib/api";
import { useFeature } from "../lib/features";
import { type Key, lang, t } from "../lib/i18n";
import { keys } from "../lib/keys";
import { initialsOf } from "../lib/session";
import { Button, Chip, cn } from "../ui";
import {
  choiceReady,
  firstChoice,
  headerChoice,
  idOf,
  needsClient,
  type SourceChoice,
  SourceFields,
  signInOf,
  sourceLine,
} from "./ConnectorByAddress";
import { bundlesKey, formatName, originText } from "./capabilities/Bundle";

/*
 * Weitere Connectors › Per Adresse, for a repository on GitHub or a zip
 * (docs/plans/capabilities-next.md, piece 4): a plugin for Claude Code or Cursor is read and
 * shown before anything is taken. Each MCP server over http becomes a Connector, corrected as a
 * pasted address is; the skills come with it; what engenty does not take is named with why. A
 * repository of several plugins lists them to choose from.
 */

/** Where a plugin is read from: a repository's address, or a file. */
export type PluginSource = { address: string } | { file: File };

/** Whether what was typed is a repository on GitHub rather than a server's address. */
export const isRepoAddress = (typed: string) =>
  /^(https?:\/\/)?(www\.)?github\.com\/[^/\s]+\/[^/\s]+/i.test(typed.trim());

/** A request about a plugin: JSON for an address, a form with the file beside it for a zip. */
function send<T>(url: string, source: PluginSource, options: Record<string, unknown>) {
  if ("file" in source) {
    const form = new FormData();
    form.set("file", source.file);
    form.set("options", JSON.stringify(options));
    return api.post<T>(url, form);
  }
  return api.post<T>(url, { address: source.address, ...options });
}

interface ReadRequest {
  source: PluginSource;
  path?: string;
  /** The key an admin typed for a server, to list its actions now. */
  servers?: Record<string, { signIn: SignInChoice }>;
}

export interface PluginRead {
  read: (source: PluginSource, more?: Omit<ReadRequest, "source">) => void;
  /** What the last reading found, and where it was read from. */
  found: (ReadRequest & { answer: BundlePreviewAnswer }) | null;
  pending: boolean;
  error: string | null;
  reset: () => void;
}

/** Reads a plugin from a repository or a zip; reading again keeps what was found until then. */
export function usePluginPreview(spaceId: string): PluginRead {
  const [found, setFound] = useState<PluginRead["found"]>(null);
  const check = useMutation({
    mutationFn: ({ source, path, servers }: ReadRequest) =>
      send<BundlePreviewAnswer>(`/api/studio/spaces/${spaceId}/bundles/preview`, source, {
        ...(path ? { path } : {}),
        ...(servers ? { servers } : {}),
      }),
    onSuccess: (answer, request) => setFound({ ...request, answer }),
  });
  return {
    read: (source, more) => check.mutate({ source, ...more }),
    found,
    pending: check.isPending,
    error: check.error ? (check.error as Error).message : null,
    reset: () => {
      setFound(null);
      check.reset();
    },
  };
}

const LEFT_OUT_KINDS: Record<Exclude<BundleLeftOutKind, "server" | "skill">, [Key, Key]> = {
  command: ["bundle.leftOut.command.one", "bundle.leftOut.command.n"],
  agent: ["bundle.leftOut.agent.one", "bundle.leftOut.agent.n"],
  hook: ["bundle.leftOut.hook.one", "bundle.leftOut.hook.n"],
  rule: ["bundle.leftOut.rule.one", "bundle.leftOut.rule.n"],
  other: ["bundle.leftOut.other", "bundle.leftOut.other"],
};

/** A few names, and how many more there are. */
function someNames(names: string[]): string {
  const shown = names.slice(0, 6).join(", ");
  return names.length > 6 ? t("bundle.leftOut.more", { names: shown, n: names.length - 6 }) : shown;
}

/** What a plugin holds that engenty does not take, one line per kind, a server or skill each with why. */
export function leftOutLines(leftOut: BundleLeftOut[]): string[] {
  const lines: string[] = [];
  for (const kind of Object.keys(LEFT_OUT_KINDS) as (keyof typeof LEFT_OUT_KINDS)[]) {
    const names = leftOut.filter((l) => l.kind === kind).map((l) => l.name);
    if (names.length) {
      const [one, many] = LEFT_OUT_KINDS[kind];
      lines.push(t(names.length === 1 ? one : many, { n: names.length, names: someNames(names) }));
    }
  }
  for (const l of leftOut) {
    if (l.kind === "server" || l.kind === "skill") {
      const why =
        l.detail ?? (l.reason ? t(`bundle.reason.${l.reason}`) : t("bundle.reason.leftOut"));
      lines.push(t(`bundle.leftOut.${l.kind}`, { name: l.name, why }));
    }
  }
  return lines;
}

/** `slack` → `Slack`: a connector's name where the admin gives none. */
const nameOf = (key: string) => `${key.slice(0, 1).toUpperCase()}${key.slice(1)}`;

interface ServerState {
  take: boolean;
  open: boolean;
  choice: SourceChoice;
}

const firstState = (server: BundleServerPreview, open: boolean): ServerState => ({
  take: true,
  open,
  choice: firstChoice(server.source, { name: nameOf(server.key), keyHeader: server.keyHeader }),
});

/** The plugins of a repository that holds several: one is looked at. */
function Choices({
  plugins,
  pending,
  onPick,
}: {
  plugins: BundleChoice[];
  pending: boolean;
  onPick: (choice: BundleChoice) => void;
}) {
  return (
    <div className="flex flex-col gap-2 border-border-soft border-t pt-4">
      <p className="text-[0.8125rem] text-ink-2">{t("connectors.plugin.several")}</p>
      <ul className="flex max-h-96 flex-col divide-y divide-border-soft overflow-y-auto rounded-lg bg-card ring-1 ring-border-soft">
        {plugins.map((plugin) => (
          <li key={plugin.path ?? plugin.address} className="flex items-center gap-3 px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium text-[0.875rem]">{plugin.name}</div>
              {plugin.description ? (
                <div className="truncate text-[0.75rem] text-ink-3">{plugin.description}</div>
              ) : null}
            </div>
            <Button size="sm" variant="secondary" disabled={pending} onClick={() => onPick(plugin)}>
              {t("skills.open")}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function PluginPreview({
  spaceId,
  taken,
  plugin,
  onCancel,
  onDone,
}: {
  spaceId: string;
  /** The ids of the space's connectors: a short name must be a new one. */
  taken: string[];
  plugin: PluginRead;
  onCancel: () => void;
  /** It was taken: with a connector, „Verbindung hinzufügen“ opens with the first. */
  onDone: (connectorId: string | null) => void;
}) {
  const found = plugin.found;
  const preview = found?.answer.preview ?? null;
  if (!found) {
    return null;
  }
  if (!preview) {
    return (
      <>
        <Choices
          plugins={found.answer.plugins}
          pending={plugin.pending}
          onPick={(choice) =>
            choice.path !== null
              ? plugin.read(found.source, { path: choice.path })
              : choice.address
                ? plugin.read({ address: choice.address })
                : undefined
          }
        />
        {plugin.error ? <p className="text-[0.8125rem] text-rose">{plugin.error}</p> : null}
      </>
    );
  }
  return (
    <Found
      key={preview.hash}
      spaceId={spaceId}
      taken={taken}
      plugin={plugin}
      preview={preview}
      onCancel={onCancel}
      onDone={onDone}
    />
  );
}

function Found({
  spaceId,
  taken,
  plugin,
  preview,
  onCancel,
  onDone,
}: {
  spaceId: string;
  taken: string[];
  plugin: PluginRead;
  preview: BundlePreview;
  onCancel: () => void;
  onDone: (connectorId: string | null) => void;
}) {
  const qc = useQueryClient();
  const skillsOn = useFeature("skills");
  const single = preview.servers.length === 1;
  const [servers, setServers] = useState<Record<string, ServerState>>(() =>
    Object.fromEntries(preview.servers.map((s) => [s.key, firstState(s, single)])),
  );
  /** The skills the admin left out, by their folder. */
  const [without, setWithout] = useState<string[]>([]);
  /** The server whose actions are read again with its key. */
  const [reading, setReading] = useState<string | null>(null);
  const [done, setDone] = useState<BundleImported | null>(null);

  // Read again with a key: what was set stays, a kind of an action that is gone goes.
  useEffect(() => {
    setServers((old) =>
      Object.fromEntries(
        preview.servers.map((s) => {
          const before = old[s.key];
          return [
            s.key,
            before
              ? {
                  ...before,
                  choice: {
                    ...before.choice,
                    kinds: Object.fromEntries(
                      Object.entries(before.choice.kinds).filter(([id]) =>
                        s.source.actions.some((a) => a.id === id),
                      ),
                    ),
                  },
                }
              : firstState(s, single),
          ];
        }),
      ),
    );
  }, [preview.servers, single]);

  const found = plugin.found;
  const set = (key: string, patch: Partial<ServerState>) =>
    setServers((old) => ({ ...old, [key]: { ...old[key], ...patch } }));
  const takenServers = preview.servers.filter((s) => servers[s.key]?.take);
  const takenSkills = preview.skills.filter((k) => !without.includes(k.path));
  // A short name must be new among the space's connectors and the plugin's other servers.
  const takenBy = (key: string) => [
    ...taken,
    ...takenServers.filter((s) => s.key !== key).map((s) => idOf(servers[s.key].choice.short)),
  ];
  const ready =
    takenServers.every((s) => choiceReady(s.source, servers[s.key].choice, takenBy(s.key))) &&
    takenServers.length + takenSkills.length > 0 &&
    takenSkills.length <= preview.skillsFree;

  const run = useMutation({
    mutationFn: () => {
      if (!found) {
        throw new Error("nothing read");
      }
      const request: BundleImportRequest = {
        hash: preview.hash,
        servers: Object.fromEntries(
          preview.servers.map((s): [string, BundleServerChoice] => {
            const state = servers[s.key];
            if (!state?.take) {
              return [s.key, { take: false }];
            }
            const c = state.choice;
            return [
              s.key,
              {
                id: idOf(c.short),
                toolPrefix: c.short,
                name: c.name.trim() || nameOf(s.key),
                signIn: signInOf(c),
                ...(Object.keys(c.kinds).length ? { actionKinds: c.kinds } : {}),
                ...(needsClient(s.source, c) && c.client.id && c.client.secret
                  ? { oauthClientId: c.client.id, oauthClientSecret: c.client.secret }
                  : {}),
              },
            ];
          }),
        ),
        ...(without.length ? { skills: takenSkills.map((k) => k.path) } : {}),
      };
      return send<BundleImported>(`/api/studio/spaces/${spaceId}/bundles`, found.source, {
        ...(found.path ? { path: found.path } : {}),
        ...request,
      });
    },
    onSuccess: async (made) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: keys.connectors(spaceId) }),
        qc.invalidateQueries({ queryKey: keys.skills(spaceId) }),
        qc.invalidateQueries({ queryKey: bundlesKey(spaceId) }),
      ]);
      // With a connector the connection is next; skills alone are there, and the form says so.
      if (made.connectors.length) {
        onDone(made.connectors[0].id);
      } else {
        setDone(made);
      }
    },
  });

  if (done) {
    return (
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-border-soft border-t pt-4">
        <p className="min-w-48 flex-1 text-[0.875rem] text-ink-2">
          {t(
            done.bundle.skills.length === 1
              ? "connectors.plugin.doneOne"
              : "connectors.plugin.done",
            {
              name: done.bundle.name,
              n: done.bundle.skills.length,
            },
          )}
        </p>
        <Link
          to="/capabilities/skills"
          className="font-medium text-[0.8125rem] underline hover:text-ink"
        >
          {t("connectors.plugin.toSkills")}
        </Link>
        <Button variant="ghost" size="sm" onClick={() => onDone(null)}>
          {t("connectors.plugin.close")}
        </Button>
      </div>
    );
  }

  const leftOut = leftOutLines(preview.leftOut);
  const readAgain = (server: BundleServerPreview) => {
    if (!found) {
      return;
    }
    setReading(server.key);
    plugin.read(found.source, {
      ...(found.path ? { path: found.path } : {}),
      servers: { [server.key]: { signIn: headerChoice(servers[server.key].choice, true) } },
    });
  };

  return (
    <div className="flex flex-col gap-6 border-border-soft border-t pt-4">
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-paper-2 font-semibold text-[0.875rem] text-ink-2"
        >
          {initialsOf(preview.name) || "?"}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-display font-semibold text-[0.9375rem]">{preview.name}</div>
          <div className="truncate text-[0.75rem] text-ink-3">
            {[
              t("bundle.pluginFor", { client: formatName(preview.format) }),
              originText(preview.origin),
              preview.version ? t("bundle.version", { version: preview.version }) : "",
            ]
              .filter(Boolean)
              .join(" · ")}
          </div>
        </div>
        <Chip tone="warn" title={t("connectors.plugin.uncheckedHint")}>
          {t("connectors.unchecked")}
        </Chip>
      </div>
      {preview.description ? (
        <p className="-mt-3 line-clamp-2 text-[0.8125rem] text-ink-2">{preview.description}</p>
      ) : null}
      {preview.added ? (
        <p className="text-[0.8125rem] text-ink-2">{t("connectors.plugin.added")}</p>
      ) : null}

      <section className="flex flex-col gap-2">
        <div>
          <h4 className="font-semibold text-[0.875rem]">
            {t(
              preview.servers.length === 1
                ? "connectors.plugin.connector"
                : "connectors.plugin.connectors",
            )}
          </h4>
          <p className="mt-0.5 text-[0.8125rem] text-ink-3">
            {preview.servers.length
              ? t("connectors.plugin.connectorsHint")
              : preview.leftOut.some((l) => l.kind === "server")
                ? t("connectors.plugin.noneTaken")
                : t("connectors.plugin.noServer")}
          </p>
        </div>
        {preview.servers.map((server) => {
          const state = servers[server.key];
          if (!state) {
            return null;
          }
          const shown = state.choice.name.trim() || nameOf(server.key);
          return (
            <div key={server.key} className="rounded-lg bg-paper ring-1 ring-border-soft">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2 p-3">
                {single && !preview.skills.length ? null : (
                  <input
                    type="checkbox"
                    className="size-4 shrink-0 accent-ember"
                    aria-label={t("connectors.plugin.take", { name: shown })}
                    checked={state.take}
                    onChange={(e) => set(server.key, { take: e.target.checked })}
                  />
                )}
                <div className={cn("min-w-0 flex-1 basis-44", !state.take && "opacity-60")}>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="truncate font-medium text-[0.875rem]">{shown}</span>
                    <span className="font-mono text-[0.6875rem] text-ink-4">{server.key}</span>
                  </div>
                  <div className="truncate text-[0.75rem] text-ink-3">
                    {sourceLine(server.source)}
                  </div>
                </div>
                {state.take && !single ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-expanded={state.open}
                    onClick={() => set(server.key, { open: !state.open })}
                  >
                    {t("connectors.plugin.adjust")}
                    <ChevronDown
                      className={cn("size-4 transition", state.open && "rotate-180")}
                      aria-hidden="true"
                    />
                  </Button>
                ) : null}
              </div>
              {state.take && state.open ? (
                <div className="flex flex-col gap-5 border-border-soft border-t p-3 sm:p-4">
                  {server.source.privateAddress ? (
                    <p className="text-[0.8125rem] text-ink-3">{t("connectors.address.private")}</p>
                  ) : null}
                  {server.source.blockers.map((b) => (
                    <p key={b} className="text-[0.8125rem] text-rose">
                      {b}
                    </p>
                  ))}
                  {server.headers.length ? (
                    <p className="text-[0.8125rem] text-ink-3">
                      {t("connectors.plugin.headers", { names: server.headers.join(", ") })}
                    </p>
                  ) : null}
                  <SourceFields
                    preview={server.source}
                    value={state.choice}
                    onChange={(choice) => set(server.key, { choice })}
                    taken={takenBy(server.key)}
                    onRead={() => readAgain(server)}
                    reading={plugin.pending && reading === server.key}
                    readError={reading === server.key ? plugin.error : null}
                  />
                </div>
              ) : null}
            </div>
          );
        })}
      </section>

      {skillsOn ? (
        <section className="flex flex-col gap-2">
          <div>
            <h4 className="flex items-baseline gap-2 font-semibold text-[0.875rem]">
              {t("space.skills")}
              {preview.skills.length ? (
                <span className="font-normal text-[0.8125rem] text-ink-3">
                  {takenSkills.length === preview.skills.length
                    ? preview.skills.length.toLocaleString(lang)
                    : t("connectors.plugin.skillsOf", {
                        n: takenSkills.length,
                        all: preview.skills.length,
                      })}
                </span>
              ) : null}
            </h4>
            <p className="mt-0.5 text-[0.8125rem] text-ink-3">
              {preview.skills.length
                ? t("connectors.plugin.skillsHint")
                : t("connectors.plugin.noSkills")}
            </p>
          </div>
          {preview.skills.length ? (
            <ul className="flex max-h-96 flex-col divide-y divide-border-soft overflow-y-auto rounded-lg bg-card ring-1 ring-border-soft">
              {preview.skills.map((skill) => {
                const on = !without.includes(skill.path);
                return (
                  <li key={skill.path}>
                    <label className="flex cursor-pointer items-center gap-3 px-3 py-2.5">
                      <input
                        type="checkbox"
                        className="size-4 shrink-0 accent-ember"
                        checked={on}
                        onChange={(e) =>
                          setWithout((old) =>
                            e.target.checked
                              ? old.filter((p) => p !== skill.path)
                              : [...old, skill.path],
                          )
                        }
                      />
                      <ScrollText className="size-4 shrink-0 text-ink-3" aria-hidden="true" />
                      <span className={cn("min-w-0 flex-1", !on && "opacity-60")}>
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="font-medium font-mono text-[0.8125rem]">
                            {skill.name}
                          </span>
                          {skill.scripts ? (
                            <Chip title={t("connectors.plugin.scriptsHint")}>
                              {t("connectors.plugin.scripts")}
                            </Chip>
                          ) : null}
                        </span>
                        <span className="mt-0.5 block truncate text-[0.75rem] text-ink-3">
                          {skill.description}
                        </span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {takenSkills.length > preview.skillsFree ? (
            <p className="text-[0.8125rem] text-rose">
              {t("connectors.plugin.skillsFull", { n: preview.skillsFree })}
            </p>
          ) : null}
        </section>
      ) : null}

      {leftOut.length ? (
        <section className="flex flex-col gap-1.5">
          <h4 className="font-semibold text-[0.875rem]">{t("connectors.plugin.leftOut")}</h4>
          <ul className="flex flex-col gap-1 text-[0.8125rem] text-ink-3">
            {leftOut.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {run.error ? (
        <p className="text-[0.8125rem] text-rose">{(run.error as Error).message}</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button
          busy={run.isPending}
          disabled={!ready || Boolean(preview.added)}
          onClick={() => run.mutate()}
        >
          {t("connectors.import")}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          {t("orgSettings.cancel")}
        </Button>
        {takenServers.length ? (
          <span className="min-w-48 flex-1 text-[0.8125rem] text-ink-3">
            {t("connectors.address.after")}
          </span>
        ) : null}
      </div>
    </div>
  );
}
