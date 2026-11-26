import { Button, cn, Input, Label } from "@engenty/chatviews/react/ui";
import type { ServerId } from "@engenty/model-providers/servers";
import { Check, ExternalLink } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useCall, useSetupHost, useText } from "./host.js";

/** What the test of a key or of a server answered. */
export interface SourceResult {
  ok: boolean;
  message: string | null;
  /** The model the app now writes with; null where none does. */
  text: string | null;
}

/** A provider whose key the setup takes. */
export interface KeyProvider {
  id: string;
  name: string;
  keyUrl: string;
  keyPlaceholder: string;
  /** A key is stored. */
  stored: boolean;
}

interface Names {
  /** A model's name as the person reads it. */
  modelName?: (ref: string) => string;
  /** Whether the model a test answered with runs on this row. */
  mine: (ref: string) => boolean;
}

/**
 * Own keys, each tested on its own: a key that works is stored and put to use, and the first one
 * ends the setup.
 */
export function OwnKeys({
  providers,
  isOf,
  modelName,
  onRemove,
  hint,
  later,
  children,
}: {
  providers: readonly KeyProvider[];
  /** Whether a model runs on a provider's key. */
  isOf: (ref: string, provider: string) => boolean;
  modelName?: (ref: string) => string;
  onRemove: (provider: string) => Promise<unknown>;
  hint?: string;
  /** Below the rows: where to change it later. */
  later?: string;
  /** More rows. */
  children?: ReactNode;
}) {
  const t = useText();
  return (
    <div className="flex flex-col gap-3">
      <div>
        <Label>{t("local.keys")}</Label>
        <p className="text-[0.8125rem] text-ink-3">{hint ?? t("local.keysHint")}</p>
      </div>
      <div className="flex flex-col">
        {providers.map((provider) => (
          <KeyRow
            key={provider.id}
            provider={provider}
            modelName={modelName}
            mine={(ref) => isOf(ref, provider.id)}
            onRemove={() => onRemove(provider.id)}
          />
        ))}
        {children}
      </div>
      {later ? <p className="text-[0.8125rem] text-ink-3">{later}</p> : null}
    </div>
  );
}

function useSourceTest(path: string) {
  const host = useSetupHost();
  return useCall(async (body: Record<string, string>) => {
    const result = await host.post<SourceResult>(path, body);
    // A working key ends the setup: the page learns it.
    await host.changed();
    return result;
  });
}

function KeyRow({
  provider,
  onRemove,
  ...names
}: Names & { provider: KeyProvider; onRemove: () => Promise<unknown> }) {
  const host = useSetupHost();
  const t = useText();
  const [value, setValue] = useState("");
  const test = useSourceTest(`/keys/${provider.id}`);
  // A stored key is tested again with an empty field; a working new one leaves the field.
  const run = async () => {
    const result = await test.run(value.trim() ? { key: value.trim() } : {});
    if (result?.ok) {
      setValue("");
    }
  };
  const remove = useCall(async () => {
    await onRemove();
    test.reset();
    await host.changed();
  });
  return (
    <Row
      label={provider.name}
      sub={
        <button
          type="button"
          onClick={() => host.open(provider.keyUrl)}
          className="inline-flex items-center gap-1 text-left hover:text-ink-2 hover:underline"
        >
          {t("local.keyGet")} <ExternalLink className="size-3" />
        </button>
      }
      input={
        <Input
          type="password"
          autoComplete="off"
          aria-label={provider.name}
          className="min-w-0 flex-1 font-mono text-[0.8125rem]"
          placeholder={provider.stored ? t("local.keySet") : provider.keyPlaceholder}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && value.trim()) {
              void run();
            }
          }}
        />
      }
      actions={
        <>
          <Button
            variant="secondary"
            busy={test.busy}
            disabled={!provider.stored && !value.trim()}
            onClick={() => void run()}
          >
            {t("local.test")}
          </Button>
          {provider.stored ? (
            <Button variant="ghost" size="sm" busy={remove.busy} onClick={() => void remove.run()}>
              {t("local.keyRemove")}
            </Button>
          ) : null}
        </>
      }
      said={useSaid(test, names)}
    />
  );
}

/** A server for open models at an address of the person's. */
export function ServerAddress({
  id,
  name,
  url: saved,
  modelName,
}: {
  id: ServerId;
  name: string;
  url: string;
  modelName?: Names["modelName"];
}) {
  const t = useText();
  const [url, setUrl] = useState(saved);
  const test = useSourceTest(`/servers/${id}/address`);
  return (
    <Row
      label={t("local.address")}
      sub={t("local.serverWhere")}
      input={
        <Input
          aria-label={name}
          className="min-w-0 flex-1 font-mono text-[0.8125rem]"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      }
      actions={
        <Button
          variant="secondary"
          busy={test.busy}
          disabled={!url.trim()}
          onClick={() => void test.run({ url: url.trim() })}
        >
          {t("local.test")}
        </Button>
      }
      said={useSaid(test, { modelName, mine: (ref) => ref.startsWith(`${id}:`) })}
    />
  );
}

/** The line under a row once its test answered. */
function useSaid(
  test: { data?: SourceResult; error?: string },
  { mine, modelName }: Names,
): { ok: boolean; text: string } | null {
  const t = useText();
  if (test.error) {
    return { ok: false, text: test.error };
  }
  const r = test.data;
  if (!r) {
    return null;
  }
  if (!r.ok) {
    return { ok: false, text: r.message ?? t("setup.keyBad") };
  }
  if (!r.text) {
    return { ok: true, text: t("local.keyWorksPlain") };
  }
  const model = modelName?.(r.text) ?? r.text;
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
