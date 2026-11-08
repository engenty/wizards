/**
 * Settings › Models › API keys in the cloud, behind `ownKeysGateway`: the organization's own
 * accounts at the providers, kept by the Manage-App (docs/manage-contract.md, "Own accounts").
 * Every call goes through engenty, which runs it on such an account where the account serves the
 * model the organization's choice resolves to, and otherwise on credits. The list, the dialog
 * that adds a key, and one account's page. On a computer the keys stay on KeysPanel (Models.tsx).
 */
import type { ModelTier } from "@engenty/wizards-shared/tiers";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronLeft, ChevronRight, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ApiError, api } from "../lib/api";
import { type Key, lang, t } from "../lib/i18n";
import { askConfirm, Button, Card, cn, Dialog, IconButton, Input, Select, Switch } from "../ui";
import { Hint } from "./models-parts";
import { tierClassLabel } from "./tiers";

/** One of the organization's accounts, as the Manage-App lists it; the key never comes back. */
export interface Account {
  id: string;
  source: string;
  label: string;
  place: string;
  keyHint: string;
  status: "ready" | "refused" | "resting";
  error: string | null;
  checkedAt: string;
  models: number;
  passing: number;
  uses: { class: string; model: string }[];
  month: { calls: number; usd: number };
}

/** A key saved in the studio before that didn't come along to the Manage-App. */
interface KeptKey {
  provider: string;
  name: string;
  reason: "refused" | "unsupported";
  message: string | null;
}

/** `GET /api/studio/models/keys`. */
export interface Accounts {
  fallback: boolean;
  accounts: Account[];
  kept: KeptKey[];
}

const KEY = ["model-accounts"];

/** The keys that didn't come along, as the runtime said it once; shown until the page is left. */
let kept: KeptKey[] = [];

export function useAccounts(on: boolean) {
  return useQuery({
    queryKey: KEY,
    enabled: on,
    queryFn: async () => {
      const data = await api.get<Accounts>("/api/studio/models/keys");
      if (data.kept.length) {
        kept = data.kept;
      }
      return data;
    },
  });
}

/** The kinds of account: their tile, their name, the models they bring. */
const SOURCES: Record<string, { mono: string; name: () => string; models?: () => string }> = {
  bedrock: { mono: "AWS", name: () => "AWS Bedrock", models: () => "Claude, Mistral, Llama" },
  azure: { mono: "Az", name: () => "Microsoft Azure", models: () => "GPT" },
  mistral: { mono: "Mi", name: () => "Mistral", models: () => "Mistral" },
  anthropic: { mono: "An", name: () => "Anthropic", models: () => "Claude" },
  openai: { mono: "OA", name: () => "OpenAI", models: () => "GPT" },
  google: { mono: "G", name: () => "Google", models: () => "Gemini" },
  compat: { mono: "{ }", name: () => t("keys.compat"), models: () => t("keys.compatModels") },
  "ai-gateway": { mono: "AI", name: () => "Vercel AI Gateway" },
  fal: { mono: "fal", name: () => "fal.ai" },
  elevenlabs: { mono: "11", name: () => "ElevenLabs" },
};

/** What the add dialog offers, in its order. */
const ADDABLE = ["bedrock", "azure", "mistral", "anthropic", "openai", "google", "compat"];

const sourceOf = (id: string) =>
  SOURCES[id] ?? { mono: id.slice(0, 2).toUpperCase(), name: () => id };

/** The provider's name as a sentence says it; another provider by the account's own name. */
const providerName = (a: Account) => (a.source === "compat" ? a.label : sourceOf(a.source).name());

/** AWS regions Bedrock is reached in. */
const REGIONS = [
  { value: "eu-central-1", label: "eu-central-1 · Frankfurt" },
  { value: "eu-west-3", label: "eu-west-3 · Paris" },
  { value: "eu-north-1", label: "eu-north-1 · Stockholm" },
  { value: "us-east-1", label: "us-east-1 · N. Virginia" },
  { value: "us-west-2", label: "us-west-2 · Oregon" },
];

function Mono({ source, large }: { source: string; large?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid shrink-0 place-items-center bg-paper-2 font-semibold text-ink",
        large ? "size-[3.25rem] rounded-2xl text-[0.875rem]" : "size-10 rounded-xl text-[0.75rem]",
      )}
    >
      {sourceOf(source).mono}
    </span>
  );
}

const STATE_TEXT: Record<Account["status"], Key> = {
  ready: "keys.state.ready",
  refused: "keys.state.refused",
  resting: "keys.state.resting",
};

/** bereit in green, Key abgelehnt in amber, ruht in grey. */
function StateText({ status, pill }: { status: Account["status"]; pill?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-2 whitespace-nowrap text-[0.8125rem]",
        pill && "h-7 rounded-full bg-paper-2 px-3 font-medium",
        status === "ready" && "text-moss",
        status === "refused" && "font-medium text-amber",
        status === "resting" && "text-ink-3",
      )}
    >
      <i
        aria-hidden
        className={cn(
          "size-2 rounded-full",
          status === "ready" && "bg-moss",
          status === "refused" && "bg-amber",
          status === "resting" && "bg-ink-4",
        )}
      />
      {t(STATE_TEXT[status])}
    </span>
  );
}

/** Where a class runs on an account: the overview's access column and the model it names. */
export function accountUse(
  accounts: Accounts | null | undefined,
  cls: string,
): { access: string; model: string } | null {
  for (const account of accounts?.accounts ?? []) {
    const use = account.uses.find((u) => u.class === cls);
    if (use) {
      return {
        access:
          account.status === "refused" && accounts?.fallback ? t("keys.fallback") : account.label,
        model: use.model,
      };
    }
  }
  return null;
}

/** The Zugänge row's words: the accounts' names, and how many are ready or refused. */
export function accountsSummary(accounts: Accounts): { desc: string; status: string | null } {
  const refused = accounts.accounts.filter((a) => a.status === "refused").length;
  const ready = accounts.accounts.filter((a) => a.status === "ready").length;
  return {
    desc: accounts.accounts.length
      ? `${accounts.accounts.map((a) => a.label).join(", ")}.`
      : t("overview.keys.admin"),
    status: refused
      ? t("keys.nRefused", { n: refused })
      : accounts.accounts.length
        ? t("keys.nReady", { n: ready })
        : null,
  };
}

/** A: Eigene API-Keys – the list, a key to add, and whether the credits step in. */
export function AccountsPanel({
  organization,
  canEdit,
  onOpen,
  tier,
  policy,
}: {
  organization: string;
  canEdit: boolean;
  onOpen: (id: string) => void;
  tier: ModelTier | null;
  /** The admins' switch for own keys on a tier, where there is one. */
  policy?: ReactNode;
}) {
  const accounts = useAccounts(true);
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState(kept);
  const fallback = useMutation({
    mutationFn: (on: boolean) =>
      api.patch<{ fallback: boolean }>("/api/studio/models/keys", { fallback: on }),
    onSuccess: ({ fallback: on }) =>
      qc.setQueryData<Accounts>(KEY, (data) => (data ? { ...data, fallback: on } : data)),
  });
  const data = accounts.data;
  const list = data?.accounts ?? [];
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end gap-4">
        <div className="min-w-0 flex-[1_1_20rem]">
          <h1 className="font-display font-semibold text-[1.625rem] leading-tight tracking-tight">
            {t("policy.ownKeys")}
          </h1>
          <p className="mt-1.5 text-[0.9375rem] text-ink-2">{t("keys.lead")}</p>
        </div>
        {canEdit ? <Button onClick={() => setAdding(true)}>{t("keys.add")}</Button> : null}
      </div>
      {notice.length ? (
        <div className="flex items-start gap-3 rounded-xl bg-amber-tint px-4 py-3 text-[0.875rem] text-ink-2">
          <span className="flex-1">
            {t("keys.kept", {
              keys: notice
                .map((k) =>
                  k.reason === "unsupported"
                    ? `${k.name} (${t("keys.keptUnsupported")})`
                    : k.message
                      ? `${k.name} (${k.message})`
                      : k.name,
                )
                .join(", "),
            })}
          </span>
          <IconButton
            label={t("common.close")}
            onClick={() => {
              kept = [];
              setNotice([]);
            }}
            className="-my-1.5 -mr-2"
          >
            <X className="size-4" />
          </IconButton>
        </div>
      ) : null}
      {accounts.isError ? (
        <p className="text-[0.8125rem] text-rose">{(accounts.error as Error).message}</p>
      ) : data ? (
        <Card className="overflow-hidden p-0">
          {list.length ? (
            list.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => onOpen(a.id)}
                className="flex w-full items-center gap-3.5 border-border-soft border-t px-4 py-3.5 text-left transition first:border-t-0 hover:bg-accent/60 sm:px-5"
              >
                <Mono source={a.source} />
                <span className="min-w-0 flex-1">
                  <b className="block truncate font-medium text-[0.875rem]">{a.label}</b>
                  <span className="block truncate text-[0.8125rem] text-ink-3">
                    {[sourceOf(a.source).name(), a.place].filter(Boolean).join(" · ")}
                  </span>
                </span>
                <StateText status={a.status} />
                <ChevronRight className="size-4 shrink-0 text-ink-4" />
              </button>
            ))
          ) : (
            <div className="px-4 py-5 sm:px-5">
              <Hint>{t("keys.empty")}</Hint>
            </div>
          )}
        </Card>
      ) : null}
      {canEdit && policy ? policy : null}
      {canEdit && data ? (
        <Card className="flex items-center gap-3.5 px-4 py-3.5 sm:px-5">
          <div className="min-w-0 flex-1">
            <b className="block font-medium text-[0.875rem]">{t("keys.fallback")}</b>
            <span className="block text-[0.8125rem] text-ink-3">{t("keys.fallbackHint")}</span>
            {fallback.isError ? (
              <span className="mt-1 block text-[0.8125rem] text-rose">
                {(fallback.error as Error).message}
              </span>
            ) : null}
          </div>
          <Switch
            checked={fallback.isPending ? Boolean(fallback.variables) : data.fallback}
            disabled={fallback.isPending}
            onChange={(on) => fallback.mutate(on)}
            label={t("keys.fallback")}
          />
        </Card>
      ) : null}
      {canEdit ? null : <Hint>{t("keys.membersNote", { organization })}</Hint>}
      <AddKeyDialog open={adding} onClose={() => setAdding(false)} tier={tier} />
    </div>
  );
}

/** C: one account – how it stands, what runs over it this month, and its key. */
export function AccountPanel({
  id,
  canEdit,
  onGone,
}: {
  id: string;
  canEdit: boolean;
  onGone: () => void;
}) {
  const accounts = useAccounts(true);
  const qc = useQueryClient();
  const [replacing, setReplacing] = useState(false);
  const remove = useMutation({
    mutationFn: () => api.del(`/api/studio/models/keys/${encodeURIComponent(id)}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: ["models"] });
      onGone();
    },
  });
  const account = accounts.data?.accounts.find((a) => a.id === id);
  if (!account) {
    return accounts.isError ? (
      <p className="text-[0.8125rem] text-rose">{(accounts.error as Error).message}</p>
    ) : accounts.data ? (
      <Hint>{t("keys.gone")}</Hint>
    ) : null;
  }
  const provider = providerName(account);
  const refused = account.status === "refused";
  const month = new Date().toLocaleString(lang, { month: "long" });
  const usd = new Intl.NumberFormat(lang, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: account.month.usd < 10 ? 2 : 0,
  }).format(account.month.usd);
  const ask = async () => {
    if (
      await askConfirm(t("keys.removeAsk", { name: account.label }), {
        detail: t("keys.removeDetail"),
        action: t("common.remove"),
      })
    ) {
      remove.mutate();
    }
  };
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-4">
        <Mono source={account.source} large />
        <div className="min-w-0 flex-[1_1_16rem]">
          <h1 className="truncate font-display font-semibold text-[1.625rem] leading-tight tracking-tight">
            {account.label}
          </h1>
          <p className="mt-0.5 text-[0.875rem] text-ink-3">
            {[
              sourceOf(account.source).name(),
              account.place,
              t("keys.keyEnd", { hint: account.keyHint }),
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <StateText status={account.status} pill />
      </div>
      {refused ? (
        <div
          role="status"
          className="flex flex-wrap items-center gap-3.5 rounded-xl bg-amber-tint px-4 py-3.5 ring-1 ring-amber/35 sm:px-5"
        >
          <p className="min-w-0 flex-[1_1_18rem] text-[0.875rem] text-ink-2">
            <b className="font-semibold text-ink">{t("keys.refusedBy", { provider })}</b>{" "}
            {t(accounts.data?.fallback ? "keys.refusedFallback" : "keys.refusedNoFallback")}
            {account.error ? (
              <span className="mt-1 block text-[0.8125rem] text-ink-3">{account.error}</span>
            ) : null}
          </p>
          {canEdit ? (
            <Button size="sm" onClick={() => setReplacing(true)}>
              {t("keys.replace")}
            </Button>
          ) : null}
        </div>
      ) : null}
      <section className="flex flex-col gap-3">
        <div>
          <h2 className="font-semibold text-[1rem]">{t("keys.runsHere")}</h2>
          <p className="mt-0.5 text-[0.8125rem] text-ink-3">
            {account.month.calls
              ? t("keys.month", {
                  month,
                  calls: account.month.calls.toLocaleString(lang),
                  usd,
                  provider,
                })
              : t("keys.monthNone", { month })}
          </p>
        </div>
        {account.uses.length ? (
          <Card className="overflow-hidden p-0">
            {account.uses.map((u) => (
              <div
                key={u.class}
                className="flex items-center gap-3.5 border-border-soft border-t px-4 py-3 text-[0.875rem] first:border-t-0 sm:px-5"
              >
                <b className="min-w-0 flex-1 font-medium">{tierClassLabel(u.class)}</b>
                <span className={cn("text-right", refused ? "text-amber" : "text-ink-2")}>
                  {refused ? t("keys.withCredits", { model: u.model }) : u.model}
                </span>
              </div>
            ))}
          </Card>
        ) : (
          <Hint>{t("keys.nothingRuns")}</Hint>
        )}
      </section>
      {canEdit ? (
        <div className="flex flex-wrap gap-2">
          {refused ? null : (
            <Button variant="quiet" size="sm" onClick={() => setReplacing(true)}>
              {t("keys.replace")}
            </Button>
          )}
          <Button variant="danger" size="sm" busy={remove.isPending} onClick={ask}>
            {t("common.remove")}
          </Button>
          {remove.isError ? (
            <p className="w-full text-[0.8125rem] text-rose">{(remove.error as Error).message}</p>
          ) : null}
        </div>
      ) : null}
      <AddKeyDialog open={replacing} onClose={() => setReplacing(false)} account={account} />
    </div>
  );
}

interface Fields {
  region: string;
  baseUrl: string;
  key: string;
  deployments: string;
  confirmed: boolean;
}

const EMPTY: Fields = {
  region: "eu-central-1",
  baseUrl: "",
  key: "",
  deployments: "",
  confirmed: false,
};

/** What the Manage-App gets besides the key, per kind of account. */
function settingsOf(source: string, f: Fields): Record<string, unknown> | undefined {
  switch (source) {
    case "bedrock":
      return { region: f.region };
    case "azure":
      return {
        baseUrl: f.baseUrl.trim(),
        deployments: f.deployments
          .split(",")
          .map((d) => d.trim())
          .filter(Boolean)
          .map((deployment) => ({ deployment })),
        noAbuseLog: f.confirmed,
      };
    case "compat":
      return { baseUrl: f.baseUrl.trim(), euServers: f.confirmed, noRetention: f.confirmed };
    default:
      return undefined;
  }
}

/**
 * B: a key added in three steps (the provider, its fields, what now runs over it), in a dialog
 * of one height. With `account`, its key replaced: the fields only.
 */
export function AddKeyDialog({
  open,
  onClose,
  account,
  tier,
}: {
  open: boolean;
  onClose: () => void;
  account?: Account;
  tier?: ModelTier | null;
}) {
  const qc = useQueryClient();
  const [step, setStep] = useState<"pick" | "form" | "done">(account ? "form" : "pick");
  const [source, setSource] = useState(account?.source ?? ADDABLE[0]);
  const [fields, setFields] = useState<Fields>(EMPTY);
  const save = useMutation({
    mutationFn: () =>
      account
        ? api.patch<Account>(`/api/studio/models/keys/${encodeURIComponent(account.id)}`, {
            key: fields.key.trim(),
          })
        : api.post<Account>("/api/studio/models/keys", {
            source,
            label: sourceOf(source).name(),
            key: fields.key.trim(),
            settings: settingsOf(source, fields),
          }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: ["models"] });
      setStep("done");
    },
  });
  const close = () => {
    onClose();
    setStep(account ? "form" : "pick");
    setFields(EMPTY);
    save.reset();
  };
  const set = (patch: Partial<Fields>) => setFields((f) => ({ ...f, ...patch }));
  // The fields' step starts in its first field.
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (open && step === "form") {
      form.current?.querySelector<HTMLElement>("input, select")?.focus();
    }
  }, [open, step]);
  const name = account ? account.label : sourceOf(source).name();
  const needsBase = !account && (source === "azure" || source === "compat");
  const ready =
    fields.key.trim().length > 0 &&
    (!needsBase || /^https:\/\/\S+$/.test(fields.baseUrl.trim())) &&
    (account || source !== "azure" || fields.deployments.trim().length > 0);
  const saved = save.data;
  return (
    <Dialog open={open} onClose={close} wide bare>
      <div
        role="document"
        className="mx-auto flex h-[min(37.5rem,calc(100dvh-32px))] w-full max-w-[35rem] flex-col overflow-hidden rounded-2xl bg-card shadow-overlay max-sm:h-dvh max-sm:max-w-none max-sm:rounded-none"
      >
        <div className="flex items-center gap-2 border-border-soft border-b py-3 pr-3 pl-5">
          {step === "form" && !account ? (
            <IconButton label={t("common.back")} onClick={() => setStep("pick")} className="-ml-2">
              <ChevronLeft className="size-[1.125rem]" />
            </IconButton>
          ) : null}
          <h2 className="min-w-0 flex-1 truncate font-display font-semibold text-[1.125rem]">
            {step === "pick" ? t("keys.add") : name}
          </h2>
          <IconButton label={t("common.close")} onClick={close}>
            <X className="size-[1.125rem]" />
          </IconButton>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5">
          {step === "pick" ? (
            <div className="flex flex-col gap-1">
              {ADDABLE.map((id) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={id === source}
                  onClick={() => setSource(id)}
                  className={cn(
                    "flex items-center gap-3 rounded-xl px-3 py-2.5 text-left transition",
                    id === source ? "bg-paper-2 ring-1 ring-ember ring-inset" : "hover:bg-accent",
                  )}
                >
                  <Mono source={id} />
                  <b className="min-w-0 flex-1 font-medium text-[0.875rem]">
                    {sourceOf(id).name()}
                  </b>
                  <span className="text-[0.8125rem] text-ink-3">{sourceOf(id).models?.()}</span>
                </button>
              ))}
            </div>
          ) : step === "form" ? (
            <form
              ref={form}
              id="add-key"
              className="flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (ready && !save.isPending) {
                  save.mutate();
                }
              }}
            >
              {!account && source === "bedrock" ? (
                <Field label={t("keys.region")}>
                  <Select
                    value={fields.region}
                    onChange={(region) => set({ region })}
                    options={REGIONS}
                  />
                </Field>
              ) : null}
              {needsBase ? (
                <Field label={t(source === "azure" ? "keys.endpoint" : "keys.address")}>
                  <Input
                    type="url"
                    value={fields.baseUrl}
                    onChange={(e) => set({ baseUrl: e.target.value })}
                    placeholder={source === "azure" ? "https://…openai.azure.com" : "https://…/v1"}
                  />
                </Field>
              ) : null}
              <Field label={t("keys.apiKey")} hint={keyHint(account?.source ?? source, name)}>
                <Input
                  type="password"
                  autoComplete="off"
                  value={fields.key}
                  onChange={(e) => set({ key: e.target.value })}
                />
              </Field>
              {!account && source === "azure" ? (
                <Field label={t("keys.deployments")} hint={t("keys.deploymentsHint")}>
                  <Input
                    value={fields.deployments}
                    onChange={(e) => set({ deployments: e.target.value })}
                    placeholder="gpt-5.5, gpt-5.4-mini"
                  />
                </Field>
              ) : null}
              {needsBase ? (
                <label className="flex items-start gap-2.5 text-[0.875rem] text-ink-2">
                  <input
                    type="checkbox"
                    checked={fields.confirmed}
                    onChange={(e) => set({ confirmed: e.target.checked })}
                    className="mt-0.5 size-4 shrink-0 accent-ember"
                  />
                  {t(source === "azure" ? "keys.azureCheck" : "keys.compatCheck")}
                </label>
              ) : null}
              {save.isError ? (
                <p className="text-[0.8125rem] text-rose">
                  {save.error instanceof ApiError && save.error.body?.code === "key_refused"
                    ? t("keys.refusedError", { provider: name, error: save.error.message })
                    : (save.error as Error).message}
                </p>
              ) : null}
            </form>
          ) : saved ? (
            <Done account={saved} tier={tier ?? null} />
          ) : null}
        </div>
        <div className="flex justify-end gap-2.5 border-border-soft border-t px-5 py-3.5">
          {step === "pick" ? (
            <Button onClick={() => setStep("form")}>{t("keys.next")}</Button>
          ) : step === "form" ? (
            <Button type="submit" form="add-key" disabled={!ready} busy={save.isPending}>
              {t("keys.save")}
            </Button>
          ) : (
            <Button onClick={close}>{t("keys.done")}</Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}

function keyHint(source: string, name: string): string {
  return source === "bedrock" || source === "azure" || source === "compat"
    ? t(`keys.keyHint.${source}`)
    : t("keys.keyHint", { provider: name });
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="font-medium text-[0.8125rem] text-ink">{label}</span>
      {children}
      {hint ? <span className="text-[0.8125rem] text-ink-3">{hint}</span> : null}
    </label>
  );
}

/** Step 3: saved, and what now runs over the account, or that it rests. */
function Done({ account, tier }: { account: Account; tier: ModelTier | null }) {
  const sub =
    account.status === "resting" || account.passing === 0
      ? tier
        ? t("keys.restsTier", { provider: providerName(account), tier: tier.name })
        : t("keys.rests")
      : account.uses.length
        ? t("keys.usesNow")
        : t("keys.usesNone");
  return (
    <>
      <div className="flex flex-col items-center gap-2.5 px-2 pt-6 pb-2 text-center">
        <span className="grid size-14 place-items-center rounded-full bg-moss-tint text-moss">
          <Check className="size-6" strokeWidth={2.6} />
        </span>
        <h3 className="mt-1.5 font-display font-semibold text-[1.125rem]">{t("keys.saved")}</h3>
        <p className="max-w-[25rem] text-[0.875rem] text-ink-2">{sub}</p>
      </div>
      {account.status !== "resting" && account.uses.length ? (
        <Card className="overflow-hidden p-0">
          {account.uses.map((u) => (
            <div
              key={u.class}
              className="flex justify-between gap-3 border-border-soft border-t px-4 py-3 text-[0.875rem] first:border-t-0"
            >
              <b className="font-medium">{tierClassLabel(u.class)}</b>
              <span className="text-ink-3">{u.model}</span>
            </div>
          ))}
        </Card>
      ) : null}
    </>
  );
}
