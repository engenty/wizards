import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, RotateCw, TriangleAlert, Upload } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import { api } from "../lib/api";
import { type Key, t } from "../lib/i18n";
import { DropArea, Section } from "../studio/project/Section";
import { Button, Chip, Dialog, IconButton, Input, Spinner, Switch } from "../ui";
import { reloadPlugins, useStudioPlugins } from "./host";
import { HELD, type ProModule, ProPlanSection, usePro } from "./ProModulesSection";

type Origin = "builtin" | "pro" | "installed" | "folder";

/** A plugin this computer has, switched on or off (`/-/all`). */
interface Found {
  id: string;
  name: string;
  version: string;
  description: string;
  origin: Origin;
  on: boolean;
  root: string;
  error: string | null;
  tools: string[];
}

const ALL = ["plugins-all"];

const ORIGINS: Record<Origin, Key> = {
  builtin: "plugins.originBuiltin",
  pro: "plugins.originPro",
  installed: "plugins.originInstalled",
  folder: "plugins.originFolder",
};

/**
 * Settings › Plugins › Overview on a runtime that runs alone: every plugin in one list, where it
 * came from, on or off, and the Pro plugins of the plan that are not installed yet. Plugins of
 * your own come as a zip or a folder; nobody checked them, and the dialog says so.
 */
export function PluginList() {
  const qc = useQueryClient();
  const studio = useStudioPlugins();
  const pro = usePro(true);
  const all = useQuery({
    queryKey: ALL,
    queryFn: () => api.get<{ plugins: Found[]; dir: string }>("/api/studio/plugins/-/all"),
  });
  const keep = (next: { plugins: Found[] }) =>
    qc.setQueryData(ALL, (old: { dir: string } | undefined) => ({ ...old, ...next }));
  const toggle = useMutation({
    mutationFn: ({ id, on }: { id: string; on: boolean }) =>
      api.put<{ plugins: Found[] }>(`/api/studio/plugins/-/all/${id}`, { on }),
    onSuccess: keep,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del<{ plugins: Found[] }>(`/api/studio/plugins/-/all/${id}`),
    onSuccess: keep,
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const reload = async (id?: string) => {
    setBusy(id ?? "*");
    try {
      await reloadPlugins(id);
      await all.refetch();
    } finally {
      setBusy(null);
    }
  };
  const found = all.data?.plugins ?? [];
  const proOf = (id: string) => pro.state.data?.modules.find((m) => m.id === id);
  // The plan's Pro plugins that are not here: not installed, or held back.
  const offered = (pro.state.data?.modules ?? []).filter((m) => !found.some((f) => f.id === m.id));
  const failure = (toggle.error ??
    remove.error ??
    pro.install.error ??
    pro.remove.error) as Error | null;
  const working = toggle.isPending || remove.isPending || pro.install.isPending;
  return (
    <div className="flex flex-col gap-9">
      <Section
        title={t("plugins.title")}
        hint={t("plugins.hint")}
        action={
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" busy={busy === "*"} onClick={() => void reload()}>
              {t("plugins.rescan")}
            </Button>
            <Button size="sm" onClick={() => setAdding(true)}>
              <Plus className="size-4" /> {t("plugins.add")}
            </Button>
          </div>
        }
      >
        {!all.data ? (
          <Spinner />
        ) : found.length || offered.length || studio.problems.length ? (
          <ul className="divide-y divide-border-soft">
            {found.map((plugin) => {
              const m = proOf(plugin.id);
              return (
                <Row
                  key={plugin.id}
                  name={plugin.name}
                  id={plugin.id}
                  version={plugin.version}
                  description={plugin.description}
                  chips={
                    <>
                      <Chip tone={plugin.origin === "installed" ? "warn" : "neutral"}>
                        {t(ORIGINS[plugin.origin])}
                      </Chip>
                      {plugin.on ? null : <Chip>{t("plugins.off")}</Chip>}
                    </>
                  }
                  tools={plugin.tools}
                  error={
                    plugin.error
                      ? t("plugins.serverFailed", { error: plugin.error })
                      : studio.failed[plugin.id]
                        ? t("plugins.studioFailed", { error: studio.failed[plugin.id] ?? "" })
                        : null
                  }
                  actions={
                    <>
                      {m?.update ? (
                        <Button
                          size="sm"
                          busy={pro.install.isPending && pro.install.variables === m.id}
                          disabled={working}
                          onClick={() => pro.install.mutate(m.id)}
                        >
                          {t("pro.update")}
                        </Button>
                      ) : null}
                      {plugin.origin === "installed" || plugin.origin === "pro" ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={working}
                          onClick={() =>
                            plugin.origin === "pro"
                              ? pro.remove.mutate(plugin.id)
                              : remove.mutate(plugin.id)
                          }
                        >
                          {t("plugins.remove")}
                        </Button>
                      ) : null}
                      <IconButton
                        label={t("plugins.reload")}
                        disabled={busy !== null || !plugin.on}
                        onClick={() => void reload(plugin.id)}
                      >
                        <RotateCw
                          className={busy === plugin.id ? "size-4 animate-spin" : "size-4"}
                        />
                      </IconButton>
                      <Switch
                        checked={plugin.on}
                        label={plugin.name}
                        disabled={working}
                        onChange={(on) => toggle.mutate({ id: plugin.id, on })}
                      />
                    </>
                  }
                />
              );
            })}
            {offered.map((m) => (
              <OfferedRow
                key={m.id}
                m={m}
                busy={pro.install.isPending && pro.install.variables === m.id}
                disabled={working}
                onInstall={() => pro.install.mutate(m.id)}
              />
            ))}
            {studio.problems.map((problem) => (
              <li key={problem.path} className="py-4 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                  <Chip tone="warn">{t("plugins.problems")}</Chip>
                  <span className="break-all font-mono text-[0.75rem] text-ink-3">
                    {problem.path}
                  </span>
                </div>
                <p className="mt-1.5 text-[0.8125rem] text-ink-3">{problem.message}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[0.875rem] text-ink-3">{t("plugins.none")}</p>
        )}
        {failure ? <p className="mt-4 text-[0.8125rem] text-rose">{failure.message}</p> : null}
      </Section>
      <ProPlanSection pro={pro} />
      <AddDialog open={adding} onClose={() => setAdding(false)} onDone={keep} />
    </div>
  );
}

function Row({
  name,
  id,
  version,
  description,
  chips,
  tools = [],
  error,
  actions,
}: {
  name: string;
  id: string;
  version: string;
  description: string;
  chips: ReactNode;
  tools?: string[];
  error?: string | null;
  actions: ReactNode;
}) {
  return (
    <li className="flex items-start gap-4 py-4 first:pt-0 last:pb-0">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <span className="font-medium text-[0.9375rem]">{name}</span>
          {/* A plugin of one file has no name and no version of its own. */}
          {name !== id ? (
            <span className="font-mono text-[0.75rem] text-ink-4">
              {id} · {version}
            </span>
          ) : null}
          {chips}
        </div>
        {description ? <p className="mt-0.5 text-[0.875rem] text-ink-3">{description}</p> : null}
        {tools.length ? (
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[0.75rem] text-ink-3">
            {t("plugins.tools")}
            {tools.map((tool) => (
              <Chip key={tool}>{tool}</Chip>
            ))}
          </div>
        ) : null}
        {error ? <p className="mt-2 text-[0.8125rem] text-rose">{error}</p> : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">{actions}</div>
    </li>
  );
}

/** A Pro plugin of the plan that is not here: installed from the account, or why not. */
function OfferedRow({
  m,
  busy,
  disabled,
  onInstall,
}: {
  m: ProModule;
  busy: boolean;
  disabled: boolean;
  onInstall: () => void;
}) {
  return (
    <Row
      name={m.name}
      id={m.id}
      version={m.installed?.version ?? m.version}
      description={m.description}
      chips={
        <>
          <Chip>{t("plugins.originPro")}</Chip>
          {!m.included ? <Chip>{t("pro.notInPlan")}</Chip> : null}
          {m.installed && m.heldBack && m.included ? (
            <Chip tone="warn">{t(HELD[m.heldBack])}</Chip>
          ) : null}
        </>
      }
      actions={
        m.included && (!m.installed || m.update) ? (
          <Button size="sm" busy={busy} disabled={disabled} onClick={onInstall}>
            {m.installed ? t("pro.update") : t("pro.install")}
          </Button>
        ) : null
      }
    />
  );
}

/** A plugin of your own: a zip, or a folder on this computer. Nobody checked it. */
function AddDialog({
  open,
  onClose,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  onDone: (next: { plugins: Found[] }) => void;
}) {
  const [path, setPath] = useState("");
  const install = useMutation({
    mutationFn: (what: File | string) =>
      typeof what === "string"
        ? api.post<{ plugins: Found[] }>("/api/studio/plugins/-/install", { path: what })
        : api.upload<{ plugins: Found[] }>("/api/studio/plugins/-/install", what),
    onSuccess: (next) => {
      onDone(next);
      setPath("");
      onClose();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (path.trim()) {
      install.mutate(path.trim());
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title={t("plugins.addTitle")}>
      <div className="flex flex-col gap-5">
        <div className="flex gap-3 rounded-xl bg-amber-tint p-3.5 text-[0.875rem] text-ink-2">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-ink-2" />
          <p>{t("plugins.addWarning")}</p>
        </div>
        <DropArea
          accept=".zip,application/zip"
          multiple={false}
          onFiles={([file]) => file && install.mutate(file)}
          className="h-28"
        >
          <Upload className="size-4" /> {t("plugins.addZip")}
        </DropArea>
        <form onSubmit={submit} className="flex flex-col gap-2">
          <label htmlFor="plugin-folder" className="font-medium text-[0.875rem]">
            {t("plugins.addFolder")}
          </label>
          <div className="flex gap-2">
            <Input
              id="plugin-folder"
              value={path}
              placeholder={t("plugins.addFolderPlaceholder")}
              onChange={(e) => setPath(e.target.value)}
              className="font-mono text-[0.8125rem]"
            />
            <Button type="submit" variant="secondary" disabled={!path.trim()}>
              {t("pro.install")}
            </Button>
          </div>
        </form>
        {install.isPending ? (
          <p className="flex items-center gap-2 text-[0.875rem] text-ink-3">
            <Spinner className="size-4" /> {t("plugins.installing")}
          </p>
        ) : null}
        {install.error ? (
          <p className="text-[0.8125rem] text-rose">{(install.error as Error).message}</p>
        ) : null}
      </div>
    </Dialog>
  );
}
