import { Button, cn, Input } from "@engenty/chatviews/react/ui";
import { Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { MODEL_JOBS, type ModelDownload, type ModelJob, type OllamaModelsState } from "../types.js";
import { useCall, useSetupHost, useText } from "./host.js";

const LINUX_INSTALL = "curl -fsSL https://ollama.com/install.sh | sh";

/** A job's name. */
const JOB_LABEL = {
  text: "models.cap.text",
  search: "models.cap.search",
  decision: "models.cap.decision",
} as const satisfies Record<ModelJob, string>;

/** Whether the state is still changing: a download runs, or Ollama starts. */
export function modelsMoving(state: OllamaModelsState | undefined): boolean {
  return Boolean(
    state && (state.downloads.some((d) => !d.finished) || state.ollama.start?.running),
  );
}

/** What a model can do beyond its job, as chips. */
const CAP_CHIPS = ["vision", "audio", "tools"] as const;

/** Numbers as the host's language writes them. */
function useNumbers() {
  const { lang } = useSetupHost();
  return {
    mb: (bytes: number) => Math.round(bytes / 1e6).toLocaleString(lang),
    gb: (n: number) => n.toLocaleString(lang, { maximumFractionDigits: 1 }),
  };
}

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

function DownloadState({ download }: { download: ModelDownload }) {
  const t = useText();
  const { mb } = useNumbers();
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
 * The models in Ollama on this computer. For one job: the ones there (to use or remove), the
 * ones the Manage-App offers (to download and use), and any other name from Ollama. Without a
 * job, all of them with the jobs each serves, to download or remove. Where Ollama does not
 * run, a way to start it — or to install it, on a Mac.
 */
export function LocalModels({
  state,
  onState,
  job,
  inUse,
  disabled,
  onChoose,
  onlyHeld = false,
}: {
  /** As `GET /local-models` answers it; asked again while `modelsMoving`. */
  state: OllamaModelsState | undefined;
  /** What a change answered. */
  onState: (next: OllamaModelsState) => void;
  /** Absent: every job, and nothing to choose. */
  job?: ModelJob;
  /** The models in use; they are not removed. */
  inUse: string[];
  disabled?: boolean;
  onChoose?: (model: string) => void;
  /** Only a model that is there is chosen; a download only downloads. */
  onlyHeld?: boolean;
}) {
  const host = useSetupHost();
  const t = useText();
  const { gb } = useNumbers();
  const [other, setOther] = useState("");
  /** The model whose removal waits for a yes. */
  const [asking, setAsking] = useState<string | null>(null);
  const pull = useCall(async (model: string) =>
    onState(await host.post<OllamaModelsState>("/local-models/pull", { model })),
  );
  const remove = useCall(async (model: string) =>
    onState(
      (await host.del(`/local-models?model=${encodeURIComponent(model)}`)) as OllamaModelsState,
    ),
  );
  const start = useCall(async () =>
    onState(await host.post<OllamaModelsState>("/local-models/ollama", {})),
  );
  // A model that arrived or went changes what can answer.
  const held = state?.installed.map((m) => m.name).join(" ");
  const known = useRef(held);
  const changed = useRef(host.changed);
  changed.current = host.changed;
  useEffect(() => {
    if (known.current !== undefined && held !== undefined && known.current !== held) {
      void changed.current();
    }
    known.current = held;
  }, [held]);

  if (!state) {
    return null;
  }
  const { ollama } = state;
  if (!ollama.version) {
    const starting = Boolean(ollama.start?.running) || start.busy;
    return (
      <div className="flex flex-col gap-2">
        <p className="text-[0.8125rem] text-ink-2">
          {ollama.installed ? t("models.local.ollamaStopped") : t("models.local.noOllama")}
        </p>
        {ollama.installed || ollama.canInstall ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button
              busy={starting}
              disabled={disabled || starting}
              onClick={() => void start.run()}
            >
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
      void pull.run(model);
      if (onlyHeld) {
        return;
      }
    }
    onChoose?.(model);
  };
  const choosesNew = Boolean(onChoose) && !onlyHeld;
  const here = job ? state.installed.filter((m) => m.jobs.includes(job)) : state.installed;
  const offered =
    state.offered?.filter((m) => (job ? m.job === job : true) && !m.installed) ?? null;
  // Per job, the first one that fits this computer.
  const suggested = new Set(
    MODEL_JOBS.map((j) => offered?.find((m) => m.job === j && m.fits)?.name),
  );
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
            const used = inUse.some((name) => sameModel(m.name, name));
            return (
              <Row
                key={m.name}
                actions={
                  <>
                    {used ? (
                      <Chip tone="done">{t("models.local.inUse")}</Chip>
                    ) : !onChoose ? null : (
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={disabled}
                        onClick={() => onChoose(m.name)}
                      >
                        {t("models.local.use")}
                      </Button>
                    )}
                    {asking === m.name ? null : (
                      <button
                        type="button"
                        className="grid size-8 place-items-center rounded-lg text-ink-3 hover:bg-paper-2 hover:text-rose disabled:opacity-50"
                        title={t("models.local.remove")}
                        aria-label={t("models.local.remove")}
                        disabled={disabled || used || remove.busy}
                        onClick={() => setAsking(m.name)}
                      >
                        <Trash2 className="size-4" />
                      </button>
                    )}
                  </>
                }
              >
                <span className="truncate font-mono text-[0.8125rem]">{m.name}</span>
                <span className="flex flex-wrap gap-1">
                  {job ? null : m.jobs.map((j) => <Chip key={j}>{t(JOB_LABEL[j])}</Chip>)}
                  <Chip>{t("models.local.size", { size: gb(m.size) })}</Chip>
                  {m.runner === "mlx" ? <Chip>MLX</Chip> : null}
                  {CAP_CHIPS.filter((c) => m.capabilities.includes(c)).map((c) => (
                    <Chip key={c}>{t(`models.local.cap.${c}`)}</Chip>
                  ))}
                  {m.loaded ? <Chip tone="done">{t("models.local.loaded")}</Chip> : null}
                  {m.fits ? null : <Chip>{t("models.local.tooBig", { memory: gb(m.size) })}</Chip>}
                </span>
                {asking === m.name ? (
                  <span className="flex flex-wrap items-center gap-2 text-[0.8125rem] text-ink-2">
                    {t("models.local.removeConfirm", { name: m.name, size: gb(m.size) })}
                    <Button
                      variant="danger"
                      size="sm"
                      busy={remove.busy}
                      onClick={async () => {
                        await remove.run(m.name);
                        setAsking(null);
                      }}
                    >
                      {t("models.local.removeYes")}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setAsking(null)}>
                      {t("setup.cancel")}
                    </Button>
                  </span>
                ) : null}
              </Row>
            );
          })
        ) : (
          <p className="px-3 py-2.5 text-[0.8125rem] text-ink-3">{t("models.local.hereNone")}</p>
        )}
      </Group>
      {remove.error ? (
        <p className="text-[0.8125rem] text-rose">
          {t("models.local.removeFailed", { error: remove.error })}
        </p>
      ) : null}

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
                      variant={suggested.has(m.name) ? "primary" : "secondary"}
                      size="sm"
                      disabled={disabled}
                      onClick={() => use(m.name)}
                    >
                      {choosesNew ? t("models.local.download") : t("models.local.downloadOnly")}
                    </Button>
                  )
                }
              >
                <span className="flex flex-wrap items-center gap-2">
                  <span className="truncate font-mono text-[0.8125rem]">{m.name}</span>
                  {suggested.has(m.name) ? (
                    <Chip tone="done">{t("models.local.suggested")}</Chip>
                  ) : null}
                </span>
                <span className="text-[0.8125rem] text-ink-2">{m.note[host.lang]}</span>
                <span className="flex flex-wrap gap-1">
                  {job ? null : <Chip>{t(JOB_LABEL[m.job])}</Chip>}
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
            {choosesNew ? t("models.local.use") : t("models.local.downloadOnly")}
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
