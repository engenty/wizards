import { type ModelClass, TEXT_CLASSES, type TextClass } from "@engenty-wizards/shared/definition";
import { featureOn } from "@engenty-wizards/shared/features";
import {
  CAPABILITY_CLASSES,
  CREDITS,
  type CreditModel,
  capabilityOfKind,
  creditsModelOf,
  creditsRef,
  isCreditsRef,
  MODEL_CAPABILITIES,
  type ModelCapability,
  type ModelOption,
  modelLabel,
  PROVIDERS,
  type ProviderId,
  type ProviderInfo,
  providerInfo,
  providerOfRef,
  providerText,
} from "@engenty-wizards/shared/providers";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Check,
  CircleAlert,
  Clapperboard,
  Coins,
  Ear,
  ExternalLink,
  ImageIcon,
  KeyRound,
  Laptop,
  type LucideIcon,
  PenLine,
  Volume2,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { api } from "../lib/api";
import { lang, t } from "../lib/i18n";
import { type HarnessId, type HarnessStatus, type Me, useMe, withoutApple } from "../lib/session";
import { Button, Card, cn, Input, LinkedText, Select, Spinner, Switch } from "../ui";
import { billingUrl } from "./AppFrame";
import { HarnessPanel } from "./Harness";
import { openExternal } from "./LocalRuntime";
import {
  MenuGroup,
  MenuRow,
  type MenuTone,
  SubMenu,
  useDetail,
  useSettingsMenu,
} from "./settings-menu";

/** How a class runs right now, as the runtime resolves it (`classWays`). */
interface ClassWay {
  kind: "client" | "key" | "local" | "credits" | "none";
  by: string | null;
  ref: string;
  problem: string | null;
}

interface ClassPrice {
  model: string;
  creditsPerImage?: number;
  creditsPerSecond?: number;
  creditsPer1kCharacters?: number;
  creditsPerMinute?: number;
}

/** `GET /api/studio/models`: the choices, which keys are there, and how each class runs. */
interface ModelsState {
  source: HarnessId | "account" | "own";
  bindings: Partial<Record<ModelClass, string>>;
  ollamaUrl: string;
  creditFallback: boolean;
  keys: Record<ProviderId, boolean>;
  ways: Record<ModelClass, ClassWay>;
  /** Apple Intelligence on this Mac: shown where the machine can run it, picked once it answers. */
  apple?: AppleStatus | null;
  prices: Partial<Record<ModelClass, ClassPrice | null>> | null;
  /** The media models the credits pay for, which a binding may name. */
  creditModels: CreditModel[];
}

interface AppleStatus {
  supported: boolean;
  available: boolean;
  reason: "device" | "os" | "missing" | "off" | "loading" | null;
}

/** A model on this machine: Ollama, or Apple Intelligence on a Mac. */
type LocalBy = "ollama" | "apple";

interface ModelsInput {
  source?: ModelsState["source"];
  bindings?: Partial<Record<ModelClass, string>>;
  ollamaUrl?: string;
  creditFallback?: boolean;
  keys?: Partial<Record<ProviderId, string>>;
}

interface TestResult {
  ok: boolean;
  ms: number;
  ref?: string;
  reply?: string;
  media?: string;
  error?: string;
}

/**
 * Where the page stands: alone on this machine (with or without a linked account) or in the
 * cloud, for a team. Everything that differs between them is decided from here, so the page can
 * be looked at as each of them (`Preview`, in development).
 */
interface Place {
  cloud: boolean;
  account: Me["account"];
  /** Credits are there to step in: the cloud's, or the linked account's. */
  credits: boolean;
  balance: number | null;
  topUp: string | null;
  harnesses: HarnessStatus[];
  canEdit: boolean;
  /** Own API keys are a feature of the team's plan; alone they always are. */
  ownKeys: boolean;
}

type View = "auto" | "local" | "linked" | "cloud";

function placeOf(me: Me, view: View): Place {
  const cloud = view === "auto" ? me.mode === "managed" : view === "cloud";
  const account =
    view === "auto" || view === "linked"
      ? (me.account ??
        (view === "linked"
          ? {
              name: me.user.name,
              email: me.user.email,
              team: null,
              credits: 1250,
              expiring: [],
              url: "",
              cloudUrl: "",
              signedIn: true,
            }
          : null))
      : null;
  return {
    cloud,
    account: cloud ? null : account,
    credits: cloud || Boolean(account?.signedIn),
    balance: cloud ? (me.credits ?? (view === "cloud" ? 1250 : null)) : (account?.credits ?? null),
    topUp: billingUrl(me),
    harnesses: cloud ? [] : me.harnesses,
    canEdit: !cloud || me.tenant.role !== "member",
    ownKeys: !cloud || featureOn(me.features, "ownKeys"),
  };
}

const CAP_ICON: Record<ModelCapability, LucideIcon> = {
  text: PenLine,
  image: ImageIcon,
  video: Clapperboard,
  speech: Volume2,
  listening: Ear,
};

/** The class a capability is judged by: text by `standard`, the others by their one class. */
const LEAD_CLASS: Record<ModelCapability, ModelClass> = {
  text: "standard",
  image: "image",
  video: "video",
  speech: "speech",
  listening: "audio",
};

const isText = (cap: ModelCapability) => cap === "text";

/** What a person picked for a capability, which may differ from how it runs (a key is missing). */
type Choice =
  | { kind: "client"; id: HarnessId }
  | { kind: "key"; provider: ProviderId }
  | { kind: "local"; by: LocalBy }
  | { kind: "credits" };

function sameChoice(a: Choice | null, b: Choice | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function choiceOf(state: ModelsState, cap: ModelCapability, place: Place): Choice | null {
  const cls = LEAD_CLASS[cap];
  if (isText(cap) && !place.cloud) {
    // Apple Intelligence thinks the short classes beside any source.
    if (state.bindings.standard?.startsWith("apple:")) {
      return { kind: "local", by: "apple" };
    }
    if (state.source === "account") {
      return { kind: "credits" };
    }
    if (state.source !== "own") {
      return { kind: "client", id: state.source };
    }
  }
  const bound = state.bindings[cls];
  if (isCreditsRef(bound)) {
    return { kind: "credits" };
  }
  if (bound?.startsWith("ollama:")) {
    return { kind: "local", by: "ollama" };
  }
  if (bound?.startsWith("apple:")) {
    return { kind: "local", by: "apple" };
  }
  const provider = bound ? providerOfRef(bound) : null;
  if (provider) {
    return { kind: "key", provider };
  }
  if (bound && /^(claude|codex|antigravity|cursor)\//.test(bound)) {
    return { kind: "client", id: bound.split("/")[0] as HarnessId };
  }
  const way = state.ways[cls];
  switch (way.kind) {
    case "client":
      return { kind: "client", id: way.by as HarnessId };
    case "key":
      return providerInfo(way.by ?? "") ? { kind: "key", provider: way.by as ProviderId } : null;
    case "local":
      return { kind: "local", by: way.by === "apple" ? "apple" : "ollama" };
    case "credits":
      return { kind: "credits" };
    default:
      return null;
  }
}

/** The bindings a provider gets for a capability: its first model, or the one already bound. */
function providerBindings(
  provider: ProviderInfo,
  cap: ModelCapability,
  state: ModelsState,
): Partial<Record<ModelClass, string>> {
  if (isText(cap) && provider.text) {
    return provider.text;
  }
  const cls = LEAD_CLASS[cap];
  const bound = state.bindings[cls];
  const ref =
    bound && providerOfRef(bound) === provider.id ? bound : provider.models[cap]?.[0]?.ref;
  return ref ? { [cls]: ref } : {};
}

/** How an installed client stands: signed in on the plan, on a key from the shell, or not at all. */
function clientNote(h: HarnessStatus): { note: string; noteTone?: "done" | "warn" } {
  if (h.version === null) {
    return { note: t("models.noteMissing"), noteTone: "warn" };
  }
  if (h.auth === "none") {
    return { note: t("models.noteSignedOut"), noteTone: "warn" };
  }
  return h.auth === "api_key"
    ? { note: t("models.noteShellKey") }
    : { note: t("models.noteIncluded"), noteTone: "done" };
}

/** How a capability runs, in a few words: the left list's note and the panel's status. */
function wayText(way: ClassWay, place: Place): { text: string; tone: "done" | "ok" | "warn" } {
  switch (way.kind) {
    case "client":
      return {
        text: place.harnesses.find((h) => h.id === way.by)?.name ?? way.by ?? "",
        tone: "done",
      };
    case "key":
      return { text: providerInfo(way.by ?? "")?.name ?? way.by ?? "", tone: "done" };
    case "local":
      return {
        text: way.by === "apple" ? t("models.optApple") : t("models.way.local"),
        tone: "done",
      };
    case "credits":
      return {
        text: place.cloud ? t("models.way.creditsTeam") : t("models.way.credits"),
        tone: "ok",
      };
    default:
      return { text: t("models.way.none"), tone: "warn" };
  }
}

function useModels() {
  return useQuery({
    queryKey: ["models"],
    queryFn: () => api.get<ModelsState>("/api/studio/models"),
  });
}

function useSave() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ModelsInput) => api.put<ModelsState>("/api/studio/models", input),
    onSuccess: async (state) => {
      qc.setQueryData(["models"], state);
      await qc.invalidateQueries({ queryKey: ["me"] });
    },
  });
}

// --- small parts -------------------------------------------------------------------

/** A part of the panel's card: a small heading, then its content. */
function Part({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 border-border-soft border-t pt-5 first:border-t-0 first:pt-0">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="font-medium text-[0.875rem]">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return <p className="text-[0.8125rem] text-ink-3">{children}</p>;
}

/** The status of a panel, beside its name. */
function Status({ text, tone }: { text: string; tone: "done" | "ok" | "warn" }) {
  return (
    <span
      className={cn(
        "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-3 font-medium text-[0.75rem]",
        tone === "done" && "bg-moss-tint text-moss",
        tone === "ok" && "bg-amber-tint text-ink-2",
        tone === "warn" && "bg-paper-2 text-ink-3",
      )}
    >
      {tone === "done" ? <Check className="size-3.5" strokeWidth={3} /> : null}
      {tone === "ok" ? <Coins className="size-3.5" /> : null}
      {tone === "warn" ? <CircleAlert className="size-3.5" /> : null}
      {text}
    </span>
  );
}

/** The panel's head: its name, one line on what it is for, and how it stands. */
function PanelHead({
  icon: Icon,
  title,
  lead,
  status,
}: {
  icon: LucideIcon;
  title: string;
  lead: string;
  status?: ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 sm:gap-4">
      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-ember-tint text-ember-strong">
        <Icon className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h2 className="font-display font-semibold text-[1.375rem] leading-tight tracking-tight">
            {title}
          </h2>
          {status}
        </div>
        <p className="mt-0.5 text-[0.875rem] text-ink-3">{lead}</p>
      </div>
    </div>
  );
}

/** The ways of one kind (subscription, own key, …): their name once, then their cards. */
function OptionGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid items-start gap-x-4 gap-y-1.5 sm:grid-cols-[7.5rem_minmax(0,1fr)]">
      <span className="pt-2 text-[0.75rem] text-ink-3">{label}</span>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

/**
 * One way a capability can run, as a pill to pick. `ready`: it runs as soon as it is picked (a
 * key is there, a client is signed in); the note says the rest, on hover.
 */
function Option({
  selected,
  title,
  note,
  noteTone,
  disabled,
  onPick,
}: {
  selected: boolean;
  title: string;
  note: string;
  noteTone?: "done" | "warn";
  disabled?: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      disabled={disabled}
      aria-pressed={selected}
      title={note}
      className={cn(
        "inline-flex h-9 items-center gap-1.5 rounded-full border px-3.5 text-[0.8125rem] transition coarse:h-11",
        selected
          ? "border-ember bg-ember-tint font-medium text-ink"
          : noteTone === "done"
            ? "border-input bg-card text-ink hover:border-ink-4"
            : "border-border-soft border-dashed text-ink-3 hover:border-ink-4 hover:text-ink",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      {noteTone === "done" ? <Check className="size-3.5 text-moss" strokeWidth={3} /> : null}
      {title}
      <span className="sr-only">: {note}</span>
    </button>
  );
}

// --- keys --------------------------------------------------------------------------

/** A provider's key: typed, checked with the provider, then kept; or there, to check or remove. */
function KeyField({
  provider,
  stored,
  place,
}: {
  provider: ProviderInfo;
  stored: boolean;
  place: Place;
}) {
  const save = useSave();
  const [value, setValue] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [said, setSaid] = useState<{ ok: boolean; message: string } | null>(null);
  const check = useMutation({
    mutationFn: (key?: string) =>
      api.post<{ ok: boolean; message: string | null }>(
        `/api/studio/models/keys/${provider.id}/check`,
        key ? { key } : {},
      ),
  });
  const submit = async () => {
    setSaid(null);
    const result = await check.mutateAsync(value.trim());
    if (!result.ok) {
      setSaid({ ok: false, message: result.message ?? t("models.keyBad") });
      return;
    }
    await save.mutateAsync({ keys: { [provider.id]: value.trim() } });
    setValue("");
    setReplacing(false);
    setSaid({ ok: true, message: t("models.keyOk") });
  };
  const editing = !stored || replacing;
  // Own keys are a feature of the team's plan: without it, the credits pay and no key is taken.
  if (!place.ownKeys) {
    return <p className="text-[0.8125rem] text-ink-3">{t("models.ownKeysPlan")}</p>;
  }
  return (
    <div className="flex flex-col gap-2.5">
      {editing ? (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="password"
            autoComplete="off"
            className="min-w-0 flex-1 font-mono text-[0.8125rem]"
            placeholder={provider.keyPlaceholder}
            value={value}
            disabled={!place.canEdit}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && value.trim()) {
                void submit();
              }
            }}
          />
          <Button
            busy={check.isPending || save.isPending}
            disabled={!value.trim() || !place.canEdit}
            onClick={() => void submit()}
          >
            {t("models.keySave")}
          </Button>
          {replacing ? (
            <Button variant="ghost" onClick={() => setReplacing(false)}>
              {t("common.cancel")}
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="flex items-center gap-2 text-[0.875rem] text-ink-2">
            <KeyRound className="size-4 text-moss" /> {t("models.keyStored")}
          </span>
          <Button
            size="sm"
            variant="ghost"
            busy={check.isPending}
            onClick={async () => {
              const result = await check.mutateAsync(undefined);
              setSaid(
                result.ok
                  ? { ok: true, message: t("models.keyOk") }
                  : { ok: false, message: result.message ?? t("models.keyBad") },
              );
            }}
          >
            {t("models.keyCheck")}
          </Button>
          {place.canEdit ? (
            <>
              <Button size="sm" variant="ghost" onClick={() => setReplacing(true)}>
                {t("models.keyReplace")}
              </Button>
              <Button
                size="sm"
                variant="danger"
                busy={save.isPending}
                onClick={() => {
                  setSaid(null);
                  save.mutate({ keys: { [provider.id]: "" } });
                }}
              >
                {t("models.keyRemove")}
              </Button>
            </>
          ) : null}
        </div>
      )}
      {said ? (
        <p
          className={cn(
            "flex items-center gap-1.5 text-[0.8125rem]",
            said.ok ? "text-moss" : "text-rose",
          )}
        >
          {said.ok ? <Check className="size-3.5" strokeWidth={3} /> : null}
          {said.message}
        </p>
      ) : null}
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.75rem] text-ink-4">
        <button
          type="button"
          onClick={() => openExternal(provider.keyUrl)}
          className="inline-flex items-center gap-1 font-medium text-ember-strong hover:underline"
        >
          {t("models.keyGet", { name: provider.name })} <ExternalLink className="size-3" />
        </button>
        <span>{place.cloud ? t("models.keyWhereCloud") : t("models.keyWhereLocal")}</span>
      </p>
    </div>
  );
}

// --- choosing a model --------------------------------------------------------------

const CUSTOM = "__custom__";

/** A provider's models for a capability, the bound one among them, or a model id of one's own. */
function ModelPick({
  provider,
  cap,
  value,
  onPick,
  disabled,
}: {
  provider: ProviderInfo;
  cap: ModelCapability;
  value: string;
  onPick: (ref: string) => void;
  disabled?: boolean;
}) {
  const at = lang;
  const offered: ModelOption[] = provider.models[cap] ?? [];
  const known = offered.some((m) => m.ref === value);
  const [custom, setCustom] = useState(!known && Boolean(value));
  const [draft, setDraft] = useState(known ? "" : value.replace(/^[a-z]+:/, ""));
  const prefix = provider.id === "gateway" ? "" : `${provider.id}:`;
  return (
    <div className="flex flex-col gap-2">
      <Select
        value={custom ? CUSTOM : value}
        onChange={(next) => {
          if (next === CUSTOM) {
            setCustom(true);
            return;
          }
          setCustom(false);
          onPick(next);
        }}
        options={[
          ...offered.map((m) => ({
            value: m.ref,
            label: m.note ? `${m.label} – ${providerText(m.note, at)}` : m.label,
          })),
          { value: CUSTOM, label: t("models.modelCustom") },
        ]}
      />
      {custom ? (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            className="min-w-0 flex-1 font-mono text-[0.8125rem]"
            value={draft}
            disabled={disabled}
            placeholder={offered[0]?.ref.replace(/^[a-z]+:/, "") ?? ""}
            onChange={(e) => setDraft(e.target.value)}
          />
          <Button
            variant="secondary"
            disabled={!draft.trim() || disabled}
            onClick={() => onPick(`${prefix}${draft.trim()}`)}
          >
            {t("settings.save")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** Text in two lines: what the simple steps run on, and what the demanding ones run on. */
function TextSummary({ provider, state }: { provider: ProviderInfo; state: ModelsState }) {
  const of = (cls: TextClass) => modelLabel(state.bindings[cls] ?? provider.text?.[cls] ?? "");
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-[0.875rem]">
      <dt className="text-ink-3">{t("models.textSimple")}</dt>
      <dd className="truncate font-medium">{of("standard")}</dd>
      <dt className="text-ink-3">{t("models.textDemanding")}</dt>
      <dd className="truncate font-medium">{of("high")}</dd>
    </dl>
  );
}

/** Text runs on four classes: each can take another of the provider's models. */
function PerClass({
  provider,
  state,
  onPick,
  disabled,
}: {
  provider: ProviderInfo;
  state: ModelsState;
  onPick: (cls: TextClass, ref: string) => void;
  disabled?: boolean;
}) {
  return (
    <details className="group rounded-lg ring-1 ring-border-soft">
      <summary className="cursor-pointer list-none px-3 py-2.5 text-[0.8125rem] text-ink-2 hover:text-ink">
        <span className="inline-flex items-center gap-1.5">
          <ArrowRight className="size-3.5 transition group-open:rotate-90" />
          {t("models.perClass")}
        </span>
      </summary>
      <div className="flex flex-col gap-3 px-3 pt-1 pb-3">
        {TEXT_CLASSES.map((cls) => (
          <div key={cls} className="grid items-center gap-2 sm:grid-cols-[9rem_minmax(0,1fr)]">
            <div>
              <div className="text-[0.8125rem] text-ink-2">{t(`class.${cls}`)}</div>
              <div className="text-[0.6875rem] text-ink-4 leading-snug">
                {t(`class.${cls}.hint`)}
              </div>
            </div>
            <ModelPick
              provider={provider}
              cap="text"
              value={state.bindings[cls] ?? provider.text?.[cls] ?? ""}
              disabled={disabled}
              onPick={(ref) => onPick(cls, ref)}
            />
          </div>
        ))}
      </div>
    </details>
  );
}

// --- trying it ---------------------------------------------------------------------

/** One call as a run makes it; an image, a voice or a clip comes back to look at or hear. */
function TryIt({ cap, disabled }: { cap: ModelCapability; disabled?: boolean }) {
  const cls = LEAD_CLASS[cap];
  const test = useMutation({
    mutationFn: () => api.post<TestResult>("/api/studio/models/test", { cls, lang }),
  });
  const r = test.data;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="secondary"
          busy={test.isPending}
          disabled={disabled}
          onClick={() => test.mutate()}
        >
          {t(`models.try.${cap}`)}
        </Button>
        <span className="text-[0.75rem] text-ink-4">
          {cap === "video" ? t("models.tryCostVideo") : isText(cap) ? null : t("models.tryCost")}
        </span>
      </div>
      {test.isPending && cap !== "text" ? (
        <p className="flex items-center gap-2 text-[0.8125rem] text-ink-3">
          <Spinner className="size-3.5" />{" "}
          {t(cap === "video" ? "models.tryWaitVideo" : "models.tryWait")}
        </p>
      ) : null}
      {r?.ok ? (
        <div className="flex flex-col gap-2">
          {r.media && cap === "image" ? (
            <img
              src={r.media}
              alt=""
              className="size-48 rounded-lg object-cover ring-1 ring-border-soft"
            />
          ) : null}
          {r.media && cap === "speech" ? (
            // biome-ignore lint/a11y/useMediaCaption: a test voice the person asked to hear
            <audio src={r.media} controls autoPlay className="w-full max-w-sm" />
          ) : null}
          {r.media && cap === "video" ? (
            <video src={r.media} controls autoPlay muted className="w-full max-w-md rounded-lg" />
          ) : null}
          <p className="flex items-start gap-2 text-[0.8125rem] text-ink-2">
            <Check className="mt-0.5 size-3.5 shrink-0 text-moss" strokeWidth={3} />
            <span>
              {cap === "listening"
                ? r.reply
                  ? t("models.tryHeard", { text: r.reply })
                  : t("models.tryHeardNothing")
                : isText(cap)
                  ? t("local.testOk", {
                      s: (r.ms / 1000).toFixed(1),
                      ref: modelLabel(r.ref ?? ""),
                      reply: r.reply ?? "",
                    })
                  : t("models.tryOk", {
                      s: (r.ms / 1000).toFixed(1),
                      model: modelLabel(r.ref ?? ""),
                    })}
            </span>
          </p>
        </div>
      ) : null}
      {r && !r.ok ? (
        <p className="text-[0.8125rem] text-rose">
          {t("models.tryFailed", { error: r.error ?? "" })}
        </p>
      ) : null}
      {test.isError ? (
        <p className="text-[0.8125rem] text-rose">
          {t("models.tryFailed", { error: (test.error as Error).message })}
        </p>
      ) : null}
    </div>
  );
}

// --- the panels --------------------------------------------------------------------

/** A price in credits, by what it is counted in. */
function creditPrice(price: Omit<ClassPrice, "model"> | undefined | null): string {
  const n = (x: number) => (x < 10 ? Math.round(x * 10) / 10 : Math.ceil(x)).toLocaleString(lang);
  if (price?.creditsPerImage) {
    return t("models.notePerImage", { n: n(price.creditsPerImage) });
  }
  if (price?.creditsPerSecond) {
    return t("models.notePerSecond", { n: n(price.creditsPerSecond) });
  }
  if (price?.creditsPer1kCharacters) {
    return t("models.notePer1k", { n: n(price.creditsPer1kCharacters) });
  }
  if (price?.creditsPerMinute) {
    return t("models.notePerMinute", { n: n(price.creditsPerMinute) });
  }
  return t("models.noteUsage");
}

function priceNote(cap: ModelCapability, state: ModelsState): string {
  const named = creditsModelOf(state.bindings[LEAD_CLASS[cap]]);
  const model = named ? state.creditModels.find((m) => m.id === named) : null;
  return creditPrice(model ?? state.prices?.[LEAD_CLASS[cap]]);
}

/** The credit models of a capability, optionally of one maker or provider. */
function creditModelsFor(state: ModelsState, cap: ModelCapability, provider?: ProviderId) {
  return state.creditModels.filter(
    (m) =>
      capabilityOfKind(m.kind) === cap &&
      (!provider || m.source === provider || m.provider === provider),
  );
}

/** On the credits: engenty's model of the class, or one named — fal, ElevenLabs, Veo … */
function CreditModelPick({
  cap,
  state,
  disabled,
}: {
  cap: ModelCapability;
  state: ModelsState;
  disabled?: boolean;
}) {
  const save = useSave();
  const cls = LEAD_CLASS[cap];
  const named = creditsModelOf(state.bindings[cls]);
  const models = creditModelsFor(state, cap);
  const engenty = state.prices?.[cls]?.model;
  const source = (m: CreditModel) =>
    m.source === "ai-gateway"
      ? (providerInfo(m.provider)?.name ?? m.provider)
      : (providerInfo(m.source)?.name ?? m.source);
  return (
    <Select
      value={named ?? ""}
      onChange={(id) => save.mutate({ bindings: { [cls]: creditsRef(id || null) } })}
      options={[
        {
          value: "",
          label: engenty
            ? t("models.creditsAuto", { model: modelLabel(engenty) })
            : t("models.creditsAutoNone"),
        },
        ...models.map((m) => ({
          value: m.id,
          label: `${m.name} · ${source(m)} – ${creditPrice(m)}`,
          disabled,
        })),
      ]}
    />
  );
}

/** A provider's models on the credits, each to use for its capability with one click. */
function CreditOffers({
  models,
  state,
  place,
}: {
  models: CreditModel[];
  state: ModelsState;
  place: Place;
}) {
  const save = useSave();
  return (
    <ul className="flex flex-col divide-y divide-border-soft">
      {models.map((m) => {
        const cap = capabilityOfKind(m.kind);
        const cls = LEAD_CLASS[cap];
        const inUse = state.bindings[cls] === creditsRef(m.id);
        return (
          <li key={m.id} className="flex flex-wrap items-center gap-3 py-2.5">
            <Coins className="size-4 shrink-0 text-ink-3" />
            <span className="min-w-0 flex-1">
              <span className="block font-medium text-[0.875rem]">{m.name}</span>
              <span className="block text-[0.75rem] text-ink-3">
                {t(`models.cap.${cap}`)} · {creditPrice(m)}
              </span>
            </span>
            {inUse ? (
              <span className="flex items-center gap-1 font-medium text-[0.75rem] text-moss">
                <Check className="size-3.5" strokeWidth={3} /> {t("models.inUse")}
              </span>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                disabled={!place.canEdit || !place.credits}
                busy={save.isPending && save.variables?.bindings?.[cls] === creditsRef(m.id)}
                onClick={() => save.mutate({ bindings: { [cls]: creditsRef(m.id) } })}
              >
                {t("models.useFor")}
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** One capability: who does it, which model, the key it needs, and a try. */
function CapabilityPanel({
  cap,
  state,
  place,
  me,
  onOpen,
}: {
  cap: ModelCapability;
  state: ModelsState;
  place: Place;
  me: Me;
  onOpen: (target: Target) => void;
}) {
  const save = useSave();
  const cls = LEAD_CLASS[cap];
  const way = state.ways[cls];
  const chosen = choiceOf(state, cap, place);
  const [needsAccount, setNeedsAccount] = useState(false);
  const status = wayText(way, place);

  const clients = place.harnesses.filter(
    (h) =>
      (isText(cap) || (cap === "image" && h.images)) &&
      (h.version !== null || (chosen?.kind === "client" && chosen.id === h.id)),
  );
  const providers = PROVIDERS.filter((p) => p.models[cap]?.length);

  const pick = (next: Choice) => {
    setNeedsAccount(false);
    if (next.kind === "credits" && !place.credits) {
      setNeedsAccount(true);
      return;
    }
    if (sameChoice(next, chosen)) {
      return;
    }
    const classes = CAPABILITY_CLASSES[cap];
    const every = (ref: string) => Object.fromEntries(classes.map((c) => [c, ref]));
    switch (next.kind) {
      case "client":
        save.mutate(
          isText(cap)
            ? { source: next.id, bindings: withoutApple(state.bindings) }
            : { bindings: { [cls]: `${next.id}/image` } },
        );
        return;
      case "key": {
        const provider = providerInfo(next.provider) as ProviderInfo;
        save.mutate({
          ...(isText(cap) && !place.cloud ? { source: "own" as const } : {}),
          bindings: providerBindings(provider, cap, state),
        });
        return;
      }
      case "local":
        save.mutate(
          next.by === "apple"
            ? { bindings: isText(cap) ? appleBindings(state) : { audio: "apple:transcribe" } }
            : { source: "own", bindings: every("ollama:qwen3") },
        );
        return;
      case "credits":
        save.mutate(
          isText(cap) && !place.cloud
            ? { source: "account", bindings: withoutApple(state.bindings) }
            : { bindings: every(CREDITS) },
        );
        return;
    }
  };

  const provider = chosen?.kind === "key" ? providerInfo(chosen.provider) : null;
  const keyMissing = provider ? !state.keys[provider.id] : false;
  const client = chosen?.kind === "client" ? place.harnesses.find((h) => h.id === chosen.id) : null;
  const runs = way.kind !== "none";

  return (
    <div className="flex flex-col gap-5">
      <PanelHead
        icon={CAP_ICON[cap]}
        title={t(`models.cap.${cap}`)}
        lead={t(`models.cap.${cap}.hint`)}
        status={<Status {...status} />}
      />
      <Card className="flex flex-col gap-6 p-3.5 sm:p-5 sm:p-6">
        <Part title={t("models.who")}>
          <div className="flex flex-col gap-3">
            {clients.length ? (
              <OptionGroup label={t("models.optSubscription")}>
                {clients.map((h) => (
                  <Option
                    key={h.id}
                    title={h.name}
                    {...clientNote(h)}
                    selected={chosen?.kind === "client" && chosen.id === h.id}
                    disabled={!place.canEdit}
                    onPick={() => pick({ kind: "client", id: h.id })}
                  />
                ))}
              </OptionGroup>
            ) : null}
            <OptionGroup label={t("models.optKey")}>
              {providers.map((p) => (
                <Option
                  key={p.id}
                  title={p.name}
                  note={state.keys[p.id] ? t("models.noteKey") : t("models.noteNoKey")}
                  noteTone={state.keys[p.id] ? "done" : undefined}
                  selected={chosen?.kind === "key" && chosen.provider === p.id}
                  disabled={!place.canEdit}
                  onPick={() => pick({ kind: "key", provider: p.id })}
                />
              ))}
            </OptionGroup>
            <OptionGroup
              label={
                isText(cap) && !place.cloud ? t("models.optOther") : t("models.optCreditsGroup")
              }
            >
              {/* Text thinks on Apple Intelligence once it is switched on; a voice note the Mac
                  writes down on its own, Apple Intelligence or not. */}
              {(isText(cap) || cap === "listening") && !place.cloud && state.apple?.supported ? (
                <Option
                  title={t("models.optApple")}
                  note={isText(cap) ? appleNote(state.apple) : t("models.optAppleNote")}
                  noteTone={isText(cap) && !state.apple.available ? undefined : "done"}
                  selected={chosen?.kind === "local" && chosen.by === "apple"}
                  disabled={!place.canEdit || (isText(cap) && !state.apple.available)}
                  onPick={() => pick({ kind: "local", by: "apple" })}
                />
              ) : null}
              {isText(cap) && !place.cloud ? (
                <Option
                  title={t("models.optLocal")}
                  note={t("models.optLocalNote")}
                  selected={chosen?.kind === "local" && chosen.by === "ollama"}
                  disabled={!place.canEdit}
                  onPick={() => pick({ kind: "local", by: "ollama" })}
                />
              ) : null}
              <Option
                title={place.cloud ? t("models.creditsTeam") : t("models.creditsName")}
                note={place.credits ? priceNote(cap, state) : t("models.noteNeedsAccount")}
                noteTone={place.credits ? "done" : undefined}
                selected={chosen?.kind === "credits"}
                disabled={!place.canEdit}
                onPick={() => pick({ kind: "credits" })}
              />
            </OptionGroup>
          </div>
          {needsAccount ? (
            <p className="text-[0.8125rem] text-ink-2">
              {t("local.sourceNeedsAccount")} <AccountLink />
            </p>
          ) : null}
          {save.isError ? (
            <p className="text-[0.8125rem] text-rose">{(save.error as Error).message}</p>
          ) : null}
        </Part>

        {provider ? (
          <>
            {keyMissing ? (
              <Part title={t("models.keyFor", { name: provider.name })}>
                <KeyField provider={provider} stored={false} place={place} />
                {place.credits ? (
                  <Hint>
                    <Coins className="mr-1 inline size-3.5 align-[-2px]" />
                    {t("models.keyFallback")}
                  </Hint>
                ) : null}
              </Part>
            ) : null}
            {keyMissing && place.credits && creditModelsFor(state, cap, provider.id).length ? (
              <Part title={t("models.viaCredits", { name: provider.name })}>
                <CreditOffers
                  models={creditModelsFor(state, cap, provider.id)}
                  state={state}
                  place={place}
                />
              </Part>
            ) : null}
            <Part
              title={t("models.model")}
              aside={
                keyMissing ? null : (
                  <button
                    type="button"
                    onClick={() => onOpen({ type: "provider", id: provider.id })}
                    className="text-[0.75rem] text-ink-3 hover:text-ink"
                  >
                    {t("models.manageKey", { name: provider.name })}
                  </button>
                )
              }
            >
              {isText(cap) && provider.text ? (
                <>
                  <TextSummary provider={provider} state={state} />
                  <PerClass
                    provider={provider}
                    state={state}
                    disabled={!place.canEdit}
                    onPick={(c, ref) => save.mutate({ bindings: { [c]: ref } })}
                  />
                </>
              ) : (
                <ModelPick
                  key={`${provider.id}:${state.bindings[cls] ?? ""}`}
                  provider={provider}
                  cap={cap}
                  value={state.bindings[cls] ?? provider.models[cap]?.[0]?.ref ?? ""}
                  disabled={!place.canEdit}
                  onPick={(ref) => save.mutate({ bindings: { [cls]: ref } })}
                />
              )}
            </Part>
          </>
        ) : null}

        {chosen?.kind === "client" && client ? (
          isText(cap) ? (
            <Part title={client.name}>
              <HarnessPanel me={me} id={client.id} />
            </Part>
          ) : (
            <Part title={client.name}>
              <Hint>
                {t("models.clientImages", {
                  name: client.name,
                  sub: t(`harness.sub.${client.id}`),
                })}
              </Hint>
            </Part>
          )
        ) : null}

        {chosen?.kind === "local" ? (
          chosen.by === "apple" ? (
            <ApplePart cap={cap} state={state} place={place} />
          ) : (
            <OllamaPart state={state} disabled={!place.canEdit} />
          )
        ) : null}

        {chosen?.kind === "credits" && place.credits ? (
          isText(cap) ? (
            <Part title={t("models.creditsName")}>
              <Hint>
                {t("models.creditsPicks")}
                {way.kind === "credits" && way.ref
                  ? ` ${t("models.creditsModel", { model: modelLabel(way.ref) })}`
                  : ""}
              </Hint>
            </Part>
          ) : (
            <Part title={t("models.model")}>
              <CreditModelPick cap={cap} state={state} disabled={!place.canEdit} />
              <Hint>{t("models.creditsPickHint")}</Hint>
            </Part>
          )
        ) : null}

        {way.problem ? (
          <p className="flex items-start gap-2 rounded-lg bg-paper-2 px-3 py-2.5 text-[0.8125rem] text-ink-2">
            <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-ink-3" />
            <span>
              <LinkedText text={way.problem} />
            </span>
          </p>
        ) : null}

        {/* An installed client brings its own test with its sign-in. */}
        {chosen?.kind === "client" && isText(cap) ? null : (
          <Part title={t("models.try")}>
            <TryIt key={`${cap}:${way.ref}`} cap={cap} disabled={!runs || !place.canEdit} />
          </Part>
        )}

        {isText(cap) && me.subscriptions.includes("claude") && !place.cloud ? (
          <ChatEngine me={me} />
        ) : null}
      </Card>
    </div>
  );
}

/**
 * Apple Intelligence thinks the short classes; the source stays, so the long ones keep their way
 * (the installed client, the credits, a key), unless that was a local model too — then they are
 * unbound and the credits or nothing step in, as the hint says.
 */
function appleBindings(state: ModelsState): Partial<Record<ModelClass, string>> {
  const keep = (cls: ModelClass) => {
    const bound = state.bindings[cls] ?? "";
    return /^(ollama|apple):/.test(bound) ? "" : bound;
  };
  return {
    classifier: "apple:default",
    standard: "apple:default",
    high: keep("high"),
    highest: keep("highest"),
  };
}

/** Why Apple Intelligence can or cannot be picked, under its name. */
function appleNote(apple: AppleStatus): string {
  if (apple.available) {
    return t("models.optAppleNote");
  }
  switch (apple.reason) {
    case "off":
      return t("models.appleOff");
    case "loading":
      return t("models.appleLoading");
    default:
      return t("models.appleDevice");
  }
}

function ApplePart({
  cap,
  state,
  place,
}: {
  cap: ModelCapability;
  state: ModelsState;
  place: Place;
}) {
  return (
    <Part title={t("models.optApple")}>
      <Hint>
        {isText(cap)
          ? t("models.appleHint", { way: wayText(state.ways.high, place).text })
          : t("models.appleListenHint")}
      </Hint>
    </Part>
  );
}

function OllamaPart({ state, disabled }: { state: ModelsState; disabled?: boolean }) {
  const save = useSave();
  const [url, setUrl] = useState(state.ollamaUrl);
  const [model, setModel] = useState(
    (state.bindings.standard ?? "ollama:qwen3").replace(/^ollama:/, ""),
  );
  return (
    <Part title={t("models.optLocal")}>
      <Hint>{t("models.ollamaHint")}</Hint>
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_12rem_auto]">
        <Input
          className="font-mono text-[0.8125rem]"
          value={url}
          disabled={disabled}
          onChange={(e) => setUrl(e.target.value)}
        />
        <Input
          className="font-mono text-[0.8125rem]"
          value={model}
          disabled={disabled}
          onChange={(e) => setModel(e.target.value)}
        />
        <Button
          variant="secondary"
          busy={save.isPending}
          disabled={disabled || !model.trim()}
          onClick={() =>
            save.mutate({
              ollamaUrl: url,
              bindings: Object.fromEntries(TEXT_CLASSES.map((c) => [c, `ollama:${model.trim()}`])),
            })
          }
        >
          {t("settings.save")}
        </Button>
      </div>
    </Part>
  );
}

/** What answers the studio chat where a Claude subscription is there. */
function ChatEngine({ me }: { me: Me }) {
  const qc = useQueryClient();
  const chat = useMutation({
    mutationFn: (engine: "models" | "claude") => api.put("/api/studio/local/chat", { engine }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }),
  });
  return (
    <Part title={t("local.chat")}>
      <div className="flex flex-wrap gap-2">
        {(["models", "claude"] as const).map((engine) => (
          <button
            key={engine}
            type="button"
            aria-pressed={me.chatEngine === engine}
            onClick={() => chat.mutate(engine)}
            className={cn(
              "h-9 rounded-full border px-3.5 text-[0.8125rem] transition",
              me.chatEngine === engine
                ? "border-ember bg-ember-tint text-ink"
                : "border-input bg-card text-ink-2 hover:text-ink",
            )}
          >
            {engine === "claude" ? t("local.chatClaude") : t("local.chatModels")}
          </button>
        ))}
      </div>
      <Hint>{t("local.subscription")}</Hint>
    </Part>
  );
}

/** One provider: its key, and what it does for which capability. */
function ProviderPanel({
  provider,
  state,
  place,
  onOpen,
}: {
  provider: ProviderInfo;
  state: ModelsState;
  place: Place;
  onOpen: (target: Target) => void;
}) {
  const save = useSave();
  const caps = MODEL_CAPABILITIES.filter((c) => provider.models[c]?.length);
  const stored = state.keys[provider.id];
  // What the credits pay for of this provider: its own models, or those it made.
  const offers =
    provider.id === "gateway"
      ? []
      : state.creditModels.filter((m) => m.source === provider.id || m.provider === provider.id);
  return (
    <div className="flex flex-col gap-5">
      <PanelHead
        icon={KeyRound}
        title={provider.name}
        lead={providerText(provider.about, lang)}
        status={
          <Status
            text={stored ? t("models.keyStored") : t("models.keyNone")}
            tone={stored ? "done" : "warn"}
          />
        }
      />
      <Card className="flex flex-col gap-6 p-3.5 sm:p-5 sm:p-6">
        <Part title={t("models.key")}>
          <KeyField provider={provider} stored={stored} place={place} />
        </Part>
        <Part title={t("models.uses")}>
          <ul className="flex flex-col divide-y divide-border-soft">
            {caps.map((cap) => {
              const Icon = CAP_ICON[cap];
              const using = choiceOf(state, cap, place);
              const inUse = using?.kind === "key" && using.provider === provider.id;
              return (
                <li key={cap} className="flex flex-wrap items-center gap-3 py-2.5">
                  <Icon className="size-4 shrink-0 text-ink-3" />
                  <button
                    type="button"
                    onClick={() => onOpen({ type: "cap", id: cap })}
                    className="min-w-0 flex-1 text-left"
                  >
                    <span className="block font-medium text-[0.875rem]">
                      {t(`models.cap.${cap}`)}
                    </span>
                    <span className="block truncate text-[0.75rem] text-ink-3">
                      {(provider.models[cap] ?? []).map((m) => m.label).join(" · ")}
                    </span>
                  </button>
                  {inUse ? (
                    <span className="flex items-center gap-1 font-medium text-[0.75rem] text-moss">
                      <Check className="size-3.5" strokeWidth={3} /> {t("models.inUse")}
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={!place.canEdit}
                      busy={save.isPending && save.variables?.bindings !== undefined}
                      onClick={() =>
                        save.mutate({
                          ...(isText(cap) && !place.cloud ? { source: "own" as const } : {}),
                          bindings: providerBindings(provider, cap, state),
                        })
                      }
                    >
                      {t("models.useFor")}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </Part>
        {offers.length ? (
          <Part title={t("models.viaCredits", { name: provider.name })}>
            <Hint>
              {place.credits ? t("models.viaCreditsHint") : t("models.viaCreditsNeedsAccount")}
            </Hint>
            <CreditOffers models={offers} state={state} place={place} />
          </Part>
        ) : null}
      </Card>
    </div>
  );
}

/** An installed AI client: its sign-in, and what it does. */
function ClientPanel({
  me,
  id,
  state,
  place,
}: {
  me: Me;
  id: HarnessId;
  state: ModelsState;
  place: Place;
}) {
  const save = useSave();
  const client = place.harnesses.find((h) => h.id === id);
  if (!client) {
    return null;
  }
  const textHere = state.source === id;
  const ready = client.version !== null && client.auth !== "none";
  return (
    <div className="flex flex-col gap-5">
      <PanelHead
        icon={Laptop}
        title={client.name}
        lead={t(`harness.desc.${id}`)}
        status={<Status text={clientNote(client).note} tone={ready ? "done" : "warn"} />}
      />
      <Card className="flex flex-col gap-6 p-3.5 sm:p-5 sm:p-6">
        <Part title={t("models.clientSignIn")}>
          <HarnessPanel me={me} id={id} />
        </Part>
        <Part title={t("models.uses")}>
          <ul className="flex flex-col divide-y divide-border-soft">
            {(["text", ...(client.images ? ["image" as const] : [])] as ModelCapability[]).map(
              (cap) => {
                const Icon = CAP_ICON[cap];
                const using = choiceOf(state, cap, place);
                const inUse = using?.kind === "client" && using.id === id;
                return (
                  <li key={cap} className="flex items-center gap-3 py-2.5">
                    <Icon className="size-4 shrink-0 text-ink-3" />
                    <span className="min-w-0 flex-1 font-medium text-[0.875rem]">
                      {t(`models.cap.${cap}`)}
                    </span>
                    {inUse ? (
                      <span className="flex items-center gap-1 font-medium text-[0.75rem] text-moss">
                        <Check className="size-3.5" strokeWidth={3} /> {t("models.inUse")}
                      </span>
                    ) : (
                      <Button
                        size="sm"
                        variant="secondary"
                        busy={save.isPending}
                        onClick={() =>
                          save.mutate(
                            cap === "text"
                              ? { source: id, bindings: withoutApple(state.bindings) }
                              : { bindings: { image: `${id}/image` } },
                          )
                        }
                      >
                        {t("models.useFor")}
                      </Button>
                    )}
                  </li>
                );
              },
            )}
          </ul>
          {textHere ? null : <Hint>{t("models.clientNotChosen", { name: client.name })}</Hint>}
        </Part>
      </Card>
    </div>
  );
}

/** The way of the linked account in Settings → Account. */
function AccountLink() {
  return (
    <Link
      to="/settings/account"
      className="font-medium text-ember-strong underline-offset-2 hover:underline"
    >
      {t("local.toAccount")}
    </Link>
  );
}

/** The credits: how much there is, what runs on them, and whether they step in. */
function CreditsPanel({
  state,
  place,
  onOpen,
}: {
  state: ModelsState;
  place: Place;
  onOpen: (target: Target) => void;
}) {
  const save = useSave();
  const onCredits = MODEL_CAPABILITIES.filter(
    (cap) => state.ways[LEAD_CLASS[cap]].kind === "credits",
  );
  const name = place.cloud ? t("models.creditsTeam") : t("models.creditsName");
  return (
    <div className="flex flex-col gap-5">
      <PanelHead
        icon={Coins}
        title={name}
        lead={place.cloud ? t("models.creditsCloudHint") : t("models.creditsLocalLead")}
        status={
          place.balance !== null ? (
            <span className="font-display font-semibold text-[1.25rem] tabular-nums">
              {t("nav.credits", { n: Math.floor(place.balance).toLocaleString(lang) })}
            </span>
          ) : undefined
        }
      />
      <Card className="flex flex-col gap-6 p-3.5 sm:p-5 sm:p-6">
        {!place.cloud && !place.account ? (
          <Part title={t("models.creditsConnectTitle")}>
            <Hint>{t("models.creditsLocalHint")}</Hint>
            <div>
              <Link to="/settings/account">
                <Button>{t("models.creditsConnect")}</Button>
              </Link>
            </div>
          </Part>
        ) : null}
        {place.account && !place.account.signedIn ? (
          <p className="text-[0.8125rem] text-rose">
            {t("local.accountExpired")} <AccountLink />
          </p>
        ) : null}
        {place.account ? (
          <Part title={t("models.creditsFallback")}>
            <div className="flex items-start gap-3">
              <Switch
                checked={state.creditFallback}
                disabled={!place.canEdit}
                onChange={(on) => save.mutate({ creditFallback: on })}
                label={t("models.creditsFallback")}
              />
              <Hint>
                {state.creditFallback
                  ? t("models.creditsFallbackOn")
                  : t("models.creditsFallbackOff")}
              </Hint>
            </div>
          </Part>
        ) : null}
        {place.credits ? (
          <Part
            title={t("models.creditsOn")}
            aside={
              place.topUp ? (
                <a
                  href={place.topUp}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 font-medium text-[0.8125rem] text-ember-strong hover:underline"
                >
                  {t("models.creditsTopUp")} <ExternalLink className="size-3" />
                </a>
              ) : null
            }
          >
            {onCredits.length ? (
              <ul className="flex flex-col divide-y divide-border-soft">
                {onCredits.map((cap) => {
                  const Icon = CAP_ICON[cap];
                  const way = state.ways[LEAD_CLASS[cap]];
                  return (
                    <li key={cap}>
                      <button
                        type="button"
                        onClick={() => onOpen({ type: "cap", id: cap })}
                        className="flex w-full items-center gap-3 py-2.5 text-left"
                      >
                        <Icon className="size-4 shrink-0 text-ink-3" />
                        <span className="min-w-0 flex-1 font-medium text-[0.875rem]">
                          {t(`models.cap.${cap}`)}
                        </span>
                        <span className="truncate text-[0.75rem] text-ink-3">
                          {way.ref ? modelLabel(way.ref) : ""} · {priceNote(cap, state)}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <Hint>{t("models.creditsNone")}</Hint>
            )}
          </Part>
        ) : null}
      </Card>
    </div>
  );
}

// --- the page ----------------------------------------------------------------------

type Target =
  | { type: "cap"; id: ModelCapability }
  | { type: "provider"; id: ProviderId }
  | { type: "client"; id: HarnessId }
  | { type: "credits" };

function targetOf(show: string | null): Target {
  if (!show) {
    return { type: "cap", id: "text" };
  }
  if (show === "credits") {
    return { type: "credits" };
  }
  if ((MODEL_CAPABILITIES as readonly string[]).includes(show)) {
    return { type: "cap", id: show as ModelCapability };
  }
  if (providerInfo(show)) {
    return { type: "provider", id: show as ProviderId };
  }
  return { type: "client", id: show as HarnessId };
}

const showOf = (target: Target) => (target.type === "credits" ? "credits" : target.id);

/** In development the page can be looked at as the local install, with an account, or in the cloud. */
function Preview({ view, onView }: { view: View; onView: (v: View) => void }) {
  if (!import.meta.env.DEV) {
    return null;
  }
  return (
    <div className="mt-5 flex flex-wrap items-center gap-1.5 rounded-lg border border-border-soft border-dashed px-3 py-2 text-[0.75rem] text-ink-3">
      <span className="mr-1">{t("models.viewAs")}</span>
      {(["auto", "local", "linked", "cloud"] as const).map((v) => (
        <button
          key={v}
          type="button"
          aria-pressed={view === v}
          onClick={() => onView(v)}
          className={cn(
            "rounded-full px-2.5 py-0.5 transition",
            view === v ? "bg-ink text-background" : "hover:bg-accent hover:text-ink",
          )}
        >
          {t(`models.view.${v}`)}
        </button>
      ))}
    </div>
  );
}

/** How a capability stands, as the menu's dot. */
function capTone(way: ClassWay): MenuTone {
  return way.kind === "none" ? "off" : way.kind === "credits" ? "credits" : "done";
}

/** What the page shows, for the trail in the top bar. */
function targetLabel(target: Target, me: Me | null | undefined): string {
  switch (target.type) {
    case "cap":
      return t(`models.cap.${target.id}`);
    case "provider":
      return providerInfo(target.id)?.name ?? target.id;
    case "client":
      return me?.harnesses.find((h) => h.id === target.id)?.name ?? target.id;
    default:
      return me?.mode === "managed" ? t("models.creditsTeam") : t("models.creditsName");
  }
}

/**
 * Settings → Models: what the wizards can do (text, images, video, voice, voice notes), and for
 * each who does it — an AI subscription on this machine, an own API key, a local model, or the
 * credits, which step in where nothing of one's own is set up. The menu goes one level down in
 * the settings' left container; this is the page beside it. The same page alone and in the
 * cloud; what differs is decided by `Place`.
 */
export function Models() {
  const me = useMe();
  const models = useModels();
  const [params, setParams] = useSearchParams();
  const [view, setView] = useState<View>("auto");
  const { narrow } = useSettingsMenu();
  const show = params.get("show");
  const target = targetOf(show);
  useDetail(show || !narrow ? targetLabel(target, me.data) : null);
  if (!me.data || !models.data) {
    return models.isError ? (
      <p className="text-[0.875rem] text-rose">{(models.error as Error).message}</p>
    ) : null;
  }
  const state = models.data;
  const place = placeOf(me.data, view);
  const open = (next: Target) => setParams({ show: showOf(next) }, { replace: !narrow });
  // On a phone the menu marks nothing: a row opens the page.
  const isOpen = (next: Target) => Boolean(show || !narrow) && showOf(next) === showOf(target);
  const installed = place.harnesses.filter((h) => h.version !== null || state.source === h.id);
  const keyed = PROVIDERS.filter((p) => state.keys[p.id]);
  const others = PROVIDERS.filter((p) => !state.keys[p.id]);

  return (
    <>
      <SubMenu>
        <MenuGroup label={t("models.groupCaps")}>
          {MODEL_CAPABILITIES.map((cap) => {
            const way = state.ways[LEAD_CLASS[cap]];
            return (
              <MenuRow
                key={cap}
                icon={CAP_ICON[cap]}
                label={t(`models.cap.${cap}`)}
                tone={capTone(way)}
                toneLabel={wayText(way, place).text}
                selected={isOpen({ type: "cap", id: cap })}
                onPick={() => open({ type: "cap", id: cap })}
              />
            );
          })}
        </MenuGroup>
        <MenuGroup label={t("models.groupAccess")}>
          <MenuRow
            icon={Coins}
            label={place.cloud ? t("models.creditsTeam") : t("models.creditsName")}
            badge={
              place.balance !== null ? (
                <span className="text-[0.75rem] text-ink-3 tabular-nums">
                  {Math.floor(place.balance).toLocaleString(lang)}
                </span>
              ) : null
            }
            tone={place.credits ? undefined : "off"}
            toneLabel={place.credits ? undefined : t("models.noteNeedsAccount")}
            selected={isOpen({ type: "credits" })}
            onPick={() => open({ type: "credits" })}
          />
          {installed.map((h) => (
            <MenuRow
              key={h.id}
              icon={Laptop}
              label={h.name}
              tone={
                h.version !== null && h.auth === "subscription"
                  ? "done"
                  : h.auth === "api_key"
                    ? "on"
                    : "off"
              }
              toneLabel={clientNote(h).note}
              selected={isOpen({ type: "client", id: h.id })}
              onPick={() => open({ type: "client", id: h.id })}
            />
          ))}
          {keyed.map((p) => (
            <MenuRow
              key={p.id}
              icon={KeyRound}
              label={p.name}
              tone="done"
              toneLabel={t("models.noteKey")}
              selected={isOpen({ type: "provider", id: p.id })}
              onPick={() => open({ type: "provider", id: p.id })}
            />
          ))}
        </MenuGroup>
        {others.length ? (
          <MenuGroup
            label={t("models.groupMore")}
            collapsible
            open={others.some((p) => isOpen({ type: "provider", id: p.id }))}
            count={others.length}
          >
            {others.map((p) => (
              <MenuRow
                key={p.id}
                icon={KeyRound}
                label={p.name}
                selected={isOpen({ type: "provider", id: p.id })}
                onPick={() => open({ type: "provider", id: p.id })}
              />
            ))}
          </MenuGroup>
        ) : null}
        <Preview view={view} onView={setView} />
      </SubMenu>
      {place.canEdit ? null : (
        <p className="mb-4 rounded-lg bg-paper-2 px-3 py-2 text-[0.8125rem] text-ink-2">
          {t("models.readOnly")}
        </p>
      )}
      {target.type === "cap" ? (
        <CapabilityPanel
          key={target.id}
          cap={target.id}
          state={state}
          place={place}
          me={me.data}
          onOpen={open}
        />
      ) : target.type === "provider" && providerInfo(target.id) ? (
        <ProviderPanel
          key={target.id}
          provider={providerInfo(target.id) as ProviderInfo}
          state={state}
          place={place}
          onOpen={open}
        />
      ) : target.type === "client" ? (
        <ClientPanel key={target.id} me={me.data} id={target.id} state={state} place={place} />
      ) : (
        <CreditsPanel state={state} place={place} onOpen={open} />
      )}
    </>
  );
}
