import { type ModelClass, TEXT_CLASSES, type TextClass } from "@engenty/wizards-shared/definition";
import { featureOn } from "@engenty/wizards-shared/features";
import {
  CAPABILITY_CLASSES,
  CLASS_NEEDS,
  CREDITS,
  type CreditModel,
  capabilityOfKind,
  creditsModelOf,
  creditsRef,
  isCreditsRef,
  MODEL_CAPABILITIES,
  type ModelCapability,
  type ModelNeed,
  type ModelOption,
  modelLabel,
  PROVIDERS,
  type ProviderId,
  type ProviderInfo,
  providerInfo,
  providerOfRef,
  providerText,
} from "@engenty/wizards-shared/providers";
import type { ModelPolicy, ModelTier, TierClass } from "@engenty/wizards-shared/tiers";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  ChartColumn,
  Check,
  CircleAlert,
  Clapperboard,
  Coins,
  Ear,
  ExternalLink,
  EyeOff,
  HardDrive,
  ImageIcon,
  KeyRound,
  Laptop,
  LayoutGrid,
  type LucideIcon,
  MessageCircle,
  PenLine,
  Plug,
  Search,
  ShieldCheck,
  Split,
  TerminalSquare,
  Users,
  Volume2,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { api } from "../lib/api";
import { useFeature } from "../lib/features";
import { lang, t } from "../lib/i18n";
import {
  type ChatWay,
  type HarnessId,
  type HarnessStatus,
  type Me,
  useMe,
  withoutApple,
} from "../lib/session";
import { Button, Card, cn, Input, LinkedText, Select, Spinner, Switch } from "../ui";
import { billingUrl } from "./AppFrame";
import { HarnessPanel } from "./Harness";
import { LocalModels, useLocalModels } from "./LocalModels";
import { openExternal } from "./LocalRuntime";
import {
  AccessList,
  type AccessRow,
  type Helper,
  type Hero,
  HeroCard,
  JobsBox,
  type Job as OverviewJob,
  OverviewSection,
  ScopeCards,
  type ScopeOption,
  type Where,
} from "./ModelsOverview";
import {
  ApprovedPanel,
  AppsPanel,
  appsShort,
  ChoicePanel,
  DEFAULT_POLICY,
  DefaultsPanel,
  MaskingPanel,
  PolicySwitchCard,
  useSavePolicy,
  wayShort,
} from "./ModelsPolicy";
import { TierChooser, TierPanel } from "./ModelsTier";
import { Hint, PanelHead, Part, Status } from "./models-parts";
import {
  MenuGroup,
  MenuRow,
  type MenuTone,
  SubMenu,
  useDetail,
  useSettingsMenu,
} from "./settings-menu";
import { offered, withTierNames } from "./tiers";

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
  /** Each key there is, masked, and the environment variable it came from (null: kept here). */
  keyHints?: Partial<Record<ProviderId, KeyHint>>;
  ways: Record<ModelClass, ClassWay>;
  /** Per text class, what of its minimums (`CLASS_NEEDS`) its model lacks; null: not checked. */
  fit: Record<TextClass, ModelNeed[] | null>;
  /** Apple Intelligence on this Mac: shown where the machine can run it, picked once it answers. */
  apple?: AppleStatus | null;
  prices: Partial<Record<ModelClass, ClassPrice | null>> | null;
  /** The media models the credits pay for, which a binding may name. */
  creditModels: CreditModel[];
  decision: DecisionState;
  embedding: EmbeddingState;
  /** The organization's model tier and its admins' policy; null without one (`modelTiers`). */
  tier?: ModelTier | null;
  modelPolicy?: ModelPolicy | null;
}

interface KeyHint {
  masked: string;
  env: string | null;
}

/** Where a key comes from, in a sentence: an environment variable of this machine, or kept here. */
function keySource(hint: KeyHint | undefined, place: Place): string {
  return hint?.env
    ? t("overview.keys.fromEnv", { env: hint.env })
    : t(place.cloud ? "overview.keys.keptCloud" : "overview.keys.kept");
}

/** The ways to an embedding model, in the order `auto` tries them. */
const EMBEDDING_WAYS = ["gateway", "openai", "local", "credits"] as const;
type EmbeddingWay = (typeof EMBEDDING_WAYS)[number];
type EmbeddingChoice = "auto" | EmbeddingWay | "off";

/** Who embeds knowledge for the search: the choice, which ways have a model, which one embeds now. */
interface EmbeddingState {
  choice: EmbeddingChoice;
  ready: Record<EmbeddingWay, boolean>;
  /** Null: no embedding model, the search finds words only. */
  way: EmbeddingWay | null;
  ref: string | null;
  /** The model asked for in Ollama on this computer. */
  local: string;
}

/** The ways to a decision model, in the order `auto` tries them. */
const DECISION_WAYS = ["gateway", "typesafe", "local", "credits"] as const;
type DecisionWay = (typeof DECISION_WAYS)[number];
type DecisionChoice = "auto" | DecisionWay | "llm";

/** Who answers decisions: the choice, which ways have a decision model, which one answers now. */
interface DecisionState {
  choice: DecisionChoice;
  ready: Record<DecisionWay, boolean>;
  /** Null: no decision model answers, the Classifier language model does. */
  way: DecisionWay | null;
  model: string | null;
  /** The decision model asked for in Ollama on this computer. */
  local: string | null;
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
  decision?: DecisionChoice;
  decisionLocal?: string;
  embedding?: EmbeddingChoice;
  embeddingLocal?: string;
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
 * cloud, for an organization. Everything that differs between them is decided from here, so the page can
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
  /** Own API keys are a feature of the organization's plan; alone they always are. */
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
              organization: null,
              organizationId: "",
              plan: null,
              organizations: [],
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

/** The class a capability is judged by: text by `low`, the others by their one class. */
const LEAD_CLASS: Record<ModelCapability, ModelClass> = {
  text: "low",
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
    if (state.bindings.low?.startsWith("apple:")) {
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
        text: place.cloud ? t("models.way.creditsOrganization") : t("models.way.credits"),
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
    select: withTierNames,
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
  hint,
  place,
}: {
  provider: ProviderInfo;
  stored: boolean;
  hint?: KeyHint;
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
  // Own keys are a feature of the organization's plan: without it, the credits pay and no key is taken.
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
            <KeyRound className="size-4 text-moss" />
            {hint ? <code className="font-mono text-[0.8125rem]">{hint.masked}</code> : null}
            <span className="text-ink-3">{keySource(hint, place)}</span>
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
      <dd className="truncate font-medium">{of("low")}</dd>
      <dt className="text-ink-3">{t("models.textDemanding")}</dt>
      <dd className="truncate font-medium">{of("standard")}</dd>
    </dl>
  );
}

/** A minimum as the settings name it: "tool calls", "128k tokens of context". */
function needText(cls: TextClass, need: ModelNeed): string {
  return need === "context"
    ? t("need.context", { tokens: `${Math.round(CLASS_NEEDS[cls].context / 1000)}k` })
    : t(`need.${need}`);
}

/** What a class asks of its model, and what the model it runs on lacks of it. */
function ClassNeedsNote({ cls, lacks }: { cls: TextClass; lacks: ModelNeed[] | null }) {
  const needs = [...CLASS_NEEDS[cls].needs, "context" as const];
  return (
    <>
      <div className="text-[0.6875rem] text-ink-4 leading-snug">
        {t("class.needs", { needs: needs.map((n) => needText(cls, n)).join(", ") })}
      </div>
      {lacks?.length ? (
        <div className="flex items-start gap-1 text-[0.6875rem] text-amber leading-snug">
          <CircleAlert className="mt-px size-3 shrink-0" />
          {t("class.lacks", { needs: lacks.map((n) => needText(cls, n)).join(", ") })}
        </div>
      ) : null}
    </>
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
            <div className="flex flex-col gap-0.5 sm:col-start-2">
              <ClassNeedsNote cls={cls} lacks={state.fit[cls]} />
            </div>
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
                title={place.cloud ? t("models.creditsOrganization") : t("models.creditsName")}
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
            <OllamaPart state={state} disabled={!place.canEdit} onOpen={onOpen} />
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
    low: "apple:default",
    standard: keep("standard"),
    high: keep("high"),
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
          ? t("models.appleHint", { way: wayText(state.ways.standard, place).text })
          : t("models.appleListenHint")}
      </Hint>
    </Part>
  );
}

function OllamaPart({
  state,
  disabled,
  onOpen,
}: {
  state: ModelsState;
  disabled?: boolean;
  onOpen: (target: Target) => void;
}) {
  const save = useSave();
  return (
    <Part
      title={t("models.optLocal")}
      aside={
        <Button variant="secondary" size="sm" onClick={() => onOpen({ type: "local" })}>
          {t("models.ollamaOpen")}
          <ArrowRight className="size-4" />
        </Button>
      }
    >
      <Hint>{t("models.ollamaHint")}</Hint>
      <LocalModels
        job="text"
        inUse={[(state.bindings.low ?? "").replace(/^ollama:/, "")]}
        disabled={disabled}
        onChoose={(model) =>
          save.mutate({
            bindings: Object.fromEntries(TEXT_CLASSES.map((c) => [c, `ollama:${model}`])),
          })
        }
      />
      {save.isError ? (
        <p className="text-[0.8125rem] text-rose">{(save.error as Error).message}</p>
      ) : null}
    </Part>
  );
}

/** The models the studio asks Ollama for now: text, search and decisions. */
function ollamaInUse(state: ModelsState): string[] {
  const text = Object.values(state.bindings)
    .filter((ref): ref is string => Boolean(ref?.startsWith("ollama:")))
    .map((ref) => ref.slice("ollama:".length));
  return [...text, state.embedding.local, ...(state.decision.local ? [state.decision.local] : [])];
}

/**
 * Ollama on this computer as a way of its own: whether it runs, its address, and every model
 * it holds with the jobs each serves — to download more or remove one. Each job picks its
 * model on its own page.
 */
function OllamaAccessPanel({ state, place }: { state: ModelsState; place: Place }) {
  const save = useSave();
  const qc = useQueryClient();
  const { data: local } = useLocalModels();
  const [url, setUrl] = useState(state.ollamaUrl);
  const version = local?.ollama.version;
  return (
    <div className="flex flex-col gap-5">
      <PanelHead
        icon={HardDrive}
        title="Ollama"
        lead={t("models.ollamaLead")}
        status={
          local ? (
            <Status
              text={
                version
                  ? t("models.ollamaRuns", { version })
                  : local.ollama.installed
                    ? t("models.ollamaStoppedShort")
                    : t("models.ollamaMissingShort")
              }
              tone={version ? "done" : "warn"}
            />
          ) : null
        }
      />
      <Card className="flex flex-col gap-6 p-3.5 sm:p-5 sm:p-6">
        <Part title={t("models.ollamaModels")}>
          <Hint>{t("models.ollamaModelsHint")}</Hint>
          <LocalModels inUse={ollamaInUse(state)} disabled={!place.canEdit} />
        </Part>
        <Part title={t("models.ollamaAddress")}>
          <Hint>{t("models.ollamaAddressHint")}</Hint>
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
            <Input
              className="font-mono text-[0.8125rem]"
              value={url}
              disabled={!place.canEdit}
              onChange={(e) => setUrl(e.target.value)}
            />
            <Button
              variant="secondary"
              busy={save.isPending}
              disabled={!place.canEdit || !url.trim() || url.trim() === state.ollamaUrl}
              onClick={() =>
                save.mutate(
                  { ollamaUrl: url },
                  { onSuccess: () => qc.invalidateQueries({ queryKey: ["models", "local"] }) },
                )
              }
            >
              {t("settings.save")}
            </Button>
          </div>
          {save.isError ? (
            <p className="text-[0.8125rem] text-rose">{(save.error as Error).message}</p>
          ) : null}
        </Part>
      </Card>
    </div>
  );
}

/** The ways a studio chat can take, by the kind the panel groups them in. */
const CHAT_CLIENTS = ["claude", "codex", "cursor"] as const;
const CHAT_KEYS = ["openai", "anthropic", "google", "gateway"] as const;

/** The name of a chat way, as the menu and the panel's status say it. */
function chatWayName(way: ChatWay, me: Me, place: Place): string {
  if (way === "models") {
    return t("models.chatModels");
  }
  if (way === "account") {
    return place.cloud ? t("models.creditsOrganization") : t("models.creditsName");
  }
  return me.harnesses.find((h) => h.id === way)?.name ?? providerInfo(way)?.name ?? (way as string);
}

/**
 * The studio's chats, Goose and the editor's chat: they follow Text & reasoning, or run on a
 * subscription (the client works through engenty wizards' tools), a key or the credits.
 */
function ChatPanel({
  me,
  state,
  place,
  onOpen,
}: {
  me: Me;
  state: ModelsState;
  place: Place;
  onOpen: (target: Target) => void;
}) {
  const qc = useQueryClient();
  const chat = useMutation({
    mutationFn: (engine: ChatWay) => api.put("/api/studio/local/chat", { engine }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }),
  });
  const [needsAccount, setNeedsAccount] = useState(false);
  const ready = (way: ChatWay) => me.chatWays.includes(way);
  const pick = (way: ChatWay) => {
    setNeedsAccount(false);
    if (way === "account" && !ready(way)) {
      setNeedsAccount(true);
      return;
    }
    if (CHAT_KEYS.includes(way as (typeof CHAT_KEYS)[number]) && !ready(way)) {
      // The key comes first: its page takes it.
      onOpen({ type: "provider", id: way as ProviderId });
      return;
    }
    chat.mutate(way);
  };
  const clients = place.harnesses.filter(
    (h) => CHAT_CLIENTS.includes(h.id as (typeof CHAT_CLIENTS)[number]) && h.version !== null,
  );
  const option = (way: ChatWay, title: string, note: string, done: boolean, disabled = false) => (
    <Option
      key={way}
      title={title}
      note={note}
      noteTone={done ? "done" : undefined}
      selected={me.chatEngine === way}
      disabled={!place.canEdit || disabled}
      onPick={() => pick(way)}
    />
  );
  return (
    <div className="flex flex-col gap-5">
      <PanelHead
        icon={MessageCircle}
        title={t("models.cap.chat")}
        lead={t("models.cap.chat.hint")}
        status={
          <Status
            text={chatWayName(me.chatEngine, me, place)}
            tone={ready(me.chatEngine) ? "done" : "warn"}
          />
        }
      />
      <Card className="flex flex-col gap-6 p-3.5 sm:p-5 sm:p-6">
        {place.cloud ? (
          // The cloud runs the studio's chats on credits, with models engenty picks: nothing to choose.
          <Part title={t("models.who")}>
            <OptionGroup label={t("models.optOther")}>
              <Option
                title={t("models.creditsOrganization")}
                note={t("models.chatCloudHint")}
                noteTone="done"
                selected
                disabled
                onPick={() => undefined}
              />
            </OptionGroup>
            <Hint>{t("models.chatCloudHint")}</Hint>
          </Part>
        ) : (
          <Part title={t("models.who")}>
            <div className="flex flex-col gap-3">
              {clients.length ? (
                <OptionGroup label={t("models.optSubscription")}>
                  {clients.map((h) =>
                    option(
                      h.id as ChatWay,
                      h.name,
                      clientNote(h).note,
                      ready(h.id as ChatWay),
                      !ready(h.id as ChatWay),
                    ),
                  )}
                </OptionGroup>
              ) : null}
              <OptionGroup label={t("models.optKey")}>
                {CHAT_KEYS.map((id) =>
                  option(
                    id,
                    providerInfo(id)?.name ?? id,
                    state.keys[id] ? t("models.noteKey") : t("models.noteNoKey"),
                    Boolean(state.keys[id]),
                  ),
                )}
              </OptionGroup>
              <OptionGroup label={t("models.optOther")}>
                {option(
                  "account",
                  chatWayName("account", me, place),
                  ready("account") ? t("models.noteUsage") : t("models.noteNeedsAccount"),
                  ready("account"),
                )}
              </OptionGroup>
            </div>
            {needsAccount ? (
              <p className="text-[0.8125rem] text-ink-2">
                {t("local.sourceNeedsAccount")} <AccountLink />
              </p>
            ) : null}
            {chat.isError ? (
              <p className="text-[0.8125rem] text-rose">{(chat.error as Error).message}</p>
            ) : null}
            <Hint>{t("models.chatHint")}</Hint>
          </Part>
        )}
        {place.cloud ? null : <ChatModels me={me} way={me.chatEngine} disabled={!place.canEdit} />}
      </Card>
    </div>
  );
}

/** The models of a chat way: the one for everyday work and the one extra effort switches to. */
function ChatModels({ me, way, disabled }: { me: Me; way: ChatWay; disabled: boolean }) {
  const qc = useQueryClient();
  const listed = me.chatModels.ways[way];
  const chosen = me.chatModels.chosen[way] ?? {};
  const save = useMutation({
    mutationFn: (change: { normal?: string | null; extra?: string | null }) =>
      api.put("/api/studio/local/chat-models", { way, ...change }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }),
  });
  // Credits: engenty picks the models, there is nothing to choose.
  if (!listed) {
    return null;
  }
  const row = (effort: "normal" | "extra", title: string, hint?: string) => (
    <ChatModelRow
      key={`${way}-${effort}-${chosen[effort] ?? ""}`}
      title={title}
      hint={hint}
      listed={listed.models}
      latest={listed[effort]}
      value={chosen[effort] ?? ""}
      disabled={disabled || save.isPending}
      onPick={(id) => save.mutate({ [effort]: id || null })}
    />
  );
  return (
    <Part title={t("models.chatModelsTitle")}>
      <div className="flex flex-col gap-3">
        {row("normal", t("models.chatModelNormal"), t("models.chatModelNormalHint"))}
        {row("extra", t("composer.extra"), t("composer.extraHint"))}
      </div>
      {save.isError ? (
        <p className="text-[0.8125rem] text-rose">{(save.error as Error).message}</p>
      ) : null}
    </Part>
  );
}

function ChatModelRow({
  title,
  hint,
  listed,
  latest,
  value,
  disabled,
  onPick,
}: {
  title: string;
  hint?: string;
  listed: { id: string; label: string }[];
  latest: string;
  value: string;
  disabled: boolean;
  onPick: (id: string) => void;
}) {
  const label = (id: string) =>
    listed.find((m) => m.id === id)?.label ?? id.replace(/^[a-z]+:/, "");
  const known = value === "" || listed.some((m) => m.id === value);
  const [custom, setCustom] = useState(!known);
  const [draft, setDraft] = useState(known ? "" : value);
  return (
    <div className="grid items-start gap-x-4 gap-y-1.5 sm:grid-cols-[10rem_minmax(0,1fr)]">
      <div className="pt-2">
        <div className="text-[0.875rem]">{title}</div>
        {hint ? <div className="text-[0.75rem] text-ink-3">{hint}</div> : null}
      </div>
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
            { value: "", label: t("models.latest", { model: label(latest) }) },
            ...listed.map((m) => ({ value: m.id, label: m.label })),
            { value: CUSTOM, label: t("models.modelCustom") },
          ]}
        />
        {custom ? (
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="min-w-0 flex-1 font-mono text-[0.8125rem]"
              value={draft}
              disabled={disabled}
              placeholder={latest}
              onChange={(e) => setDraft(e.target.value)}
            />
            <Button
              variant="secondary"
              disabled={!draft.trim() || disabled}
              onClick={() => onPick(draft.trim())}
            >
              {t("settings.save")}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
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
          <KeyField
            provider={provider}
            stored={stored}
            hint={state.keyHints?.[provider.id]}
            place={place}
          />
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
  const name = place.cloud ? t("models.creditsOrganization") : t("models.creditsName");
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

/** The decision model a way reaches, by name. */
function decisionName(way: DecisionWay, place: Place): string {
  switch (way) {
    case "gateway":
      return `Jev · ${providerInfo("gateway")?.name ?? "Vercel AI Gateway"}`;
    case "typesafe":
      return "Jev · TypeSafe";
    case "local":
      return `Clef-flash · ${t("models.way.local")}`;
    default:
      return `Jev · ${place.cloud ? t("models.creditsOrganization") : t("models.creditsName")}`;
  }
}

/** How decisions are answered now, in a few words: the menu's note and the panel's status. */
function decisionText(
  state: ModelsState,
  place: Place,
): { text: string; tone: "done" | "ok" | "warn" } {
  const { way } = state.decision;
  if (way) {
    return {
      text: decisionName(way, place).split(" · ")[0],
      tone: way === "credits" ? "ok" : "done",
    };
  }
  return state.ways.classifier.kind === "none"
    ? { text: t("models.way.none"), tone: "warn" }
    : { text: t("models.decisionByLlm"), tone: "done" };
}

/**
 * Decisions: a decision model (Jev, Clef-flash) answers typed questions with probabilities.
 * Where none is at hand, the Classifier language model answers the same questions.
 */
function DecisionPanel({
  state,
  place,
  onOpen,
}: {
  state: ModelsState;
  place: Place;
  onOpen: (target: Target) => void;
}) {
  const save = useSave();
  const [needsAccount, setNeedsAccount] = useState(false);
  const { choice, ready } = state.decision;
  const status = decisionText(state, place);
  const pick = (next: DecisionChoice) => {
    setNeedsAccount(false);
    if (next === "gateway" && !ready.gateway) {
      // The key comes first: its page takes it.
      onOpen({ type: "provider", id: "gateway" });
      return;
    }
    if (next === "credits" && !ready.credits) {
      setNeedsAccount(true);
      return;
    }
    save.mutate({ decision: next });
  };
  const notes: Record<DecisionWay, string> = {
    gateway: ready.gateway ? t("models.noteKey") : t("models.noteNoKey"),
    typesafe: ready.typesafe ? t("models.noteShellKey") : t("models.decisionNoTypesafeKey"),
    local: ready.local ? t("models.decisionLocalReady") : t("models.decisionLocalMissing"),
    credits: ready.credits ? t("models.noteUsage") : t("models.noteNeedsAccount"),
  };
  const fallback = state.ways.classifier;
  return (
    <div className="flex flex-col gap-5">
      <PanelHead
        icon={Split}
        title={t("models.cap.decision")}
        lead={t("models.cap.decision.hint")}
        status={<Status text={status.text} tone={status.tone} />}
      />
      <Card className="flex flex-col gap-6 p-3.5 sm:p-5 sm:p-6">
        <Part title={t("models.who")}>
          {place.cloud ? (
            <>
              <OptionGroup label={t("models.decisionModelGroup")}>
                <Option
                  title={decisionName("credits", place)}
                  note={t("models.decisionCloudHint")}
                  noteTone="done"
                  selected
                  disabled
                  onPick={() => undefined}
                />
              </OptionGroup>
              <Hint>{t("models.decisionCloudHint")}</Hint>
            </>
          ) : (
            <>
              <div className="flex flex-col gap-3">
                <OptionGroup label={t("models.decisionModelGroup")}>
                  <Option
                    title={t("models.decisionAuto")}
                    note={t("models.decisionAutoNote")}
                    noteTone={DECISION_WAYS.some((w) => ready[w]) ? "done" : undefined}
                    selected={choice === "auto"}
                    disabled={!place.canEdit}
                    onPick={() => pick("auto")}
                  />
                  {DECISION_WAYS.map((way) => (
                    <Option
                      key={way}
                      title={decisionName(way, place)}
                      note={notes[way]}
                      noteTone={ready[way] ? "done" : undefined}
                      selected={choice === way}
                      disabled={!place.canEdit}
                      onPick={() => pick(way)}
                    />
                  ))}
                </OptionGroup>
                <OptionGroup label={t("models.optOther")}>
                  <Option
                    title={t("models.decisionLlm")}
                    note={t("models.decisionLlmNote")}
                    noteTone={fallback.kind === "none" ? undefined : "done"}
                    selected={choice === "llm"}
                    disabled={!place.canEdit}
                    onPick={() => pick("llm")}
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
              <Hint>{t("models.decisionHint")}</Hint>
            </>
          )}
        </Part>
        {place.cloud ? null : (
          <Part title={t("models.optLocal")}>
            <Hint>{t("models.decisionLocalHint")}</Hint>
            <LocalModels
              job="decision"
              inUse={state.decision.local ? [state.decision.local] : []}
              disabled={!place.canEdit}
              onChoose={(model) => save.mutate({ decisionLocal: model })}
            />
          </Part>
        )}
        <Part title={t("models.decisionFallback")} aside={<Status {...wayText(fallback, place)} />}>
          <Hint>{t("models.decisionFallbackHint")}</Hint>
          {fallback.kind === "none" ? (
            <p className="text-[0.8125rem] text-ink-2">{t("models.decisionFallbackNone")}</p>
          ) : null}
          <div>
            <Button variant="secondary" onClick={() => onOpen({ type: "cap", id: "text" })}>
              {t("models.decisionOpenText")}
              <ArrowRight className="size-4" />
            </Button>
          </div>
        </Part>
      </Card>
    </div>
  );
}

/** The embedding model a way reaches, by the way's name. */
function embeddingName(way: EmbeddingWay, state: ModelsState, place: Place): string {
  switch (way) {
    case "gateway":
    case "openai":
      return providerInfo(way)?.name ?? way;
    case "local":
      return `${state.embedding.local} · ${t("models.way.local")}`;
    default:
      return place.cloud ? t("models.creditsOrganization") : t("models.creditsName");
  }
}

/** How the search embeds now, in a few words: the menu's note and the panel's status. */
function embeddingText(
  state: ModelsState,
  place: Place,
): { text: string; tone: "done" | "ok" | "warn" } {
  const { way } = state.embedding;
  if (!way) {
    return { text: t("models.searchWordsOnly"), tone: "warn" };
  }
  if (way === "local") {
    return { text: state.embedding.local, tone: "done" };
  }
  return { text: embeddingName(way, state, place), tone: way === "credits" ? "ok" : "done" };
}

/**
 * The search of a space's knowledge: an embedding model turns every passage into a vector, so a
 * step finds what means the same in other words. Without one the search finds words only.
 */
function SearchPanel({
  state,
  place,
  onOpen,
}: {
  state: ModelsState;
  place: Place;
  onOpen: (target: Target) => void;
}) {
  const save = useSave();
  const [needsAccount, setNeedsAccount] = useState(false);
  const { choice, ready } = state.embedding;
  const status = embeddingText(state, place);
  const pick = (next: EmbeddingChoice) => {
    setNeedsAccount(false);
    if ((next === "gateway" || next === "openai") && !ready[next]) {
      // The key comes first: its page takes it.
      onOpen({ type: "provider", id: next });
      return;
    }
    if (next === "credits" && !ready.credits) {
      setNeedsAccount(true);
      return;
    }
    save.mutate({ embedding: next });
  };
  const notes: Record<EmbeddingWay, string> = {
    gateway: ready.gateway ? t("models.noteKey") : t("models.noteNoKey"),
    openai: ready.openai ? t("models.noteKey") : t("models.noteNoKey"),
    local: ready.local ? t("models.decisionLocalReady") : t("models.decisionLocalMissing"),
    credits: ready.credits ? t("models.noteUsage") : t("models.noteNeedsAccount"),
  };
  return (
    <div className="flex flex-col gap-5">
      <PanelHead
        icon={Search}
        title={t("models.cap.search")}
        lead={t("models.cap.search.hint")}
        status={<Status text={status.text} tone={status.tone} />}
      />
      <Card className="flex flex-col gap-6 p-3.5 sm:p-5 sm:p-6">
        <Part title={t("models.who")}>
          {place.cloud ? (
            <>
              <OptionGroup label={t("models.searchModelGroup")}>
                <Option
                  title={embeddingName("credits", state, place)}
                  note={t("models.searchCloudHint")}
                  noteTone="done"
                  selected
                  disabled
                  onPick={() => undefined}
                />
              </OptionGroup>
              <Hint>{t("models.searchCloudHint")}</Hint>
            </>
          ) : (
            <>
              <div className="flex flex-col gap-3">
                <OptionGroup label={t("models.searchModelGroup")}>
                  <Option
                    title={t("models.decisionAuto")}
                    note={t("models.decisionAutoNote")}
                    noteTone={EMBEDDING_WAYS.some((w) => ready[w]) ? "done" : undefined}
                    selected={choice === "auto"}
                    disabled={!place.canEdit}
                    onPick={() => pick("auto")}
                  />
                  {EMBEDDING_WAYS.map((way) => (
                    <Option
                      key={way}
                      title={embeddingName(way, state, place)}
                      note={notes[way]}
                      noteTone={ready[way] ? "done" : undefined}
                      selected={choice === way}
                      disabled={!place.canEdit}
                      onPick={() => pick(way)}
                    />
                  ))}
                </OptionGroup>
                <OptionGroup label={t("models.optOther")}>
                  <Option
                    title={t("models.searchOff")}
                    note={t("models.searchOffNote")}
                    noteTone="done"
                    selected={choice === "off"}
                    disabled={!place.canEdit}
                    onPick={() => pick("off")}
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
              <Hint>{t("models.searchHint")}</Hint>
            </>
          )}
        </Part>
        {place.cloud ? null : (
          <Part title={t("models.optLocal")}>
            <Hint>
              {ready.local
                ? t("models.searchLocalReady", { model: state.embedding.local })
                : t("models.searchLocalHint", { model: state.embedding.local })}
            </Hint>
            <LocalModels
              job="search"
              inUse={[state.embedding.local]}
              disabled={!place.canEdit}
              onChoose={(model) => save.mutate({ embeddingLocal: model })}
            />
          </Part>
        )}
        <Part
          title={t("models.searchFallback")}
          aside={
            state.embedding.way ? null : <Status text={t("models.searchWordsOnly")} tone="warn" />
          }
        >
          <Hint>{t("models.searchFallbackHint")}</Hint>
          <Hint>{t("models.searchReindexHint")}</Hint>
        </Part>
      </Card>
    </div>
  );
}

// --- the page ----------------------------------------------------------------------

type Target =
  | { type: "overview" }
  | { type: "chat" }
  | { type: "cap"; id: ModelCapability }
  | { type: "credits" }
  | { type: "subs" }
  | { type: "local" }
  | { type: "keys" }
  | { type: "masking" }
  | { type: "scope" }
  | { type: "choice" }
  | { type: "apps" }
  | { type: "provider"; id: ProviderId }
  | { type: "client"; id: HarnessId };

const PAGES = [
  "chat",
  "credits",
  "subs",
  "local",
  "keys",
  "masking",
  "scope",
  "choice",
  "apps",
] as const;
const HARNESS_IDS: readonly string[] = ["claude", "codex", "antigravity", "cursor"];

function targetOf(show: string | null): Target {
  if (!show) {
    return { type: "overview" };
  }
  if ((PAGES as readonly string[]).includes(show)) {
    return { type: show as (typeof PAGES)[number] };
  }
  // Decisions and the knowledge search are part of Text & reasoning; Ollama of Local models.
  if (show === "decision" || show === "search") {
    return { type: "cap", id: "text" };
  }
  if (show === "ollama") {
    return { type: "local" };
  }
  if ((MODEL_CAPABILITIES as readonly string[]).includes(show)) {
    return { type: "cap", id: show as ModelCapability };
  }
  if (providerInfo(show)) {
    return { type: "provider", id: show as ProviderId };
  }
  return HARNESS_IDS.includes(show)
    ? { type: "client", id: show as HarnessId }
    : { type: "overview" };
}

const showOf = (target: Target): string | null =>
  target.type === "overview"
    ? null
    : target.type === "cap" || target.type === "provider" || target.type === "client"
      ? target.id
      : target.type;

/** The jobs of the menu and the overview: images and video are one, voice and voice notes too. */
type Job = "text" | "media" | "voice";
const JOB_CAPS: Record<Job, ModelCapability[]> = {
  text: ["text"],
  media: ["image", "video"],
  voice: ["speech", "listening"],
};
const JOB_CLASSES: Record<Job, ModelClass[]> = {
  text: ["standard"],
  media: ["image", "video"],
  voice: ["speech", "audio"],
};
const jobOf = (cap: ModelCapability): Job =>
  cap === "text" ? "text" : cap === "image" || cap === "video" ? "media" : "voice";

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

/** What the page shows, for the trail in the top bar. */
function targetLabel(target: Target, me: Me | null | undefined): string {
  switch (target.type) {
    case "overview":
      return t("overview.nav");
    case "chat":
      return t("models.cap.chat");
    case "cap":
      return t(`overview.job.${jobOf(target.id)}`);
    case "subs":
      return t("overview.menu.subs");
    case "local":
      return t("overview.menu.local");
    case "keys":
      return t("overview.menu.keys");
    case "masking":
      return t("overview.menu.masking");
    case "scope":
      return t("overview.scope");
    case "choice":
      return t("policy.way");
    case "apps":
      return t("policy.apps");
    case "provider":
      return providerInfo(target.id)?.name ?? target.id;
    case "client":
      return me?.harnesses.find((h) => h.id === target.id)?.name ?? target.id;
    default:
      return me?.mode === "managed" ? t("models.creditsOrganization") : t("models.creditsName");
  }
}

/** Where a way runs: a client or a local model on this computer, the rest in the cloud. */
function whereOf(kind: ClassWay["kind"] | "pc" | "cloud", place: Place): Where {
  if (place.cloud) {
    return "cloud";
  }
  return kind === "client" || kind === "local" || kind === "pc" ? "pc" : "cloud";
}

/** The model a job runs on, as a row shows it: the tier's, the bound one, or Auto. */
function modelText(way: ClassWay, tierClass: TierClass | undefined): string {
  if (tierClass && offered(tierClass)) {
    return tierClass.name;
  }
  if (way.kind === "credits" || !way.ref) {
    return way.ref && !isCreditsRef(way.ref) ? modelLabel(way.ref) : t("chooser.auto");
  }
  // An AI client's model by its family: "claude/opus" → "Opus".
  if (way.kind === "client") {
    const family = way.ref.split("/")[1] ?? way.ref;
    return family.charAt(0).toUpperCase() + family.slice(1);
  }
  return modelLabel(way.ref);
}

/** Who answers decisions, by the access it goes through: "Ollama", "Guthaben", a provider. */
function decisionAccess(state: ModelsState, place: Place): { name: string; where: Where } | null {
  const { way } = state.decision;
  if (!way) {
    return null;
  }
  return way === "local"
    ? { name: "Ollama", where: whereOf("pc", place) }
    : way === "credits"
      ? { name: t("models.creditsName"), where: "cloud" }
      : { name: decisionName(way, place).split(" · ").pop() ?? way, where: "cloud" };
}

/** Who embeds knowledge for the search, by the access it goes through. */
function embeddingAccess(state: ModelsState, place: Place): { name: string; where: Where } | null {
  const { way } = state.embedding;
  if (!way) {
    return null;
  }
  return way === "local"
    ? { name: "Ollama", where: whereOf("pc", place) }
    : way === "credits"
      ? { name: t("models.creditsName"), where: "cloud" }
      : { name: providerInfo(way)?.name ?? way, where: "cloud" };
}

const credits = (n: number) => t("nav.credits", { n: Math.floor(n).toLocaleString(lang) });

/** The organization's plan as the page tells Pro and Team apart; null alone or on Free. */
function planOf(me: Me): "pro" | "team" | null {
  const id = me.tenant.plan?.id ?? "";
  return id.startsWith("team") ? "team" : id.startsWith("pro") ? "pro" : null;
}

interface Situation {
  me: Me;
  state: ModelsState;
  place: Place;
  tier: ModelTier | null;
  policy: ModelPolicy;
  /** The organization's admins, in the cloud, on a tier: its scope, its choice and its switches. */
  admin: boolean;
  /** Ollama on this computer; null in the cloud. */
  ollama: { running: boolean; models: string[] } | null;
  open: (target: Target) => void;
  savePolicy: (policy: ModelPolicy) => void;
}

/** What a tier promises, in a line; empty for a tier the studio has no words for. */
function scopeDesc(id: string): string {
  return id === "general" || id === "eu-private" || id === "eu-sovereign"
    ? t(`overview.scope.${id}`)
    : "";
}

/** A job of the overview: how it stands, through which access, on which model. */
function jobRow(job: Job, s: Situation): OverviewJob {
  const { state, place, tier } = s;
  const classes = JOB_CLASSES[job];
  const base = {
    id: job,
    name: t(`overview.job.${job}`),
    purpose: t(`overview.purpose.${job}`),
    onOpen: () => s.open({ type: "cap", id: JOB_CAPS[job][0] }),
  };
  if (tier && classes.every((c) => !offered(tier.classes[c]))) {
    return {
      ...base,
      state: "na",
      where: null,
      access: "",
      model: "",
      naText: t("policy.notIn", { tier: tier.name }),
    };
  }
  if (classes.some((c) => state.ways[c].kind === "none")) {
    return { ...base, state: "miss", where: null, access: "", model: "" };
  }
  const way = state.ways[classes[0]];
  return {
    ...base,
    state: "ok",
    where: whereOf(way.kind, place),
    access: way.kind === "credits" ? t("overview.credits") : wayText(way, place).text,
    model: modelText(way, tier?.classes[classes[0]]),
  };
}

/** The studio chat (Goose) as a row of the overview. */
function chatRow(s: Situation): OverviewJob {
  const { me, place, tier } = s;
  const engine = me.chatEngine;
  const listed = me.chatModels.ways[engine];
  const picked = me.chatModels.chosen[engine]?.normal ?? listed?.normal;
  const text = jobRow("text", s);
  return {
    id: "chat",
    name: t("models.cap.chat"),
    purpose: t("overview.purpose.chat"),
    onOpen: () => s.open({ type: "chat" }),
    state: me.chatWays.includes(engine) ? "ok" : "miss",
    where:
      engine === "models"
        ? text.where
        : whereOf(HARNESS_IDS.includes(engine) ? "pc" : "cloud", place),
    access:
      place.cloud || engine === "account"
        ? t("overview.credits")
        : engine === "models"
          ? text.access
          : chatWayName(engine, me, place),
    model:
      engine === "models"
        ? text.model
        : listed
          ? (listed.models.find((m) => m.id === picked)?.label ?? picked ?? "")
          : tier && offered(tier.classes.standard)
            ? tier.classes.standard.name
            : t("chooser.auto"),
  };
}

/** "Läuft mit": the access most of the work runs on, and who helps it. */
function heroOf(s: Situation, jobs: OverviewJob[]): Hero {
  const { me, state, place, tier, policy } = s;
  const missing = jobs.filter((j) => j.state === "miss").length;
  if (place.cloud) {
    const strict = Boolean(tier && (tier.rules.regions || tier.rules.zdr || tier.rules.noTraining));
    return {
      name:
        planOf(me) === "team" && me.tenant.name
          ? t("overview.hero.orgCredits", { organization: me.tenant.name })
          : t("models.creditsName"),
      sub:
        tier && strict
          ? t("overview.hero.cloudStrict", { tier: tier.name })
          : t("overview.hero.cloudAll"),
      plan: me.tenant.plan?.name ?? null,
      where: "cloud",
      missing,
      helpers:
        tier && policy.masking
          ? [{ name: t("overview.menu.masking"), jobs: t("overview.maskingJobs"), where: null }]
          : [],
    };
  }
  const way = state.ways.standard;
  const main = way.kind === "none" ? null : wayText(way, place).text;
  const client = way.kind === "client" ? place.harnesses.find((h) => h.id === way.by) : null;
  const helpers = new Map<string, Helper>();
  const help = (name: string, job: string, where: Where) => {
    if (name === main) {
      return;
    }
    const known = helpers.get(name);
    helpers.set(name, { name, where, jobs: known ? `${known.jobs}, ${job}` : job });
  };
  const decision = decisionAccess(state, place);
  if (decision) {
    help(decision.name, t("models.cap.decision"), decision.where);
  }
  const embedding = embeddingAccess(state, place);
  if (embedding) {
    help(embedding.name, t("overview.knowledge"), embedding.where);
  }
  for (const job of jobs.filter((j) => j.id === "media" || j.id === "voice")) {
    if (job.state === "ok") {
      help(job.access, job.name, job.where);
    }
  }
  return {
    name: main ?? t("overview.hero.none"),
    sub: client
      ? t("overview.hero.client", { sub: t(`harness.sub.${client.id}`) })
      : way.kind === "key"
        ? t("overview.hero.key")
        : way.kind === "local"
          ? t("overview.hero.local")
          : way.kind === "credits"
            ? t("overview.hero.credits")
            : t("overview.hero.noneSub"),
    where: way.kind === "client" || way.kind === "local" || way.kind === "none" ? "pc" : "cloud",
    missing,
    helpers: [...helpers.values()],
  };
}

/** "Zugänge": what the page's person can use, or what the organization's admins allow. */
function accessRows(s: Situation, save: ReturnType<typeof useSave>): AccessRow[] {
  const { me, state, place, tier, policy, admin, ollama, open } = s;
  const keyed = PROVIDERS.filter((p) => state.keys[p.id]);
  const rows: AccessRow[] = [];
  const organization = me.tenant.name ?? t("policy.yourOrganization");
  if (place.cloud) {
    rows.push({
      kind: "row",
      id: "credits",
      name: t("overview.credits"),
      desc:
        planOf(me) === "team"
          ? t("overview.credits.team", { organization, n: credits(place.balance ?? 0) })
          : t("overview.credits.plan", {
              plan: me.tenant.plan?.name ?? "",
              n: credits(place.balance ?? 0),
            }),
      button: place.topUp
        ? { label: t("overview.topUp"), onClick: () => openExternal(place.topUp as string) }
        : null,
      onOpen: () => open({ type: "credits" }),
    });
    if (!place.ownKeys) {
      rows.push({
        kind: "row",
        id: "keys",
        name: t("policy.ownKeys"),
        desc: t("overview.keys.plan"),
        status: t("overview.fromPro"),
        muted: true,
      });
    }
    if (!tier) {
      return rows;
    }
    if (!admin) {
      return [
        ...rows,
        {
          kind: "row",
          id: "scope",
          name: t("overview.scope"),
          desc: scopeDesc(tier.id),
          value: tier.name,
          onOpen: () => open({ type: "scope" }),
        },
      ];
    }
    const strict = Boolean(tier.rules.regions || tier.rules.zdr || tier.rules.noTraining);
    const savePolicy = (patch: Partial<ModelPolicy>) => s.savePolicy({ ...policy, ...patch });
    rows.push(
      ...(place.ownKeys
        ? [
            {
              kind: "row" as const,
              id: "keys",
              name: t("policy.ownKeys"),
              desc: t("overview.keys.admin"),
              note: strict && policy.ownKeys ? t("policy.ownKeys.warn", { tier: tier.name }) : null,
              toggle: {
                on: policy.ownKeys,
                onChange: (ownKeys: boolean) => savePolicy({ ownKeys }),
              },
              onOpen: () => open({ type: "keys" }),
            },
          ]
        : []),
      {
        kind: "row",
        id: "subs",
        name: t("overview.subs"),
        desc: t("overview.subs.desc"),
        note: strict && policy.subscriptions ? t("policy.subscriptions.warn") : null,
        toggle: {
          on: policy.subscriptions,
          onChange: (subscriptions) => savePolicy({ subscriptions }),
        },
        onOpen: () => open({ type: "subs" }),
      },
      {
        kind: "row",
        id: "local",
        name: t("overview.localModels"),
        desc: t("overview.localModels.desc"),
        toggle: { on: policy.localModels, onChange: (localModels) => savePolicy({ localModels }) },
        onOpen: () => open({ type: "local" }),
      },
      {
        kind: "row",
        id: "masking",
        name: t("policy.masking"),
        desc: policy.maskLabels.length
          ? t("overview.masking.descLabels", { labels: policy.maskLabels.join(", ") })
          : t("overview.masking.desc"),
        toggle: { on: policy.masking, onChange: (masking) => savePolicy({ masking }) },
        onOpen: () => open({ type: "masking" }),
      },
      {
        kind: "row",
        id: "choice",
        name: t("policy.way"),
        desc: t("overview.choice"),
        value: wayShort(policy.way),
        onOpen: () => open({ type: "choice" }),
      },
    );
    return rows;
  }
  // On this computer: the credits first, then what is here.
  rows.push(
    place.account
      ? {
          kind: "row",
          id: "credits",
          name: t("overview.credits"),
          desc: t("overview.credits.linked"),
          status: place.balance !== null ? credits(place.balance) : null,
          onOpen: () => open({ type: "credits" }),
        }
      : {
          kind: "row",
          id: "credits",
          name: t("overview.credits"),
          desc: t("overview.credits.local"),
          button: {
            label: t("models.creditsConnect"),
            primary: true,
            onClick: () => open({ type: "credits" }),
          },
          onOpen: () => open({ type: "credits" }),
        },
  );
  if (place.account) {
    rows.push({
      kind: "row",
      id: "fallback",
      name: t("models.creditsFallback"),
      desc: t("overview.credits.fallback"),
      toggle: {
        on: state.creditFallback,
        disabled: !place.canEdit,
        onChange: (creditFallback) => save.mutate({ creditFallback }),
      },
    });
  }
  rows.push({ kind: "label", label: t("overview.onComputer") });
  for (const h of place.harnesses.filter((h) => h.version !== null)) {
    const signedIn = h.auth !== "none";
    rows.push({
      kind: "row",
      id: h.id,
      name: h.name,
      desc: t("overview.client.desc", { sub: t(`harness.sub.${h.id}`) }),
      status: signedIn
        ? t(h.auth === "api_key" ? "overview.client.key" : "overview.client.in")
        : null,
      button: signedIn
        ? null
        : { label: t("overview.client.signIn"), onClick: () => open({ type: "client", id: h.id }) },
      onOpen: () => open({ type: "client", id: h.id }),
    });
  }
  if (state.apple?.supported) {
    rows.push({
      kind: "row",
      id: "apple",
      name: t("models.optApple"),
      desc: t("overview.apple.desc"),
      status: t(state.apple.available ? "overview.ready" : "overview.off"),
      muted: !state.apple.available,
      onOpen: () => open({ type: "cap", id: "text" }),
    });
  }
  rows.push({
    kind: "row",
    id: "ollama",
    name: "Ollama",
    desc: ollama?.models.length ? ollama.models.join(", ") : t("overview.ollama.desc"),
    status:
      ollama?.running && ollama.models.length
        ? t(ollama.models.length === 1 ? "overview.ollama.one" : "overview.ollama.n", {
            n: ollama.models.length,
          })
        : null,
    button:
      ollama?.running && ollama.models.length
        ? null
        : { label: t("overview.setUp"), onClick: () => open({ type: "local" }) },
    onOpen: () => open({ type: "local" }),
  });
  rows.push({
    kind: "row",
    id: "keys",
    name: t("policy.ownKeys"),
    desc: keyed.length
      ? keyed.map((p) => p.name).join(", ")
      : PROVIDERS.slice(0, 5)
          .map((p) => p.name)
          .join(", "),
    status: keyed.length ? t("overview.keys.stored", { n: keyed.length }) : null,
    button: { label: t("overview.keys.add"), onClick: () => open({ type: "keys" }) },
    onOpen: () => open({ type: "keys" }),
  });
  return rows;
}

/** The tiers to pick from, for the organization's admins: three cards. */
function useScope(tier: ModelTier | null) {
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (id: string) => api.put<ModelsState>("/api/studio/model-tier", { tier: id }),
    onSuccess: (state) => qc.setQueryData(["models"], state),
  });
  const choices = tier?.choices ?? [];
  const all = choices.every((c) => c.inPlan);
  const options: ScopeOption[] = choices.map((c) => ({
    id: c.id,
    name: c.name,
    desc: scopeDesc(c.id),
    tag: !c.inPlan
      ? t(c.id === "eu-sovereign" ? "overview.fromTeam" : "overview.fromPro")
      : all && c.id === "eu-private"
        ? t("overview.recommended")
        : null,
    on: c.id === (save.isPending ? save.variables : tier?.id),
    disabled: !c.inPlan,
  }));
  return { options, save };
}

function ScopePart({ tier, canEdit }: { tier: ModelTier; canEdit: boolean }) {
  const { options, save } = useScope(tier);
  if (!options.length) {
    return null;
  }
  return (
    <div className="flex flex-col gap-2">
      <ScopeCards
        options={options}
        locked={tier.locked}
        disabled={!canEdit || save.isPending}
        onPick={(id) => save.mutate(id)}
      />
      {save.isError ? (
        <p className="text-[0.8125rem] text-rose">{(save.error as Error).message}</p>
      ) : null}
    </div>
  );
}

/** Übersicht: what everything runs with, which model does which job, and the accesses. */
function OverviewPanel({ s }: { s: Situation }) {
  const save = useSave();
  const { me, place, tier } = s;
  const studio = [chatRow(s)];
  const runs = (["text", "media", "voice"] as const).map((job) => jobRow(job, s));
  const organization = me.tenant.name ?? t("policy.yourOrganization");
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-3.5">
        <h1 className="font-display font-semibold text-[1.625rem] leading-tight tracking-tight">
          {t("overview.title")}
        </h1>
        <HeroCard hero={heroOf(s, [...studio, ...runs])} />
      </div>
      {s.admin && tier?.choices?.length ? (
        <OverviewSection
          title={t("overview.scope")}
          lead={t("overview.scopeLead", { organization })}
        >
          <ScopePart tier={tier} canEdit={place.canEdit} />
        </OverviewSection>
      ) : null}
      <OverviewSection
        title={t("overview.jobs")}
        lead={
          place.cloud && tier && !place.canEdit
            ? t("overview.jobsLead.member", { organization })
            : s.admin && planOf(me) === "team"
              ? t("overview.jobsLead.team", { organization })
              : t("overview.jobsLead")
        }
      >
        <JobsBox
          title={t("models.groupStudio")}
          desc={t(place.cloud ? "overview.studioDesc.cloud" : "overview.studioDesc")}
          jobs={studio}
        />
        <JobsBox
          title={t("models.groupRuns")}
          desc={t(
            place.cloud
              ? "overview.runsDesc.cloud"
              : place.account
                ? "overview.runsDesc.linked"
                : "overview.runsDesc",
          )}
          jobs={runs}
        />
      </OverviewSection>
      <OverviewSection
        title={t("models.groupAccess")}
        lead={
          s.admin
            ? t("overview.accessLead.admin", { organization })
            : t(place.cloud ? "overview.accessLead.member" : "overview.accessLead")
        }
      >
        <AccessList rows={accessRows(s, save)} />
        {save.isError ? (
          <p className="text-[0.8125rem] text-rose">{(save.error as Error).message}</p>
        ) : null}
      </OverviewSection>
    </div>
  );
}

/** API-Keys: every provider, the ones with a key first; each opens its page. */
function KeysPanel({ s }: { s: Situation }) {
  const { state, place, tier, policy, admin } = s;
  const providers = [...PROVIDERS].sort(
    (a, b) => Number(Boolean(state.keys[b.id])) - Number(Boolean(state.keys[a.id])),
  );
  return (
    <div className="flex flex-col gap-5">
      <PanelHead icon={KeyRound} title={t("overview.menu.keys")} lead={t("overview.keysLead")} />
      {admin && tier ? (
        <PolicySwitchCard tier={tier} policy={policy} field="ownKeys" canEdit={place.canEdit} />
      ) : null}
      {place.ownKeys ? (
        <AccessList
          rows={providers.map((p) => ({
            kind: "row",
            id: p.id,
            name: p.name,
            desc: providerText(p.about, lang),
            note: state.keys[p.id] ? keySource(state.keyHints?.[p.id], place) : null,
            status: state.keys[p.id]
              ? (state.keyHints?.[p.id]?.masked ?? t("models.noteKey"))
              : null,
            button: state.keys[p.id]
              ? null
              : {
                  label: t("overview.keys.add"),
                  onClick: () => s.open({ type: "provider", id: p.id }),
                },
            onOpen: () => s.open({ type: "provider", id: p.id }),
          }))}
        />
      ) : (
        <Card className="p-5 sm:p-6">
          <Hint>{t("overview.keys.plan")}</Hint>
        </Card>
      )}
    </div>
  );
}

/** Abos: the AI clients on this computer; in the cloud, whether members may use theirs. */
function SubsPanel({ s }: { s: Situation }) {
  const { me, state, place, tier, policy, admin } = s;
  if (place.cloud) {
    return (
      <div className="flex flex-col gap-5">
        <PanelHead
          icon={Laptop}
          title={t("overview.menu.subs")}
          lead={t("overview.subsLead.cloud")}
        />
        {admin && tier ? (
          <PolicySwitchCard
            tier={tier}
            policy={policy}
            field="subscriptions"
            canEdit={place.canEdit}
          />
        ) : (
          <Card className="p-5 sm:p-6">
            <Hint>
              {t(policy.subscriptions ? "overview.subs.allowed" : "overview.subs.refused")}
            </Hint>
          </Card>
        )}
      </div>
    );
  }
  const installed = place.harnesses.filter((h) => h.version !== null);
  const shown = installed.length
    ? installed
    : place.harnesses.filter((h) => h.id === "claude" || h.id === "codex");
  return (
    <div className="flex flex-col gap-8">
      {shown.map((h) => (
        <ClientPanel key={h.id} me={me} id={h.id} state={state} place={place} />
      ))}
    </div>
  );
}

/** Lokale Modelle: Ollama on this computer; in the cloud, whether members may use theirs. */
function LocalPanel({ s }: { s: Situation }) {
  const { state, place, tier, policy, admin } = s;
  if (place.cloud) {
    return (
      <div className="flex flex-col gap-5">
        <PanelHead
          icon={HardDrive}
          title={t("overview.menu.local")}
          lead={t("overview.localLead.cloud")}
        />
        {admin && tier ? (
          <PolicySwitchCard
            tier={tier}
            policy={policy}
            field="localModels"
            canEdit={place.canEdit}
          />
        ) : (
          <Card className="p-5 sm:p-6">
            <Hint>
              {t(policy.localModels ? "overview.local.allowed" : "overview.local.refused")}
            </Hint>
          </Card>
        )}
      </div>
    );
  }
  return <OllamaAccessPanel state={state} place={place} />;
}

/**
 * Settings → Models: an overview of what the studio and the wizards run with, a page per job
 * (the studio chat, text and reasoning, images and video, voice), the accesses (credits,
 * subscriptions, local models, keys) and, for an organization's admins, its tier and how it
 * shares out models. The menu goes one level down in the settings' left container; this is the
 * page beside it. The same page alone and in the cloud; what differs is decided by `Place`.
 */
export function Models() {
  const me = useMe();
  const models = useModels();
  // Ollama's row in the menu; a runtime of a Manage-App has none.
  const local = useLocalModels(Boolean(me.data) && me.data?.mode !== "managed");
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [view, setView] = useState<View>("auto");
  const { narrow } = useSettingsMenu();
  const savePolicy = useSavePolicy();
  const show = params.get("show");
  const target = targetOf(show);
  const tiers = useFeature("modelTiers");
  const tier = tiers ? (models.data?.tier ?? null) : null;
  const policy = models.data?.modelPolicy ?? DEFAULT_POLICY;
  useDetail(show || !narrow ? targetLabel(target, me.data) : null);
  if (!me.data || !models.data) {
    return models.isError ? (
      <p className="text-[0.875rem] text-rose">{(models.error as Error).message}</p>
    ) : null;
  }
  const state = models.data;
  const person = me.data;
  const place = placeOf(person, view);
  const open = (next: Target) =>
    setParams(showOf(next) ? { show: showOf(next) as string } : {}, { replace: !narrow });
  // On a phone the menu marks nothing: a row opens the page.
  const page = (x: Target) =>
    x.type === "cap"
      ? jobOf(x.id)
      : x.type === "provider"
        ? "keys"
        : x.type === "client"
          ? "subs"
          : x.type;
  const isOpen = (next: Target) => Boolean(show || !narrow) && page(next) === page(target);
  const s: Situation = {
    me: me.data,
    state,
    place,
    tier,
    policy,
    admin: place.cloud && place.canEdit && Boolean(tier),
    ollama: place.cloud
      ? null
      : {
          running: Boolean(local.data?.ollama.version),
          models: local.data?.installed.map((m) => m.name.replace(/:latest$/, "")) ?? [],
        },
    open,
    savePolicy: (next) => savePolicy.mutate(next),
  };
  const studio = chatRow(s);
  const runs = (["text", "media", "voice"] as const).map((job) => jobRow(job, s));
  const tone = (j: OverviewJob): MenuTone =>
    j.state === "ok" ? "done" : j.state === "miss" ? "miss" : "off";
  const toneLabel = (j: OverviewJob) =>
    j.state === "ok" ? j.access : j.state === "miss" ? t("overview.missingWord") : (j.naText ?? "");
  const hint = (text: string | null) =>
    text ? <span className="text-[0.75rem] text-ink-3 tabular-nums">{text}</span> : null;
  const onOff = (on: boolean) => t(on ? "overview.on" : "overview.off");
  const keyed = PROVIDERS.filter((p) => state.keys[p.id]).length;
  const signedIn = place.harnesses.filter((h) => h.version !== null && h.auth !== "none").length;
  const localCount =
    (s.ollama?.running ? s.ollama.models.length : 0) + (state.apple?.available ? 1 : 0);
  const usage = me.data.mode === "managed" && featureOn(me.data.features, "organizationSettings");

  return (
    <>
      <SubMenu>
        <ul className="mb-1 flex flex-col gap-0.5">
          <MenuRow
            icon={LayoutGrid}
            label={t("overview.nav")}
            selected={isOpen({ type: "overview" })}
            onPick={() => open({ type: "overview" })}
          />
        </ul>
        <MenuGroup label={t("models.groupStudio")}>
          <MenuRow
            icon={MessageCircle}
            label={t("models.cap.chat")}
            tone={tone(studio)}
            toneLabel={toneLabel(studio)}
            selected={isOpen({ type: "chat" })}
            onPick={() => open({ type: "chat" })}
          />
        </MenuGroup>
        <MenuGroup label={t("models.groupRuns")}>
          {runs.map((job) => (
            <MenuRow
              key={job.id}
              icon={JOB_ICON[job.id as Job]}
              label={job.name}
              tone={tone(job)}
              toneLabel={toneLabel(job)}
              selected={isOpen({ type: "cap", id: JOB_CAPS[job.id as Job][0] })}
              onPick={job.onOpen}
            />
          ))}
        </MenuGroup>
        <MenuGroup label={t("models.groupAccess")}>
          <MenuRow
            icon={Coins}
            label={t("overview.credits")}
            badge={hint(
              place.balance !== null
                ? Math.floor(place.balance).toLocaleString(lang)
                : place.credits
                  ? null
                  : t("overview.missingWord"),
            )}
            selected={isOpen({ type: "credits" })}
            onPick={() => open({ type: "credits" })}
          />
          {place.cloud && !s.admin ? null : (
            <MenuRow
              icon={TerminalSquare}
              label={t("overview.menu.subs")}
              badge={hint(place.cloud ? onOff(policy.subscriptions) : String(signedIn))}
              selected={isOpen({ type: "subs" })}
              onPick={() => open({ type: "subs" })}
            />
          )}
          {place.cloud && !s.admin ? null : (
            <MenuRow
              icon={HardDrive}
              label={t("overview.menu.local")}
              badge={hint(place.cloud ? onOff(policy.localModels) : String(localCount))}
              selected={isOpen({ type: "local" })}
              onPick={() => open({ type: "local" })}
            />
          )}
          <MenuRow
            icon={KeyRound}
            label={t("overview.menu.keys")}
            badge={hint(
              !place.ownKeys
                ? t("overview.fromPro")
                : s.admin && !policy.ownKeys
                  ? onOff(false)
                  : String(keyed),
            )}
            selected={isOpen({ type: "keys" })}
            onPick={() => open({ type: "keys" })}
          />
          {s.admin ? (
            <MenuRow
              icon={EyeOff}
              label={t("overview.menu.masking")}
              badge={hint(onOff(policy.masking))}
              selected={isOpen({ type: "masking" })}
              onPick={() => open({ type: "masking" })}
            />
          ) : null}
        </MenuGroup>
        {s.admin && tier ? (
          <MenuGroup label={t("tier.group")}>
            <MenuRow
              icon={ShieldCheck}
              label={t("overview.scope")}
              selected={isOpen({ type: "scope" })}
              onPick={() => open({ type: "scope" })}
            />
            <MenuRow
              icon={Users}
              label={t("policy.way")}
              badge={hint(wayShort(policy.way))}
              selected={isOpen({ type: "choice" })}
              onPick={() => open({ type: "choice" })}
            />
            <MenuRow
              icon={Plug}
              label={t("policy.apps")}
              badge={hint(appsShort(policy.apps))}
              selected={isOpen({ type: "apps" })}
              onPick={() => open({ type: "apps" })}
            />
            {usage ? (
              <MenuRow
                icon={ChartColumn}
                label={t("credits.usage")}
                selected={false}
                onPick={() => navigate("/settings/usage")}
              />
            ) : null}
          </MenuGroup>
        ) : null}
        <Preview view={view} onView={setView} />
      </SubMenu>
      {place.canEdit ? null : (
        <p className="mb-4 rounded-lg bg-paper-2 px-3 py-2 text-[0.8125rem] text-ink-2">
          {t("models.readOnly")}
        </p>
      )}
      {target.type === "overview" ? (
        <OverviewPanel s={s} />
      ) : target.type === "choice" && tier ? (
        <div className="flex flex-col gap-8">
          <ChoicePanel
            tier={tier}
            policy={policy}
            organization={me.data.tenant.name}
            canEdit={place.canEdit}
          />
          {policy.way === "C" ? (
            <ApprovedPanel tier={tier} policy={policy} canEdit={place.canEdit} />
          ) : policy.way === "B" ? (
            <DefaultsPanel tier={tier} policy={policy} canEdit={place.canEdit} />
          ) : null}
        </div>
      ) : target.type === "apps" && tier ? (
        <AppsPanel tier={tier} policy={policy} canEdit={place.canEdit} />
      ) : target.type === "masking" && tier ? (
        <MaskingPanel tier={tier} policy={policy} canEdit={place.canEdit} />
      ) : target.type === "scope" && tier ? (
        <TierPanel
          tier={tier}
          modelPolicy={state.modelPolicy ?? null}
          organization={me.data.tenant.name}
        >
          {s.admin ? <ScopePart tier={tier} canEdit={place.canEdit} /> : null}
        </TierPanel>
      ) : target.type === "chat" ? (
        <ChatPanel me={me.data} state={state} place={place} onOpen={open} />
      ) : target.type === "cap" ? (
        <div className="flex flex-col gap-8">
          {JOB_CAPS[jobOf(target.id)].map((cap) => (
            <CapabilityPanel
              key={cap}
              cap={cap}
              state={state}
              place={place}
              me={person}
              onOpen={open}
            />
          ))}
          {jobOf(target.id) === "text" ? (
            <>
              {tier ? (
                <Card className="flex flex-col gap-3 p-5 sm:p-6">
                  <Part title={t("chooser.title")}>
                    <TierChooser tier={tier} modelPolicy={state.modelPolicy ?? null} />
                  </Part>
                </Card>
              ) : null}
              <DecisionPanel state={state} place={place} onOpen={open} />
              <SearchPanel state={state} place={place} onOpen={open} />
            </>
          ) : null}
        </div>
      ) : target.type === "keys" ? (
        <KeysPanel s={s} />
      ) : target.type === "subs" ? (
        <SubsPanel s={s} />
      ) : target.type === "local" ? (
        <LocalPanel s={s} />
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

const JOB_ICON: Record<Job, LucideIcon> = { text: PenLine, media: ImageIcon, voice: Volume2 };
