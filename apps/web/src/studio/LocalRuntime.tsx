import {
  modelLabel,
  PROVIDERS,
  type ProviderInfo,
  providerOfRef,
} from "@engenty-wizards/shared/providers";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, ExternalLink } from "lucide-react";
import { type ReactNode, useState } from "react";
import { api } from "../lib/api";
import { t } from "../lib/i18n";
import type { LocalModels } from "../lib/session";
import { Button, cn, Input, Label } from "../ui";

/** Opens a page in the person's own browser — also from inside the desktop app's window. */
export function openExternal(url: string) {
  const desktop = (window as { engentyDesktop?: { open(url: string): void } }).engentyDesktop;
  if (desktop) {
    desktop.open(url);
  } else {
    window.open(url, "_blank", "noopener");
  }
}

/** What the setup's test of a key or of Ollama answered. */
interface SetupOutcome {
  ok: boolean;
  message: string | null;
  /** The model the wizards now write with; null where none runs without credits. */
  text: string | null;
}

/** The providers that can write: a key from one of them is enough for the setup. */
const WRITERS = PROVIDERS.filter((p) => p.text);

/**
 * The keys of the setup, each tested on its own: a key that works is stored and put to use, and
 * the first one ends the setup. Which model does which job is for Settings → Models.
 */
export function OwnModels({ models }: { models: LocalModels }) {
  return (
    <div className="flex flex-col gap-3">
      <div>
        <Label>{t("local.keys")}</Label>
        <p className="text-[0.8125rem] text-ink-3">{t("local.keysHint")}</p>
      </div>
      <div className="flex flex-col">
        {WRITERS.map((p) => (
          <KeyRow key={p.id} provider={p} stored={Boolean(models.keys[p.id])} />
        ))}
        <OllamaRow url={models.ollamaUrl} />
      </div>
      <p className="text-[0.8125rem] text-ink-3">{t("local.modelsLater")}</p>
    </div>
  );
}

function useSetupTest(path: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, string>) => api.post<SetupOutcome>(path, body),
    // A working key ends the setup: the studio learns it from `me`.
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }),
  });
}

function KeyRow({ provider, stored }: { provider: ProviderInfo; stored: boolean }) {
  const qc = useQueryClient();
  const [value, setValue] = useState("");
  const test = useSetupTest(`/api/studio/local/keys/${provider.id}`);
  // A stored key is tested again with an empty field; a working new one leaves the field.
  const run = () =>
    test.mutate(value.trim() ? { key: value.trim() } : {}, {
      onSuccess: (r) => (r.ok ? setValue("") : undefined),
    });
  const remove = useMutation({
    mutationFn: () => api.put("/api/studio/local/models", { keys: { [provider.id]: "" } }),
    onSuccess: async () => {
      test.reset();
      await qc.invalidateQueries({ queryKey: ["me"] });
    },
  });
  return (
    <Row
      label={provider.name}
      sub={
        <button
          type="button"
          onClick={() => openExternal(provider.keyUrl)}
          className="inline-flex items-center gap-1 text-left hover:text-ink-2 hover:underline"
        >
          {t("local.keyGet")} <ExternalLink className="size-3" />
        </button>
      }
      input={
        <Input
          type="password"
          autoComplete="off"
          className="min-w-0 flex-1 font-mono text-[0.8125rem]"
          placeholder={stored ? t("local.keySet") : provider.keyPlaceholder}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && value.trim()) {
              run();
            }
          }}
        />
      }
      actions={
        <>
          <Button
            variant="secondary"
            busy={test.isPending}
            disabled={!stored && !value.trim()}
            onClick={run}
          >
            {t("local.test")}
          </Button>
          {stored ? (
            <Button
              variant="ghost"
              size="sm"
              busy={remove.isPending}
              onClick={() => remove.mutate()}
            >
              {t("local.keyRemove")}
            </Button>
          ) : null}
        </>
      }
      said={said(test, (ref) => providerOfRef(ref) === provider.id)}
    />
  );
}

function OllamaRow({ url: saved }: { url: string }) {
  const [url, setUrl] = useState(saved);
  const test = useSetupTest("/api/studio/local/ollama");
  return (
    <Row
      label="Ollama"
      sub={t("local.ollamaWhere")}
      input={
        <Input
          className="min-w-0 flex-1 font-mono text-[0.8125rem]"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      }
      actions={
        <Button
          variant="secondary"
          busy={test.isPending}
          disabled={!url.trim()}
          onClick={() => test.mutate({ url: url.trim() })}
        >
          {t("local.test")}
        </Button>
      }
      said={said(test, (ref) => ref.startsWith("ollama:"))}
    />
  );
}

/** The line under a row once its test answered; `mine`: the model is this row's. */
function said(
  test: ReturnType<typeof useSetupTest>,
  mine: (ref: string) => boolean,
): { ok: boolean; text: string } | null {
  if (test.isError) {
    return { ok: false, text: (test.error as Error).message };
  }
  const r = test.data;
  if (!r) {
    return null;
  }
  if (!r.ok) {
    return { ok: false, text: r.message ?? t("models.keyBad") };
  }
  if (!r.text) {
    return { ok: true, text: t("local.keyWorksPlain") };
  }
  const model = modelLabel(r.text);
  return { ok: true, text: t(mine(r.text) ? "local.keyWorks" : "local.keyWorksOther", { model }) };
}

function Row({
  label,
  sub,
  input,
  actions,
  said,
}: {
  label: string;
  sub: ReactNode;
  input: ReactNode;
  actions: ReactNode;
  said: { ok: boolean; text: string } | null;
}) {
  return (
    <div className="grid gap-x-3 gap-y-1.5 border-border-soft border-t py-3 sm:grid-cols-[10rem_minmax(0,1fr)]">
      <div>
        <div className="text-[0.875rem] text-ink-2">{label}</div>
        <div className="text-[0.75rem] text-ink-4">{sub}</div>
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          {input}
          {actions}
        </div>
        {said ? (
          <p
            className={cn(
              "flex items-start gap-1.5 text-[0.8125rem]",
              said.ok ? "text-moss" : "text-rose",
            )}
          >
            {said.ok ? <Check className="mt-0.5 size-3.5 shrink-0" strokeWidth={3} /> : null}
            {said.text}
          </p>
        ) : null}
      </div>
    </div>
  );
}
