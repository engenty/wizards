import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { api } from "../lib/api";
import { lang, t } from "../lib/i18n";
import { Button, cn, Input } from "../ui";

/** What a model does in the studio: a text class, the search of a space's knowledge, decisions. */
export type LocalJob = "text" | "search" | "decision";

interface InstalledModel {
  name: string;
  size: number;
  jobs: LocalJob[];
  capabilities: string[];
  runner: string | null;
  quantization: string | null;
  loaded: boolean;
}

interface OfferedModel {
  name: string;
  job: LocalJob;
  size: number;
  memory: number;
  note: { en: string; de: string };
  installed: boolean;
  fits: boolean;
}

interface LocalDownload {
  model: string;
  done: number;
  total: number;
  /** `ollama`: Ollama does not run on this computer; else what Ollama said. */
  error: string | null;
  finished: boolean;
}

/** `GET /api/studio/models/local`: Ollama on this computer, its models, the ones to download. */
interface LocalModelsState {
  ollama: {
    url: string;
    version: string | null;
    installed: boolean;
    canInstall: boolean;
    start: { running: boolean; error: string | null } | null;
  };
  memory: number;
  free: number | null;
  installed: InstalledModel[];
  offered: OfferedModel[] | null;
  downloads: LocalDownload[];
}

const LINUX_INSTALL = "curl -fsSL https://ollama.com/install.sh | sh";

/** What a model can do beyond its job, as chips. */
const CAP_CHIPS = ["vision", "audio", "tools"] as const;

const mb = (bytes: number) => Math.round(bytes / 1e6).toLocaleString(lang);
const gb = (n: number) => n.toLocaleString(lang, { maximumFractionDigits: 1 });

/** Ollama names a model without a tag as `name:latest`. */
const sameModel = (a: string, b: string) => a === b || a === `${b}:latest` || `${a}:latest` === b;

function Chip({ children, tone }: { children: ReactNode; tone?: "done" }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded-full px-2 text-[0.6875rem]",
        tone === "done" ? "bg-moss-tint text-moss" : "bg-paper-2 text-ink-3",
      )}
    >
      {children}
    </span>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[0.75rem] text-ink-3">{title}</span>
      <div className="flex flex-col divide-y divide-border-soft rounded-xl border border-border-soft">
        {children}
      </div>
    </div>
  );
}

function Row({ children, actions }: { children: ReactNode; actions: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-3 py-2.5">
      <div className="flex min-w-0 flex-1 flex-col gap-1">{children}</div>
      <div className="flex shrink-0 items-center gap-2">{actions}</div>
    </div>
  );
}

function DownloadState({ download }: { download: LocalDownload }) {
  if (download.error) {
    return (
      <p className="text-[0.8125rem] text-rose">
        {download.error === "ollama"
          ? t("models.local.downloadNoOllama")
          : t("models.local.downloadFailed", { error: download.error })}
      </p>
    );
  }
  return (
    <span className="text-[0.8125rem] text-ink-2 tabular-nums">
      {download.total
        ? t("models.local.progress", { done: mb(download.done), total: mb(download.total) })
        : t("models.local.starting")}
    </span>
  );
}

/**
 * The models in Ollama on this computer for one job: the ones there (to use or remove), the
 * ones the Manage-App offers (to download and use), and any other name from Ollama. Where
 * Ollama does not run, a way to start it — or to install it, on a Mac.
 */
export function LocalModels({
  job,
  chosen,
  disabled,
  onChoose,
}: {
  job: LocalJob;
  /** The model the job asks for now. */
  chosen: string;
  disabled?: boolean;
  onChoose: (model: string) => void;
}) {
  const qc = useQueryClient();
  const [other, setOther] = useState("");
  const [removeError, setRemoveError] = useState<string | null>(null);
  const { data: state } = useQuery({
    queryKey: ["models", "local"],
    queryFn: () => api.get<LocalModelsState>("/api/studio/models/local"),
    // While a download runs or Ollama starts, the page asks how far it got.
    refetchInterval: (q) =>
      q.state.data?.downloads.some((d) => !d.finished) || q.state.data?.ollama.start?.running
        ? 1500
        : false,
  });
  const set = (next: LocalModelsState) => qc.setQueryData(["models", "local"], next);
  const pull = useMutation({
    mutationFn: (model: string) =>
      api.post<LocalModelsState>("/api/studio/models/local/pull", { model }),
    onSuccess: set,
  });
  const remove = useMutation({
    mutationFn: (model: string) =>
      api.del<LocalModelsState>(`/api/studio/models/local?model=${encodeURIComponent(model)}`),
    onSuccess: (next) => {
      setRemoveError(null);
      set(next);
    },
    onError: (err) => setRemoveError((err as Error).message),
  });
  const start = useMutation({
    mutationFn: () => api.post<LocalModelsState>("/api/studio/models/local/ollama", {}),
    onSuccess: set,
  });
  // A model that arrived or went changes which ways are ready.
  const held = state?.installed.map((m) => m.name).join(" ");
  useEffect(() => {
    if (held !== undefined) {
      void qc.invalidateQueries({ queryKey: ["models"], exact: true });
    }
  }, [held, qc]);

  if (!state) {
    return null;
  }
  const { ollama } = state;
  if (!ollama.version) {
    const starting = Boolean(ollama.start?.running) || start.isPending;
    return (
      <div className="flex flex-col gap-2">
        <p className="text-[0.8125rem] text-ink-2">
          {ollama.installed ? t("models.local.ollamaStopped") : t("models.local.noOllama")}
        </p>
        {ollama.installed || ollama.canInstall ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button busy={starting} disabled={disabled || starting} onClick={() => start.mutate()}>
              {ollama.installed ? t("models.local.startOllama") : t("models.local.installOllama")}
            </Button>
            {starting ? (
              <span className="text-[0.8125rem] text-ink-2">
                {t("models.local.ollamaStarting")}
              </span>
            ) : null}
          </div>
        ) : (
          <p className="text-[0.8125rem] text-ink-2">
            {t("models.local.ollamaLinux")}{" "}
            <code className="font-mono text-[0.75rem]">{LINUX_INSTALL}</code>
          </p>
        )}
        {ollama.start?.error ? (
          <p className="text-[0.8125rem] text-rose">
            {t("models.local.ollamaFailed", { error: ollama.start.error })}
          </p>
        ) : null}
      </div>
    );
  }

  const downloadOf = (model: string) => state.downloads.find((d) => sameModel(d.model, model));
  const use = (model: string) => {
    if (!state.installed.some((m) => sameModel(m.name, model))) {
      pull.mutate(model);
    }
    onChoose(model);
  };
  const here = state.installed.filter((m) => m.jobs.includes(job));
  const offered = state.offered?.filter((m) => m.job === job && !m.installed) ?? null;
  const suggested = offered?.find((m) => m.fits)?.name;
  // Downloads of names from the free field, which no list shows.
  const others = state.downloads.filter(
    (d) =>
      !(here.some((m) => sameModel(m.name, d.model)) || offered?.some((m) => m.name === d.model)),
  );

  return (
    <div className="flex flex-col gap-4">
      <Group title={t("models.local.here", { version: ollama.version })}>
        {here.length ? (
          here.map((m) => {
            const inUse = sameModel(m.name, chosen);
            return (
              <Row
                key={m.name}
                actions={
                  <>
                    {inUse ? (
                      <Chip tone="done">{t("models.local.inUse")}</Chip>
                    ) : (
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={disabled}
                        onClick={() => onChoose(m.name)}
                      >
                        {t("models.local.use")}
                      </Button>
                    )}
                    <button
                      type="button"
                      className="grid size-8 place-items-center rounded-lg text-ink-3 hover:bg-paper-2 hover:text-rose disabled:opacity-50"
                      title={t("models.local.remove")}
                      aria-label={t("models.local.remove")}
                      disabled={disabled || inUse || remove.isPending}
                      onClick={() =>
                        confirm(
                          t("models.local.removeConfirm", { name: m.name, size: gb(m.size) }),
                        ) && remove.mutate(m.name)
                      }
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </>
                }
              >
                <span className="truncate font-mono text-[0.8125rem]">{m.name}</span>
                <span className="flex flex-wrap gap-1">
                  <Chip>{t("models.local.size", { size: gb(m.size) })}</Chip>
                  {m.runner === "mlx" ? <Chip>MLX</Chip> : null}
                  {CAP_CHIPS.filter((c) => m.capabilities.includes(c)).map((c) => (
                    <Chip key={c}>{t(`models.local.cap.${c}`)}</Chip>
                  ))}
                  {m.loaded ? <Chip tone="done">{t("models.local.loaded")}</Chip> : null}
                </span>
              </Row>
            );
          })
        ) : (
          <p className="px-3 py-2.5 text-[0.8125rem] text-ink-3">{t("models.local.hereNone")}</p>
        )}
      </Group>
      {removeError ? <p className="text-[0.8125rem] text-rose">{removeError}</p> : null}

      {offered === null ? (
        <p className="text-[0.8125rem] text-ink-3">{t("models.local.offeredNone")}</p>
      ) : offered.length ? (
        <Group title={t("models.local.offered")}>
          {offered.map((m) => {
            const download = downloadOf(m.name);
            const running = Boolean(download && !download.finished);
            return (
              <Row
                key={m.name}
                actions={
                  running && download ? (
                    <DownloadState download={download} />
                  ) : (
                    <Button
                      variant={m.name === suggested ? "primary" : "secondary"}
                      size="sm"
                      disabled={disabled}
                      onClick={() => use(m.name)}
                    >
                      {t("models.local.download")}
                    </Button>
                  )
                }
              >
                <span className="flex flex-wrap items-center gap-2">
                  <span className="truncate font-mono text-[0.8125rem]">{m.name}</span>
                  {m.name === suggested ? (
                    <Chip tone="done">{t("models.local.suggested")}</Chip>
                  ) : null}
                </span>
                <span className="text-[0.8125rem] text-ink-2">
                  {m.note[lang === "de" ? "de" : "en"]}
                </span>
                <span className="flex flex-wrap gap-1">
                  <Chip>{t("models.local.size", { size: gb(m.size) })}</Chip>
                  {m.fits ? null : (
                    <Chip>{t("models.local.tooBig", { memory: gb(m.memory) })}</Chip>
                  )}
                </span>
                {download?.error ? <DownloadState download={download} /> : null}
              </Row>
            );
          })}
        </Group>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <span className="text-[0.75rem] text-ink-3">{t("models.local.other")}</span>
        <form
          className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]"
          onSubmit={(e) => {
            e.preventDefault();
            use(other.trim());
            setOther("");
          }}
        >
          <Input
            className="font-mono text-[0.8125rem]"
            value={other}
            placeholder={t("models.local.otherPlaceholder")}
            disabled={disabled}
            onChange={(e) => setOther(e.target.value)}
          />
          <Button type="submit" variant="secondary" disabled={disabled || !other.trim()}>
            {t("models.local.use")}
          </Button>
        </form>
        {others.map((d) => (
          <span key={d.model} className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[0.8125rem]">{d.model}</span>
            <DownloadState download={d} />
          </span>
        ))}
      </div>
    </div>
  );
}
