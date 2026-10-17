import type {
  ConnectorView,
  ImportRequest,
  RegistryHit,
  RegistryService,
  RegistrySource,
} from "@engenty-wizards/shared/connectors";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Plug, RefreshCw, Search, Trash2 } from "lucide-react";
import { useState } from "react";
import { api } from "../lib/api";
import { useFeature } from "../lib/features";
import { t } from "../lib/i18n";
import { Button, Card, Chip, cn, IconButton, Input, Spinner } from "../ui";

/** A connector the product ships with: ready, or waiting for the server's OAuth client. */
function Builtin({ connector }: { connector: ConnectorView }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg bg-paper ring-1 ring-border-soft">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-3 px-3 py-2 text-left"
      >
        <span
          className={cn("size-2 shrink-0 rounded-full", connector.usable ? "bg-moss" : "bg-ink-4")}
        />
        <span className="min-w-0 flex-1 truncate text-[0.8125rem]">
          {connector.name}{" "}
          <span className="font-mono text-[0.6875rem] text-ink-4">{connector.id}</span>
        </span>
        <span className="shrink-0 text-[0.75rem] text-ink-3">
          {connector.usable
            ? t("connectors.actions", {
                n: connector.actions.length,
                r: connector.actions.filter((a) => a.group === "read").length,
              })
            : t("connectors.notSetUp")}
        </span>
      </button>
      {open ? (
        <div className="border-border-soft border-t px-3 py-2 text-[0.75rem]">
          {connector.missingSetup ? (
            <p className="mb-1 text-ink-3">
              {t("connectors.setup")}{" "}
              <span className="font-mono text-ink-2">{connector.missingSetup}</span>
            </p>
          ) : null}
          <p className="text-ink-4">
            {connector.actions
              .map((a) =>
                a.group === "read" ? a.id : `${a.id} (${t(`connectors.group.${a.group}`)})`,
              )
              .join(" · ")}
          </p>
        </div>
      ) : null}
    </div>
  );
}

const AUTH_LABEL: Record<ConnectorView["auth"], string> = {
  none: "connectors.authNone",
  oauth2: "connectors.authOauth",
  api_key: "connectors.authKey",
};

function Imported({
  projectId,
  connector,
  readOnly,
}: {
  projectId: string;
  connector: ConnectorView;
  readOnly?: boolean;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const done = () => qc.invalidateQueries({ queryKey: ["connectors", projectId] });
  const base = `/api/studio/projects/${projectId}/connectors/${connector.id}`;
  const refresh = useMutation({ mutationFn: () => api.post(`${base}/refresh`), onSuccess: done });
  const remove = useMutation({ mutationFn: () => api.del(base), onSuccess: done });
  const reads = connector.actions.filter((a) => a.group === "read").length;
  return (
    <div className="rounded-lg bg-paper ring-1 ring-border-soft">
      <div className="flex items-center gap-3 p-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-paper-2 text-ink-2">
          <Plug className="size-4" />
        </div>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="min-w-0 flex-1 text-left"
        >
          <div className="flex items-center gap-2">
            <span className="truncate font-medium text-[0.875rem]">{connector.name}</span>
            <span className="font-mono text-[0.6875rem] text-ink-4">{connector.id}</span>
          </div>
          <div className="truncate text-[0.75rem] text-ink-3">
            {connector.domain} · {connector.sourceKind === "mcp" ? "MCP" : "OpenAPI"} ·{" "}
            {t(AUTH_LABEL[connector.auth] as "connectors.authNone")} ·{" "}
            {connector.toolsPending
              ? t("connectors.pending")
              : t("connectors.actions", {
                  n: connector.actions.length,
                  r: reads,
                })}
          </div>
        </button>
        {readOnly ? null : (
          <>
            <IconButton label={t("connectors.refresh")} onClick={() => refresh.mutate()}>
              {refresh.isPending ? (
                <Spinner className="size-4" />
              ) : (
                <RefreshCw className="size-4" />
              )}
            </IconButton>
            <IconButton
              label={t("connectors.remove")}
              className="hover:text-rose"
              onClick={() =>
                confirm(t("connectors.removeConfirm", { name: connector.name })) && remove.mutate()
              }
            >
              <Trash2 className="size-4" />
            </IconButton>
          </>
        )}
      </div>
      {connector.needsOAuthClient ? (
        <p className="border-border-soft border-t px-3 py-2 text-[0.75rem] text-rose">
          {t("connectors.needsClient")}
        </p>
      ) : null}
      {(refresh.error ?? remove.error) ? (
        <p className="border-border-soft border-t px-3 py-2 text-[0.75rem] text-rose">
          {((refresh.error ?? remove.error) as Error).message}
        </p>
      ) : null}
      {open && connector.actions.length ? (
        <ul className="max-h-64 overflow-y-auto border-border-soft border-t px-3 py-2">
          {connector.actions.map((a) => (
            <li key={a.id} className="flex items-baseline gap-2 py-1 text-[0.75rem]">
              <span
                className={cn(
                  "w-14 shrink-0 text-[0.6875rem] uppercase tracking-wide",
                  a.group === "read"
                    ? "text-moss"
                    : a.group === "write"
                      ? "text-ink-3"
                      : "text-rose",
                )}
              >
                {t(`connectors.group.${a.group}` as "connectors.group.read")}
              </span>
              <span className="shrink-0 font-mono text-ink-2">{a.id}</span>
              <span className="min-w-0 truncate text-ink-4">{a.summary}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function SourceRow({
  projectId,
  domain,
  source,
  taken,
  onDone,
}: {
  projectId: string;
  domain: string;
  source: RegistrySource;
  taken: string[];
  onDone: (warnings: string[]) => void;
}) {
  const qc = useQueryClient();
  const [client, setClient] = useState({ id: "", secret: "" });
  const [credentials, setCredentials] = useState(false);
  const exists = taken.includes(source.suggestedId);
  const run = useMutation({
    mutationFn: () =>
      api.post<{ connector: ConnectorView; warnings: string[] }>(
        `/api/studio/projects/${projectId}/connectors`,
        {
          domain,
          sourceKind: source.sourceKind,
          sourceUrl: source.sourceUrl,
          id: source.suggestedId,
          toolPrefix: source.suggestedToolPrefix,
          ...(source.name ? { name: source.name } : {}),
          ...(client.id && client.secret
            ? { oauthClientId: client.id, oauthClientSecret: client.secret }
            : {}),
        } satisfies ImportRequest,
      ),
    onSuccess: async (result) => {
      await qc.invalidateQueries({ queryKey: ["connectors", projectId] });
      onDone(result.warnings);
    },
  });
  return (
    <div className="rounded-lg bg-card p-3 ring-1 ring-border-soft">
      <div className="flex items-center gap-3">
        <Chip tone={source.sourceKind === "mcp" ? "ember" : "neutral"}>
          {source.sourceKind === "mcp" ? "MCP" : "OpenAPI"}
        </Chip>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[0.8125rem]">{source.name ?? source.suggestedId}</div>
          <div className="truncate font-mono text-[0.6875rem] text-ink-4">{source.sourceUrl}</div>
        </div>
        {source.blocked || exists ? null : (
          <>
            <button
              type="button"
              onClick={() => setCredentials((v) => !v)}
              className="text-[0.75rem] text-ink-3 hover:text-ink"
            >
              {t("connectors.ownClient")}
            </button>
            <Button size="sm" busy={run.isPending} onClick={() => run.mutate()}>
              {t("connectors.import")}
            </Button>
          </>
        )}
      </div>
      {source.blocked ? <p className="mt-2 text-[0.75rem] text-ink-3">{source.blocked}</p> : null}
      {exists ? <p className="mt-2 text-[0.75rem] text-ink-3">{t("connectors.exists")}</p> : null}
      {credentials ? (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <Input
            placeholder={t("connectors.clientId")}
            value={client.id}
            onChange={(e) => setClient((c) => ({ ...c, id: e.target.value }))}
          />
          <Input
            type="password"
            autoComplete="off"
            placeholder={t("connectors.clientSecret")}
            value={client.secret}
            onChange={(e) => setClient((c) => ({ ...c, secret: e.target.value }))}
          />
        </div>
      ) : null}
      {run.error ? (
        <p className="mt-2 text-[0.75rem] text-rose">{(run.error as Error).message}</p>
      ) : null}
    </div>
  );
}

/**
 * The project's connectors: any service becomes one, found in the integrations registry by name
 * and imported from its OpenAPI spec or its MCP server. `readOnly`: the project is not changed
 * here, so the list is shown and nothing is imported, refreshed or removed.
 */
export function Connectors({ projectId, readOnly }: { projectId: string; readOnly?: boolean }) {
  const unsetConnectors = useFeature("unsetConnectors");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<RegistryHit[] | null>(null);
  const [service, setService] = useState<RegistryService | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const list = useQuery({
    queryKey: ["connectors", projectId],
    queryFn: () => api.get<ConnectorView[]>(`/api/studio/projects/${projectId}/connectors`),
  });
  const search = useMutation({
    mutationFn: () => api.post<RegistryHit[]>("/api/studio/connectors/search", { query }),
    onSuccess: (found) => {
      setHits(found);
      setService(null);
      setWarnings([]);
    },
  });
  const open = useMutation({
    mutationFn: (domain: string) =>
      api.get<RegistryService>(`/api/studio/connectors/registry/${encodeURIComponent(domain)}`),
    onSuccess: setService,
  });
  const connectors = list.data ?? [];
  const builtin = connectors.filter(
    (c) => c.sourceKind === "builtin" && (unsetConnectors || c.usable),
  );
  const imported = connectors.filter((c) => c.sourceKind !== "builtin");
  return (
    <Card className="p-4 sm:p-6">
      <h2 className="font-display font-semibold text-lg">{t("connectors.title")}</h2>
      <p className="mt-1 mb-5 text-[0.875rem] text-ink-3">{t("connectors.hint")}</p>
      {builtin.length ? (
        <div className="mb-5 grid gap-1.5 sm:grid-cols-2">
          {builtin.map((c) => (
            <Builtin key={c.id} connector={c} />
          ))}
        </div>
      ) : null}
      <h3 className="mb-2 font-medium text-[0.75rem] text-ink-3 uppercase tracking-[0.07em]">
        {t("connectors.imported")}
      </h3>
      {imported.length ? (
        <div className="mb-4 flex flex-col gap-2">
          {imported.map((c) => (
            <Imported key={c.id} projectId={projectId} connector={c} readOnly={readOnly} />
          ))}
        </div>
      ) : null}
      {readOnly ? (
        imported.length ? null : (
          <p className="text-[0.8125rem] text-ink-3">{t("connectors.noneImported")}</p>
        )
      ) : (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (query.trim()) {
              search.mutate();
            }
          }}
        >
          <Input
            value={query}
            placeholder={t("connectors.search")}
            onChange={(e) => setQuery(e.target.value)}
          />
          <Button type="submit" variant="secondary" busy={search.isPending}>
            <Search className="size-4" /> {t("connectors.find")}
          </Button>
        </form>
      )}
      {search.error ? (
        <p className="mt-3 text-[0.8125rem] text-rose">{(search.error as Error).message}</p>
      ) : null}
      {hits && !service ? (
        <div className="mt-3 flex flex-col gap-1">
          {hits.length ? null : (
            <p className="text-[0.8125rem] text-ink-3">{t("connectors.none")}</p>
          )}
          {hits.map((hit) => (
            <button
              key={hit.domain}
              type="button"
              disabled={!hit.kinds.length}
              onClick={() => open.mutate(hit.domain)}
              className="flex items-center gap-3 rounded-lg px-3 py-2 text-left transition hover:bg-paper-2 disabled:opacity-50"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-[0.875rem]">{hit.domain}</div>
                <div className="truncate text-[0.75rem] text-ink-3">{hit.description}</div>
              </div>
              <span className="text-[0.6875rem] text-ink-4 uppercase">{hit.kinds.join(" · ")}</span>
              <ChevronDown className="-rotate-90 size-4 text-ink-4" />
            </button>
          ))}
          {open.isPending ? <Spinner className="mx-auto mt-2 size-4 text-ink-4" /> : null}
          {open.error ? (
            <p className="text-[0.8125rem] text-rose">{(open.error as Error).message}</p>
          ) : null}
        </div>
      ) : null}
      {service ? (
        <div className="mt-4 flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-3">
            <div className="font-medium text-[0.875rem]">{service.domain}</div>
            <button
              type="button"
              onClick={() => setService(null)}
              className="text-[0.75rem] text-ink-3 hover:text-ink"
            >
              {t("run.back")}
            </button>
          </div>
          {service.summary ? (
            <p className="text-[0.8125rem] text-ink-3">{service.summary}</p>
          ) : null}
          {service.sources.map((source) => (
            <SourceRow
              key={`${source.sourceKind}:${source.sourceUrl}`}
              projectId={projectId}
              domain={service.domain}
              source={source}
              taken={connectors.map((c) => c.id)}
              onDone={setWarnings}
            />
          ))}
          {service.credentials
            .filter((c) => c.setup || c.url)
            .map((c) => (
              <p key={c.label} className="text-[0.75rem] text-ink-3">
                <span className="text-ink-2">{c.label}:</span> {c.setup}{" "}
                {c.url ? (
                  <a href={c.url} target="_blank" rel="noreferrer" className="text-ember underline">
                    {c.url}
                  </a>
                ) : null}
              </p>
            ))}
          {warnings.map((w) => (
            <p key={w} className="text-[0.75rem] text-ink-3">
              {w}
            </p>
          ))}
        </div>
      ) : null}
    </Card>
  );
}
