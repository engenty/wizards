import { createHash } from "node:crypto";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createElevenLabs } from "@ai-sdk/elevenlabs";
import { createFal } from "@ai-sdk/fal";
import { createGateway } from "@ai-sdk/gateway";
import { createGoogle } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createReplicate } from "@ai-sdk/replicate";
import type { Lang, VideoResolution } from "@engenty-wizards/shared/definition";
import {
  type Effort,
  MODEL_CLASSES,
  type ModelClass,
  TEXT_CLASSES,
  type TextClass,
} from "@engenty-wizards/shared/definition";
import {
  CAPABILITY_CLASSES,
  type CreditModel,
  creditsModelOf,
  isCreditsRef,
  type ModelCapability,
  type ModelOption,
  PROVIDER_IDS,
  type ProviderId,
  providerInfo,
  providerOfRef,
} from "@engenty-wizards/shared/providers";
import type { RunNote, RunNoteCode, Said } from "@engenty-wizards/shared/run";
import { note, saidText } from "@engenty-wizards/shared/run";
import type { MastraModelConfig } from "@mastra/core/llm";
import {
  type EmbeddingModel,
  type experimental_generateVideo,
  generateSpeech,
  generateText,
  type ImageModel,
  type LanguageModel,
  type SpeechModel,
  type TranscriptionModel,
} from "ai";
import { accountToken, linkedAccount } from "./auth/account.js";
import { DeviceModel, deviceThinks } from "./engine/device.js";
import { env } from "./env.js";
import {
  appleModel,
  appleStatus,
  appleTranscriptionModel,
  appleUnavailableNote,
} from "./harness/apple.js";
import {
  detectHarness,
  type Harness,
  type HarnessId,
  HarnessModel,
  harness,
  isHarnessVendor,
  notInstalled,
  signedOut,
} from "./harness/index.js";
import { managed } from "./manage.js";
import { hasFfmpeg } from "./media/ffmpeg.js";
import { ModelUnavailableError, saidOf } from "./model-errors.js";
import { seal, unseal } from "./secrets/crypto.js";
import { vaultDelete, vaultGet, vaultSet } from "./secrets/vault.js";
import { readSetting, writeSetting } from "./settings.js";
import { currentTenant, currentTenantOrNull } from "./tenants/tenant.js";
import { serverText } from "./texts.js";

export { isHarnessVendor } from "./harness/index.js";
/**
 * A step names a model class, never a model. Where the class runs is decided here, in this order:
 *  1. its own way: an AI client installed on the machine (Claude Code, Codex, Antigravity, Cursor
 *     Agent — on its subscription), an API key the person brought (OpenAI, Anthropic, Google,
 *     fal.ai, ElevenLabs, Replicate, AI Gateway) or a local model;
 *  2. credits: the model-gateway binds `wizards/<class>`, meters the call and books it — on the
 *     tenant of a Manage-App's runtime, or on the account a runtime that runs alone is linked to.
 * A runtime of a Manage-App keeps a tenant's own keys (sealed) and runs on its credits where it
 * has none. A binding is `[provider:]vendor/model`, e.g. `anthropic/claude-haiku-4.5` (AI
 * Gateway), `openai:gpt-5.4-mini`, `fal:fal-ai/flux/schnell`, `ollama:qwen3`, `claude/sonnet`
 * (an installed client), or `credits`.
 */
export { ModelUnavailableError } from "./model-errors.js";

/** What a call is made for; the gateway books it on the run and step. */
export interface CallMeta {
  runId?: string;
  stepId?: string;
  effort?: Effort;
}

type VideoModel = Parameters<typeof experimental_generateVideo>[0]["model"];

export interface ResolvedModel<M> {
  model: M;
  /** The model the class is bound to, as far as this runtime knows it — prices and vendor quirks. */
  ref: string;
  vendor: string;
  /** Served by an AI Gateway (ours or the person's own key): its search tools are available. */
  gateway: boolean;
  /** Booked by the model-gateway; the runtime adds no cost of its own. */
  metered: boolean;
}

// --- configuration -----------------------------------------------------------------

export const LOCAL_KEYS = PROVIDER_IDS;
export type LocalKey = ProviderId;

/**
 * A client's id = text on that installed client; `account` = text on the account's credits;
 * `own` = own keys or a local model. A text class bound to Apple Intelligence (`apple:default`)
 * thinks there under any source.
 */
export type LocalSource = HarnessId | "account" | "own";

export interface LocalModelSettings {
  source: LocalSource;
  bindings: Partial<Record<ModelClass, string>>;
  ollamaUrl?: string;
  /** The credits of the linked account step in for a class without a way of its own. Default: on. */
  creditFallback?: boolean;
}

/** What decides where a class runs: the settings and the keys, of this machine or of a tenant. */
interface ModelConfig {
  settings: LocalModelSettings;
  keys: Partial<Record<LocalKey, string>>;
}

export interface ModelSettingsInput {
  source?: LocalSource;
  bindings?: Partial<Record<ModelClass, string>>;
  ollamaUrl?: string;
  creditFallback?: boolean;
  /** A key to store; an empty string removes it. */
  keys?: Partial<Record<LocalKey, string>>;
}

const local: ModelConfig = { settings: { source: "own", bindings: {} }, keys: {} };

function envKey(name: LocalKey): string | undefined {
  const value = {
    gateway: env.aiGatewayKey,
    openai: env.openaiKey,
    anthropic: env.anthropicKey,
    google: env.googleKey,
    fal: env.falKey,
    elevenlabs: env.elevenlabsKey,
    replicate: env.replicateKey,
  }[name];
  return value || undefined;
}

/** Reads the model settings and keys of a runtime that runs alone; called at start and after a change. */
export async function loadLocalModels() {
  if (managed) {
    return;
  }
  local.settings = (await readSetting<LocalModelSettings>("models")) ?? {
    source: "own",
    bindings: {},
  };
  const keys: ModelConfig["keys"] = {};
  for (const name of LOCAL_KEYS) {
    keys[name] = (await vaultGet(`key.${name}`)) ?? envKey(name);
  }
  local.keys = keys;
}

/** A team on a runtime of a Manage-App: its own keys, sealed, and what each class runs on. */
interface StoredTenantModels {
  bindings: Partial<Record<ModelClass, string>>;
  keys: string | null;
}

const tenantConfigs = new Map<string, ModelConfig>();
const tenantSetting = (tenant: string) => `models:${tenant}`;

/** A team thinks on its credits unless it brought a key: `own`, with the credits behind it. */
function teamSettings(bindings: Partial<Record<ModelClass, string>>): LocalModelSettings {
  return { source: "own", bindings, creditFallback: true };
}

async function tenantConfig(tenant: string): Promise<ModelConfig> {
  const hit = tenantConfigs.get(tenant);
  if (hit) {
    return hit;
  }
  const stored = await readSetting<StoredTenantModels>(tenantSetting(tenant));
  const value: ModelConfig = {
    settings: teamSettings(stored?.bindings ?? {}),
    keys: (stored?.keys ? unseal<ModelConfig["keys"]>(stored.keys) : null) ?? {},
  };
  tenantConfigs.set(tenant, value);
  return value;
}

async function config(): Promise<ModelConfig> {
  if (!managed) {
    return local;
  }
  const tenant = currentTenantOrNull();
  return tenant ? tenantConfig(tenant) : { settings: teamSettings({}), keys: {} };
}

function mergeBindings(
  current: Partial<Record<ModelClass, string>>,
  changes: Partial<Record<ModelClass, string>> = {},
) {
  const bindings = { ...current };
  for (const [cls, ref] of Object.entries(changes)) {
    if (ref?.trim()) {
      bindings[cls as ModelClass] = ref.trim();
    } else {
      delete bindings[cls as ModelClass];
    }
  }
  return bindings;
}

export function localModelSettings() {
  return {
    ...local.settings,
    creditFallback: local.settings.creditFallback !== false,
    bindings: Object.fromEntries(
      MODEL_CLASSES.map((c) => [c, ownRef(local, c) || local.settings.bindings[c] || ""]),
    ) as Record<ModelClass, string>,
    ollamaUrl: local.settings.ollamaUrl ?? env.ollamaUrl,
    keys: Object.fromEntries(LOCAL_KEYS.map((k) => [k, Boolean(local.keys[k])])) as Record<
      LocalKey,
      boolean
    >,
  };
}

export async function saveLocalModels(input: ModelSettingsInput) {
  await writeSetting("models", {
    source: input.source ?? local.settings.source,
    bindings: mergeBindings(local.settings.bindings, input.bindings),
    ollamaUrl: input.ollamaUrl?.trim() || local.settings.ollamaUrl,
    creditFallback: input.creditFallback ?? local.settings.creditFallback,
  } satisfies LocalModelSettings);
  for (const [name, value] of Object.entries(input.keys ?? {})) {
    if (value?.trim()) {
      await vaultSet(`key.${name}`, value.trim());
    } else {
      await vaultDelete(`key.${name}`);
    }
  }
  await loadLocalModels();
}

/** A team's keys and bindings on a runtime of a Manage-App. No client and no local model there. */
async function saveTenantModels(tenant: string, input: ModelSettingsInput) {
  const current = await tenantConfig(tenant);
  const keys = { ...current.keys };
  for (const [name, value] of Object.entries(input.keys ?? {})) {
    if (value?.trim()) {
      keys[name as LocalKey] = value.trim();
    } else {
      delete keys[name as LocalKey];
    }
  }
  await writeSetting(tenantSetting(tenant), {
    bindings: mergeBindings(current.settings.bindings, input.bindings),
    keys: Object.keys(keys).length ? seal(keys) : null,
  } satisfies StoredTenantModels);
  tenantConfigs.delete(tenant);
}

/** Saves for this machine, or for the current tenant of a Manage-App's runtime. */
export async function saveModels(input: ModelSettingsInput) {
  if (managed) {
    await saveTenantModels(currentTenant(), input);
  } else {
    await saveLocalModels(input);
  }
}

/** A stored key, for a check of the key itself; never sent to the studio. */
export async function storedKey(name: LocalKey): Promise<string | undefined> {
  return (await config()).keys[name];
}

// --- where a class runs -------------------------------------------------------------

const isText = (cls: ModelClass) => (TEXT_CLASSES as readonly string[]).includes(cls);

/**
 * `fal:fal-ai/flux/schnell` → provider fal, id `fal-ai/flux/schnell`. Without a provider the
 * binding is an AI Gateway id (`google/veo-…`) or an installed client (`codex/default`).
 */
function parse(ref: string): { provider: string | null; id: string; vendor: string } {
  const match = /^([a-z]+):(.*)$/s.exec(ref);
  if (match) {
    const [, provider, id] = match;
    // Ollama and the gateway name a model as the gateway does; the others are their own vendor.
    const vendor = provider === "ollama" || provider === "gateway" ? id.split("/")[0] : provider;
    return { provider, id, vendor };
  }
  return { provider: null, id: ref, vendor: ref.split("/")[0] };
}

const vendorOf = (ref: string) => parse(ref).vendor;

/** A model on this machine: Ollama, or Apple Intelligence on a Mac (harness/apple.ts). */
const isLocalProvider = (provider: string | null) => provider === "ollama" || provider === "apple";

/** The part of `codex/default` after the client. */
const aliasOf = (id: string) => id.split("/").slice(1).join("/");

/** Whether this configuration can reach a binding without credits. */
function reachable(cfg: ModelConfig, ref: string): boolean {
  if (!ref || isCreditsRef(ref)) {
    return false;
  }
  const { provider, vendor } = parse(ref);
  if ((provider === null && isHarnessVendor(vendor)) || isLocalProvider(provider)) {
    // An installed client and a local model are of this machine.
    return !managed;
  }
  if (provider === null || provider === "gateway") {
    return (
      Boolean(cfg.keys.gateway) ||
      (provider === null &&
        (vendor === "openai" || vendor === "anthropic") &&
        Boolean(cfg.keys[vendor]))
    );
  }
  return Boolean(cfg.keys[provider as LocalKey]);
}

/** What a class runs on without credits: a client, an own key or a local model. "" = no way of its own. */
function ownRef(cfg: ModelConfig, cls: ModelClass): string {
  const bound = cfg.settings.bindings[cls];
  // A text class bound to Apple Intelligence (Classifier, Standard) thinks on this Mac whatever
  // the source is: the others keep the installed client, the account's credits or the keys.
  if (isText(cls) && bound && parse(bound).provider === "apple") {
    return reachable(cfg, bound) ? bound : "";
  }
  const client = managed ? null : harness(cfg.settings.source);
  if (isText(cls) && client) {
    // Text thinks on the installed client; a binding counts only where it names that client.
    return bound?.startsWith(`${client.id}/`)
      ? bound
      : `${client.id}/${client.classes[cls as TextClass]}`;
  }
  // Text on the account's credits: every text class goes there.
  if (isText(cls) && cfg.settings.source === "account") {
    return "";
  }
  if (isCreditsRef(bound)) {
    return "";
  }
  if (bound) {
    return reachable(cfg, bound) ? bound : "";
  }
  // A client that makes images on the sign-in makes them too, before any key is paid for.
  if (cls === "image" && client?.image) {
    return `${client.id}/${client.image.alias}`;
  }
  // The defaults name gateway models; without a gateway key nothing reaches them.
  return reachable(cfg, env.models[cls]) ? env.models[cls] : "";
}

/** What a class makes, to say that nothing makes it. */
const MAKES: Record<ModelClass, RunNoteCode> = {
  classifier: "makesText",
  standard: "makesText",
  high: "makesText",
  highest: "makesText",
  image: "makesImages",
  video: "makesVideos",
  speech: "makesSpeech",
  audio: "makesVoiceNotes",
};

/** Why a class has no way: the provider picked for it lacks its key, or nothing is set up. */
function missingText(cfg: ModelConfig, cls: ModelClass): RunNote {
  const bound = cfg.settings.bindings[cls];
  if (isCreditsRef(bound)) {
    return note("creditsNotSignedIn");
  }
  const provider = bound ? providerInfo(providerOfRef(bound) ?? "") : null;
  if (provider) {
    return note("providerKeyMissing", { provider: provider.name, makes: note(MAKES[cls]) });
  }
  return note("noModelFor", { makes: note(MAKES[cls]) });
}

interface GatewayAccess {
  baseUrl: string;
  token: string;
  tenant: string | null;
}

/**
 * The way to the credits. On a Manage-App's runtime always; alone, through the linked account —
 * where text runs on it (`chosen`), or as the fallback for what has no way of its own.
 */
async function creditAccess(cfg: ModelConfig, chosen: boolean): Promise<GatewayAccess | null> {
  if (managed) {
    return {
      baseUrl: env.manage.gatewayUrl,
      token: env.manage.serviceKey,
      tenant: currentTenantOrNull(),
    };
  }
  if (!chosen && (cfg.settings.creditFallback === false || !(await linkedAccount()))) {
    return null;
  }
  const token = await accountToken();
  if (!token) {
    if (chosen) {
      throw new ModelUnavailableError(note("accountNoLongerSigned"));
    }
    return null;
  }
  return { baseUrl: env.local.gatewayUrl, token, tenant: null };
}

/** A class goes to the credits on purpose: text on the account, or a binding that says so. */
function creditsChosen(cfg: ModelConfig, cls: ModelClass): boolean {
  return (
    isCreditsRef(cfg.settings.bindings[cls]) ||
    (isText(cls) && cfg.settings.source === "account" && !managed)
  );
}

/** `model`: the model a `credits:<id>` binding names; null where the gateway's class decides. */
type Route =
  | { kind: "own"; cfg: ModelConfig; ref: string }
  | { kind: "credits"; access: GatewayAccess; model: string | null };

async function routeOf(cls: ModelClass): Promise<Route> {
  const cfg = await config();
  const ref = ownRef(cfg, cls);
  if (ref) {
    return { kind: "own", cfg, ref };
  }
  const access = await creditAccess(cfg, creditsChosen(cfg, cls));
  if (access) {
    return { kind: "credits", access, model: creditsModelOf(cfg.settings.bindings[cls]) };
  }
  throw new ModelUnavailableError(missingText(cfg, cls));
}

/** The key of a provider, or why the call cannot be made. */
function need(cfg: ModelConfig, name: LocalKey): string {
  const key = cfg.keys[name];
  if (!key) {
    throw new ModelUnavailableError(
      note("noApiKeyFor", { provider: providerInfo(name)?.name ?? name }),
    );
  }
  return key;
}

function gatewayClient(access: GatewayAccess, meta: CallMeta) {
  return createGateway({
    baseURL: `${access.baseUrl}/v4/ai`,
    apiKey: access.token,
    headers: {
      ...(access.tenant ? { "x-wizards-tenant": access.tenant } : {}),
      ...(meta.runId ? { "x-wizards-run": meta.runId } : {}),
      ...(meta.stepId ? { "x-wizards-step": meta.stepId } : {}),
      ...(meta.effort ? { "x-wizards-effort": meta.effort } : {}),
    },
  });
}

export interface ClassPrice {
  model: string;
  kind: "text" | "image" | "video" | "audio" | "speech" | "embedding";
  inputCreditsPerMTok?: number;
  outputCreditsPerMTok?: number;
  creditsPerImage?: number;
  creditsPerSecond?: number;
  creditsPer1kCharacters?: number;
  creditsPerMinute?: number;
  /** The audio class is bound to a transcription model: called on /transcription-model. */
  transcribes?: boolean;
}

export interface GatewayCatalog {
  markup: number;
  classes: Partial<Record<ModelClass | "embedding", ClassPrice | null>>;
  webSearchCredits: number;
  /** The media models the credits pay for that a binding may name (`credits:<id>`). */
  models?: CreditModel[];
}

let gatewayCatalog: { at: number; base: string; value: GatewayCatalog } | null = null;

/** What the gateway binds each class to, with prices in credits. Cached for five minutes. */
export async function classCatalog(): Promise<GatewayCatalog | null> {
  const cfg = await config();
  const access = await creditAccess(cfg, cfg.settings.source === "account").catch(() => null);
  if (!access) {
    return null;
  }
  if (
    gatewayCatalog &&
    gatewayCatalog.base === access.baseUrl &&
    Date.now() - gatewayCatalog.at < 300_000
  ) {
    return gatewayCatalog.value;
  }
  try {
    const res = await fetch(`${access.baseUrl}/v1/models`, {
      headers: {
        authorization: `Bearer ${access.token}`,
        ...(access.tenant ? { "x-wizards-tenant": access.tenant } : {}),
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return gatewayCatalog?.value ?? null;
    }
    const value = (await res.json()) as GatewayCatalog;
    gatewayCatalog = { at: Date.now(), base: access.baseUrl, value };
    return value;
  } catch {
    return gatewayCatalog?.value ?? null;
  }
}

/** A call on the credits: the model a binding names, or the gateway's model of the class. */
async function viaCredits<M>(
  route: Extract<Route, { kind: "credits" }>,
  cls: ModelClass,
  meta: CallMeta,
  pick: (client: ReturnType<typeof createGateway>, id: string) => M,
): Promise<ResolvedModel<M>> {
  const bound = route.model ?? (await classCatalog())?.classes[cls]?.model ?? "";
  return {
    model: pick(gatewayClient(route.access, meta), route.model ?? `wizards/${cls}`),
    ref: bound,
    vendor: vendorOf(bound.replace(/^[a-z]+:/, "")),
    gateway: true,
    metered: true,
  };
}

/** The installed client a binding names, checked to be there. */
async function installedClient(ref: string) {
  const { provider, vendor } = parse(ref);
  const client = provider === null ? harness(vendor) : null;
  if (client && !(await detectHarness(client.id))?.version) {
    throw new ModelUnavailableError(notInstalled(client));
  }
  return client;
}

async function ownLanguageModel(
  cfg: ModelConfig,
  ref: string,
  meta: CallMeta,
): Promise<{ model: LanguageModel; gateway: boolean }> {
  const { provider, id, vendor } = parse(ref);
  const client = await installedClient(ref);
  if (client) {
    return { model: client.model(aliasOf(id), meta.effort), gateway: false };
  }
  switch (provider) {
    case "ollama":
      return {
        model: createOpenAI({
          baseURL: cfg.settings.ollamaUrl ?? env.ollamaUrl,
          apiKey: "ollama",
        }).chat(id),
        gateway: false,
      };
    case "apple": {
      const status = await appleStatus();
      if (!status.available) {
        throw new ModelUnavailableError(appleUnavailableNote(status));
      }
      return { model: appleModel(id), gateway: false };
    }
    case "openai":
      return { model: createOpenAI({ apiKey: need(cfg, "openai") })(id), gateway: false };
    case "anthropic":
      return { model: createAnthropic({ apiKey: need(cfg, "anthropic") })(id), gateway: false };
    case "google":
      return { model: createGoogle({ apiKey: need(cfg, "google") })(id), gateway: false };
    case null:
    case "gateway":
      if (cfg.keys.gateway) {
        return { model: createGateway({ apiKey: cfg.keys.gateway })(id), gateway: true };
      }
      if (provider === null && vendor === "openai" && cfg.keys.openai) {
        return { model: createOpenAI({ apiKey: cfg.keys.openai })(aliasOf(id)), gateway: false };
      }
      if (provider === null && vendor === "anthropic" && cfg.keys.anthropic) {
        return {
          model: createAnthropic({ apiKey: cfg.keys.anthropic })(aliasOf(id)),
          gateway: false,
        };
      }
  }
  throw new ModelUnavailableError(note("modelNotUsedYet", { ref }));
}

/**
 * The language model a text class runs on. A run watched from a device that offers the class
 * (the app's Apple Intelligence, engine/device.ts) asks the device first and falls back to this.
 */
export async function textModel(
  cls: TextClass | "audio" | "image",
  meta: CallMeta = {},
): Promise<ResolvedModel<LanguageModel>> {
  const resolved = await ownTextModel(cls, meta);
  const device = meta.runId && isText(cls) ? await deviceThinks(meta.runId, cls) : null;
  return device
    ? { ...resolved, model: new DeviceModel(meta.runId as string, resolved.model, device.maxChars) }
    : resolved;
}

async function ownTextModel(
  cls: TextClass | "audio" | "image",
  meta: CallMeta,
): Promise<ResolvedModel<LanguageModel>> {
  const route = await routeOf(cls);
  if (route.kind === "credits") {
    return viaCredits(route, cls, meta, (client, id) => client(id) as LanguageModel);
  }
  const { model, gateway } = await ownLanguageModel(route.cfg, route.ref, meta);
  return { model, ref: route.ref, vendor: vendorOf(route.ref), gateway, metered: false };
}

/**
 * Hands the tools an agent will call to a model that runs them itself (an installed AI client).
 * `ignorable`: the step declared no tools and has no uploads — the run's device may answer
 * without the generic ones (engine/device.ts).
 */
export function attachTools(
  resolved: ResolvedModel<unknown>,
  tools: Record<string, unknown>,
  ignorable = false,
) {
  if (resolved.model instanceof HarnessModel) {
    resolved.model.attach(tools);
  } else if (resolved.model instanceof DeviceModel) {
    resolved.model.attach(tools, ignorable);
  }
}

/** Gemini image models of the gateway are chat models answering with image files. */
export function isChatImageModel(ref: string): boolean {
  return ref.includes("gemini") && ref.includes("image");
}

/** `chat`: the model answers through chat with an image file (`textModel("image")`). */
export async function imageModel(
  meta: CallMeta = {},
): Promise<ResolvedModel<ImageModel> & { chat: boolean }> {
  const route = await routeOf("image");
  if (route.kind === "credits") {
    const resolved = await viaCredits(route, "image", meta, (c, id) => c.imageModel(id));
    return { ...resolved, chat: isChatImageModel(resolved.ref) };
  }
  const { cfg, ref } = route;
  const { provider, id, vendor } = parse(ref);
  const own = (model: ImageModel, gateway = false) => ({
    model,
    ref,
    vendor,
    gateway,
    metered: false,
    chat: false,
  });
  const client = await installedClient(ref);
  if (client?.image) {
    return own(client.image.model(aliasOf(id)));
  }
  switch (provider) {
    case "openai":
      return own(createOpenAI({ apiKey: need(cfg, "openai") }).image(id));
    case "google":
      return own(createGoogle({ apiKey: need(cfg, "google") }).image(id));
    case "fal":
      return own(createFal({ apiKey: need(cfg, "fal") }).image(id));
    case "replicate":
      return own(createReplicate({ apiToken: need(cfg, "replicate") }).image(id));
    case null:
    case "gateway":
      if (cfg.keys.gateway) {
        return {
          ...own(createGateway({ apiKey: cfg.keys.gateway }).imageModel(id), true),
          chat: isChatImageModel(id),
        };
      }
      if (provider === null && vendor === "openai" && cfg.keys.openai) {
        return own(createOpenAI({ apiKey: cfg.keys.openai }).image(aliasOf(id)));
      }
  }
  throw new ModelUnavailableError(note("noModelForImages"));
}

export async function videoModel(meta: CallMeta = {}): Promise<ResolvedModel<VideoModel>> {
  const route = await routeOf("video");
  if (route.kind === "credits") {
    return viaCredits(route, "video", meta, (c, id) => c.videoModel(id));
  }
  const { cfg, ref } = route;
  const { provider, id, vendor } = parse(ref);
  const own = (model: VideoModel, gateway = false) => ({
    model,
    ref,
    vendor,
    gateway,
    metered: false,
  });
  switch (provider) {
    case "google":
      return own(createGoogle({ apiKey: need(cfg, "google") }).video(id));
    case "fal":
      return own(createFal({ apiKey: need(cfg, "fal") }).video(id));
    case "replicate":
      return own(createReplicate({ apiToken: need(cfg, "replicate") }).video(id));
    case null:
    case "gateway":
      if (cfg.keys.gateway) {
        return own(createGateway({ apiKey: cfg.keys.gateway }).videoModel(id), true);
      }
  }
  throw new ModelUnavailableError(note("noModelForVideos"));
}

/** The model that reads a text aloud. */
export async function speechModel(meta: CallMeta = {}): Promise<ResolvedModel<SpeechModel>> {
  const route = await routeOf("speech");
  if (route.kind === "credits") {
    const resolved = await viaCredits(route, "speech", meta, (c, id) => c.speechModel(id));
    if (!resolved.ref) {
      throw new ModelUnavailableError(note("noModelForSpeech"));
    }
    return resolved;
  }
  const { cfg, ref } = route;
  const { provider, id, vendor } = parse(ref);
  const own = (model: SpeechModel, gateway = false) => ({
    model,
    ref,
    vendor,
    gateway,
    metered: false,
  });
  switch (provider) {
    case "openai":
      return own(createOpenAI({ apiKey: need(cfg, "openai") }).speech(id));
    case "google":
      return own(createGoogle({ apiKey: need(cfg, "google") }).speech(id));
    case "fal":
      return own(createFal({ apiKey: need(cfg, "fal") }).speech(id));
    case "elevenlabs":
      return own(createElevenLabs({ apiKey: need(cfg, "elevenlabs") }).speech(id));
    case null:
    case "gateway":
      if (cfg.keys.gateway) {
        return own(createGateway({ apiKey: cfg.keys.gateway }).speechModel(id), true);
      }
      if (provider === null && vendor === "openai" && cfg.keys.openai) {
        return own(createOpenAI({ apiKey: cfg.keys.openai }).speech(aliasOf(id)));
      }
  }
  throw new ModelUnavailableError(note("noModelForSpeech"));
}

/**
 * What turns a voice note into text: a transcription model (ElevenLabs Scribe, Whisper), or a
 * chat model that takes audio files (Gemini) — that one also on the credits.
 */
export async function listenerModel(
  meta: CallMeta = {},
): Promise<
  | { kind: "transcription"; resolved: ResolvedModel<TranscriptionModel> }
  | { kind: "chat"; resolved: ResolvedModel<LanguageModel> }
> {
  const route = await routeOf("audio");
  if (route.kind === "credits") {
    // On the credits a transcription model is called as one: named so, or bound to the class.
    const catalog = await classCatalog();
    const transcribes = route.model
      ? catalog?.models?.find((m) => m.id === route.model)?.kind === "transcription"
      : Boolean(catalog?.classes.audio?.transcribes);
    if (transcribes) {
      return {
        kind: "transcription",
        resolved: await viaCredits(route, "audio", meta, (c, id) => c.transcriptionModel(id)),
      };
    }
  }
  if (route.kind === "own") {
    const { cfg, ref } = route;
    const { provider, id, vendor } = parse(ref);
    if (provider === "apple") {
      // This Mac writes the note down itself (SpeechAnalyzer); nothing is paid.
      return {
        kind: "transcription",
        resolved: {
          model: appleTranscriptionModel(),
          ref,
          vendor,
          gateway: false,
          metered: false,
        },
      };
    }
    const transcriber =
      provider === "elevenlabs"
        ? createElevenLabs({ apiKey: need(cfg, "elevenlabs") }).transcription(id)
        : provider === "fal"
          ? createFal({ apiKey: need(cfg, "fal") }).transcription(id)
          : provider === "openai" && /transcribe|whisper/.test(id)
            ? createOpenAI({ apiKey: need(cfg, "openai") }).transcription(id)
            : null;
    if (transcriber) {
      return {
        kind: "transcription",
        resolved: { model: transcriber, ref, vendor, gateway: false, metered: false },
      };
    }
  }
  return { kind: "chat", resolved: await textModel("audio", meta) };
}

/**
 * The model that turns passages and questions into vectors for a project's document index.
 * Null where none is set up — an installed AI client has no such model — and the index then
 * works on keywords alone.
 */
export async function embeddingModel(): Promise<{ model: EmbeddingModel; ref: string } | null> {
  const cfg = await config();
  if (managed) {
    const access = await creditAccess(cfg, true).catch(() => null);
    const bound = access ? (await classCatalog())?.classes.embedding : null;
    return access && bound
      ? { model: gatewayClient(access, {}).embeddingModel("wizards/embedding"), ref: bound.model }
      : null;
  }
  const ref = env.models.embedding;
  const { provider, id, vendor } = parse(ref);
  if (provider === "ollama") {
    const ollama = createOpenAI({
      baseURL: cfg.settings.ollamaUrl ?? env.ollamaUrl,
      apiKey: "ollama",
    });
    return { model: ollama.embedding(id), ref };
  }
  if ((provider === null || provider === "gateway") && cfg.keys.gateway) {
    return { model: createGateway({ apiKey: cfg.keys.gateway }).embeddingModel(id), ref };
  }
  if ((provider === "openai" || vendor === "openai") && cfg.keys.openai) {
    return {
      model: createOpenAI({ apiKey: cfg.keys.openai }).embedding(provider ? id : aliasOf(id)),
      ref,
    };
  }
  // No key of its own: the linked account's gateway, where its catalog has the class.
  const access = await creditAccess(cfg, false).catch(() => null);
  const bound = access ? (await classCatalog())?.classes.embedding : null;
  return access && bound
    ? { model: gatewayClient(access, {}).embeddingModel("wizards/embedding"), ref: bound.model }
    : null;
}

/** Where a System One question goes: the address, how to sign the request, the model to name. */
export interface SystemOneAccess {
  url: string;
  headers: Record<string, string>;
  /** Null: the gateway of the credits picks the model of the classifier class. */
  model: string | null;
}

/**
 * The way to TypeSafe's Jev, a classifier that answers typed questions with probabilities and
 * writes no text: the credits on a Manage-App's runtime; alone, an AI Gateway key, a TypeSafe
 * key, or the linked account's credits. Null when there is none.
 */
export async function systemOneAccess(): Promise<SystemOneAccess | null> {
  const cfg = await config();
  const viaCredits = (access: GatewayAccess): SystemOneAccess => ({
    url: `${access.baseUrl}/v4/ai/systemone`,
    headers: {
      authorization: `Bearer ${access.token}`,
      // Booked under the classifier class; its evaluation model answers.
      "ai-model-id": "wizards/classifier",
      ...(access.tenant ? { "x-wizards-tenant": access.tenant } : {}),
    },
    model: null,
  });
  if (managed) {
    const access = await creditAccess(cfg, true).catch(() => null);
    return access ? viaCredits(access) : null;
  }
  if (cfg.keys.gateway) {
    return {
      url: "https://ai-gateway.vercel.sh/typesafe/v1/systemone",
      headers: { authorization: `Bearer ${cfg.keys.gateway}` },
      model: "typesafe-ai/jev",
    };
  }
  if (env.typesafeKey) {
    return {
      url: "https://api.typesafe.ai/v1/systemone",
      headers: { authorization: `Bearer ${env.typesafeKey}` },
      model: "jev-latest",
    };
  }
  const access = await creditAccess(cfg, false).catch(() => null);
  return access ? viaCredits(access) : null;
}

/** Search tools an AI Gateway runs itself; they travel in the request, so any gateway client names them. */
export const gatewayTools = createGateway({ apiKey: "unused" }).tools;

// --- An AI Gateway key on Vercel's free tier ------------------------------------------

/** Where Vercel tops an AI Gateway account up to paid credits. */
const GATEWAY_TOP_UP = "https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai%3Fmodal%3Dtop-up";

/**
 * The model Vercel refused because the key's account is on the free tier ("" where the answer
 * names none); null where the error is something else.
 */
export function freeTierRefusal(err: unknown): string | null {
  let text = "";
  for (let e = err as any; e && text.length < 100_000; e = e.cause) {
    text += ` ${e.message ?? ""} ${e.responseBody ?? ""}`;
  }
  if (!/RestrictedModelsError|Free tier users do not have access/i.test(text)) {
    return null;
  }
  return /"originalModelId":"([^"]+)"/.exec(text)?.[1] ?? "";
}

/** What the person reads when Vercel's free tier leaves a model out, and how to fix it. */
export function freeTierText(model: string): RunNote {
  return note("freeTier", {
    model: model ? note("quoted", { text: model }) : note("thisModel"),
    url: GATEWAY_TOP_UP,
  });
}

/** What a key was answered for a model: refusals are asked again soon, as a top-up lifts them. */
const gatewayProbes = new Map<string, { refused: boolean; at: number }>();
const probeId = (key: string, id: string) =>
  `${createHash("sha256").update(key).digest("hex").slice(0, 16)}|${id}`;

/** A call refused for the free tier: the next run's check knows before it starts. */
export async function noteFreeTierRefusal(err: unknown) {
  const model = freeTierRefusal(err);
  const key = model ? (await config()).keys.gateway : undefined;
  if (model && key) {
    gatewayProbes.set(probeId(key, model), { refused: true, at: Date.now() });
  }
}

/**
 * Whether the key's account may call the model. Vercel refuses before any provider is asked, so
 * a refused probe costs nothing; an allowed one costs a token or a word. Images (but those a chat
 * model makes) and videos cannot be asked that cheaply: only a refusal already seen counts.
 */
async function gatewayRefuses(key: string, id: string, cls: ModelClass): Promise<boolean> {
  const at = probeId(key, id);
  const known = gatewayProbes.get(at);
  if (known && Date.now() - known.at < (known.refused ? 300_000 : 86_400_000)) {
    return known.refused;
  }
  if (cls === "video" || (cls === "image" && !isChatImageModel(id))) {
    return known?.refused ?? false;
  }
  const gateway = createGateway({ apiKey: key });
  const limits = { maxRetries: 0, abortSignal: AbortSignal.timeout(15_000) };
  let refused = false;
  try {
    if (cls === "speech") {
      await generateSpeech({ model: gateway.speechModel(id), text: "Ok.", ...limits });
    } else {
      await generateText({ model: gateway(id), prompt: "Ok.", maxOutputTokens: 1, ...limits });
    }
  } catch (err) {
    // Anything else (a limit of the model, the network) is not the tier: the run will tell.
    refused = freeTierRefusal(err) !== null;
  }
  gatewayProbes.set(at, { refused, at: Date.now() });
  return refused;
}

/** The realtime speech model a live conversation runs on; a setting of the install may name another. */
const CONVERSATION_MODEL = env.conversationModel || "gpt-realtime";

/**
 * What a live conversation with a wizard runs on: the tenant's own OpenAI key, until a class of
 * its own exists on the Models page and on the account's credits.
 */
export async function conversationAccess(): Promise<{ apiKey: string; model: string }> {
  const cfg = await config();
  if (!cfg.keys.openai) {
    throw new ModelUnavailableError(note("noOpenaiApiKey"));
  }
  return { apiKey: cfg.keys.openai, model: CONVERSATION_MODEL };
}

/** Whether a live conversation can be started here. */
export async function conversationAvailable(): Promise<boolean> {
  return Boolean((await config()).keys.openai);
}

/** Why the own AI Gateway key cannot reach what a class runs on, or null. */
async function gatewayProblem(cls: ModelClass, ref: string): Promise<Said | null> {
  const { provider, id } = parse(ref);
  const key = (await config()).keys.gateway;
  if (!key || (provider !== null && provider !== "gateway")) {
    return null;
  }
  return (await gatewayRefuses(key, id, cls)) ? freeTierText(id) : null;
}

/**
 * Whether a class can run here, found out without calling it: null, or what the person reads.
 * A class the gateway serves counts as there unless its catalog leaves it unbound.
 */
export async function classProblem(cls: ModelClass): Promise<Said | null> {
  try {
    const resolved =
      cls === "image"
        ? await imageModel()
        : cls === "video"
          ? await videoModel()
          : cls === "speech"
            ? await speechModel()
            : cls === "audio"
              ? (await listenerModel()).resolved
              : await textModel(cls);
    if (resolved.metered) {
      const catalog = await classCatalog();
      const named = creditsModelOf((await config()).settings.bindings[cls]);
      if (named) {
        return catalog?.models && !catalog.models.some((m) => m.id === named)
          ? note("modelNotAvailableAccount")
          : null;
      }
      return catalog?.classes && !catalog.classes[cls] ? note("accountNoModelSet") : null;
    }
    const client = harness(resolved.vendor);
    if (client && (await detectHarness(client.id))?.auth === "none") {
      return signedOut(client);
    }
    return resolved.gateway ? await gatewayProblem(cls, resolved.ref) : null;
  } catch (err) {
    if (err instanceof ModelUnavailableError) {
      return saidOf(err);
    }
    throw err;
  }
}

/** Clients that can make a film: they work in a folder of their own with a shell and skills. */
const FILM_CLIENTS = new Set<string>(["claude"]);

/**
 * The installed client a film step of this class runs on, and the model it names; or why a
 * film cannot be made here. Films never run on credits or keys: one takes a client many minutes.
 */
export async function filmClient(
  cls: TextClass,
): Promise<{ client: Harness; alias: string } | { problem: Said }> {
  const cfg = await config();
  const client = managed ? null : harness(cfg.settings.source);
  if (!client || !FILM_CLIENTS.has(client.id)) {
    return {
      problem: note("claudeCodeMakesFilms"),
    };
  }
  const status = await detectHarness(client.id);
  if (!status?.version) {
    return { problem: notInstalled(client) };
  }
  if (status.auth === "none") {
    return { problem: signedOut(client) };
  }
  // A class that thinks on Apple Intelligence makes its films on the client's model of the class.
  const ref = ownRef(cfg, cls);
  return {
    client,
    alias: ref.startsWith(`${client.id}/`) ? ref.slice(client.id.length + 1) : client.classes[cls],
  };
}

/** Whether any text model can answer at all: the studio says so before the first chat turn. */
export async function hasTextModel(): Promise<boolean> {
  try {
    await textModel("standard");
    return true;
  } catch {
    return false;
  }
}

/**
 * How a class runs, as the settings show it. `client`: an installed AI client (`by` its id);
 * `key`: an own API key (`by` the provider); `local`: a model on this machine; `credits`: the
 * credits; `none`: nothing, `problem` says why.
 */
export interface ClassWay {
  kind: "client" | "key" | "local" | "credits" | "none";
  by: string | null;
  ref: string;
  problem: Said | null;
}

export async function classWays(): Promise<Record<ModelClass, ClassWay>> {
  const cfg = await config();
  const ways = {} as Record<ModelClass, ClassWay>;
  for (const cls of MODEL_CLASSES) {
    const ref = ownRef(cfg, cls);
    if (ref) {
      const { provider, vendor } = parse(ref);
      const client = provider === null && isHarnessVendor(vendor);
      ways[cls] = {
        kind: client ? "client" : isLocalProvider(provider) ? "local" : "key",
        by: client
          ? vendor
          : isLocalProvider(provider)
            ? provider
            : providerOfRef(ref) === "gateway" && !cfg.keys.gateway
              ? vendor
              : providerOfRef(ref),
        ref,
        problem: client
          ? null
          : provider === "apple"
            ? await appleProblem(cls)
            : await gatewayProblem(cls, ref),
      };
      continue;
    }
    let problem: Said | null = null;
    const access = await creditAccess(cfg, creditsChosen(cfg, cls)).catch((err: Error) => {
      problem = saidOf(err);
      return null;
    });
    ways[cls] = access
      ? {
          kind: "credits",
          by: null,
          ref:
            creditsModelOf(cfg.settings.bindings[cls]) ??
            (await classCatalog())?.classes[cls]?.model ??
            "",
          problem: null,
        }
      : { kind: "none", by: null, ref: "", problem: problem ?? missingText(cfg, cls) };
  }
  return ways;
}

/**
 * Why this Mac's models do not take a class right now; null while they do. Text needs Apple
 * Intelligence switched on. A voice note needs only the Mac (macOS 26 on Apple silicon, the
 * helper; the system fetches a language on its first note), and ffmpeg for a recording it
 * cannot read itself: a browser's WebM or Ogg.
 */
async function appleProblem(cls: ModelClass): Promise<Said | null> {
  const status = await appleStatus();
  if (cls !== "audio") {
    return status.available ? null : appleUnavailableNote(status);
  }
  if (!status.supported || status.reason === "missing") {
    return appleUnavailableNote(status);
  }
  return (await hasFfmpeg()) ? null : note("macNeedsFfmpegTranscribe");
}

/** At start the ways are asked once, so a model the key cannot reach shows before a run meets it. */
export async function checkModelsAtStart() {
  for (const [cls, way] of Object.entries(await classWays())) {
    if (way.kind !== "none" && way.problem) {
      console.warn(`models: ${cls}: ${saidText(way.problem, "en")}`);
    }
  }
}

/** The ways with their problems in a language, for whoever reads them. */
export function waysIn(ways: Record<ModelClass, ClassWay>, lang: Lang) {
  return Object.fromEntries(
    Object.entries(ways).map(([cls, way]) => [
      cls,
      { ...way, problem: way.problem && saidText(way.problem, lang) },
    ]),
  ) as Record<ModelClass, Omit<ClassWay, "problem"> & { problem: string | null }>;
}

/** What the settings page shows: the choices, which keys are there (never the keys), and the ways. */
export async function modelSettings(lang: Lang = "en") {
  const cfg = await config();
  return {
    source: cfg.settings.source,
    bindings: cfg.settings.bindings,
    ollamaUrl: cfg.settings.ollamaUrl ?? env.ollamaUrl,
    creditFallback: cfg.settings.creditFallback !== false,
    keys: Object.fromEntries(LOCAL_KEYS.map((k) => [k, Boolean(cfg.keys[k])])) as Record<
      LocalKey,
      boolean
    >,
    ways: waysIn(await classWays(), lang),
    /** Apple Intelligence on this Mac: shown where the machine can run it, picked once it answers. */
    apple: managed ? null : await appleStatus(),
    /** What a class costs on the credits, where they are at hand. */
    prices: (await classCatalog())?.classes ?? null,
    /** The media models the credits pay for, which a binding may name. */
    creditModels: (await classCatalog())?.models ?? [],
  };
}

// --- Checking a key ------------------------------------------------------------------

/** A cheap authenticated call: whether the provider takes the key. Nothing is generated. */
export async function checkKey(
  name: LocalKey,
  key: string,
  lang: Lang = "en",
): Promise<{ ok: boolean; message: string | null }> {
  const requests: Record<LocalKey, [string, Record<string, string>]> = {
    openai: ["https://api.openai.com/v1/models", { authorization: `Bearer ${key}` }],
    anthropic: [
      "https://api.anthropic.com/v1/models?limit=1",
      { "x-api-key": key, "anthropic-version": "2023-06-01" },
    ],
    google: [
      "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1",
      { "x-goog-api-key": key },
    ],
    fal: [
      "https://api.fal.ai/v1/models?endpoint_id=fal-ai/flux/schnell",
      { authorization: `Key ${key}` },
    ],
    elevenlabs: ["https://api.elevenlabs.io/v1/models", { "xi-api-key": key }],
    replicate: ["https://api.replicate.com/v1/account", { authorization: `Bearer ${key}` }],
    gateway: ["https://ai-gateway.vercel.sh/v1/credits", { authorization: `Bearer ${key}` }],
  };
  const [url, headers] = requests[name];
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
    if (res.ok) {
      return { ok: true, message: null };
    }
    const body = await res.text().catch(() => "");
    // A key restricted to some permissions is still a key the provider knows.
    if (res.status === 403 || /missing_permissions/.test(body)) {
      return { ok: true, message: null };
    }
    return {
      ok: false,
      message:
        res.status === 401
          ? serverText(lang, "keyUnknown")
          : serverText(lang, "providerError", { status: String(res.status) }),
    };
  } catch {
    return {
      ok: false,
      message: serverText(lang, "providerUnreachable"),
    };
  }
}

/** What a key or a local model of the setup now does: whether it works, and the text model it runs. */
export interface SetupOutcome {
  ok: boolean;
  message: string | null;
  /** The model the Standard class now runs on without credits; null where none. */
  text: string | null;
}

/**
 * Of these bindings, the ones for classes that run on nothing of this machine's own yet: a key
 * the setup tested is a key in use. Classes on a key, a client or a local model keep theirs —
 * choosing between them is for the settings.
 */
function freeClasses(
  bindings: Partial<Record<ModelClass, string>>,
): Partial<Record<ModelClass, string>> {
  return Object.fromEntries(
    Object.entries(bindings).filter(([cls]) => !ownRef(local, cls as ModelClass)),
  );
}

const setupOutcome = (): SetupOutcome => ({
  ok: true,
  message: null,
  text: ownRef(local, "standard") || null,
});

/** The setup's test of one key: checked with the provider, stored, and put to use. */
export async function setUpKey(
  name: LocalKey,
  key: string | undefined,
  lang: Lang = "en",
): Promise<SetupOutcome> {
  const value = key?.trim() || local.keys[name];
  if (!value) {
    return { ok: false, message: serverText(lang, "keyUnknown"), text: null };
  }
  const checked = await checkKey(name, value, lang);
  if (!checked.ok) {
    return { ...checked, text: null };
  }
  const provider = providerInfo(name);
  const offered: Partial<Record<ModelClass, string>> = { ...provider?.text };
  for (const [cap, models] of Object.entries(provider?.models ?? {}) as [
    ModelCapability,
    ModelOption[] | undefined,
  ][]) {
    const first = models?.[0]?.ref;
    if (cap !== "text" && first) {
      for (const cls of CAPABILITY_CLASSES[cap]) {
        offered[cls] = first;
      }
    }
  }
  // Free before the key is stored: a key can make a default reachable that it would not name.
  await saveLocalModels({ keys: { [name]: value }, bindings: freeClasses(offered) });
  return setupOutcome();
}

/** The setup's test of Ollama: it answers at the address and has a model to think with. */
export async function setUpOllama(url: string, lang: Lang = "en"): Promise<SetupOutcome> {
  const base = url.trim().replace(/\/+$/, "");
  let models: string[];
  try {
    const res = await fetch(`${base}/models`, { signal: AbortSignal.timeout(5_000) });
    const body = (await res.json()) as { data?: { id: string }[] };
    models = (body.data ?? []).map((m) => m.id);
  } catch {
    return { ok: false, message: serverText(lang, "ollamaUnreachable"), text: null };
  }
  if (!models.length) {
    return { ok: false, message: serverText(lang, "ollamaNoModel"), text: null };
  }
  const bound = local.settings.bindings.standard?.replace(/^ollama:/, "");
  const model = bound && models.includes(bound) ? bound : models[0];
  const text = Object.fromEntries(TEXT_CLASSES.map((c) => [c, `ollama:${model}`]));
  await saveLocalModels({ ollamaUrl: base, bindings: freeClasses(text) });
  return setupOutcome();
}

// --- Pricing ---------------------------------------------------------------

interface CatalogEntry {
  id: string;
  pricing?: Record<string, unknown>;
  context_window?: number;
}

let catalog = new Map<string, CatalogEntry>();
let catalogLoadedAt = 0;

/** Public prices of the AI Gateway: what a runtime that runs alone shows as the cost of a run. */
export async function loadCatalog(force = false): Promise<void> {
  if (!force && Date.now() - catalogLoadedAt < 6 * 3600_000 && catalog.size) {
    return;
  }
  try {
    const res = await fetch("https://ai-gateway.vercel.sh/v1/models", {
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json()) as { data: CatalogEntry[] };
    catalog = new Map(body.data.map((m) => [m.id, m]));
    catalogLoadedAt = Date.now();
  } catch {
    // Prices fall back to conservative defaults below.
  }
}

/** The AI Gateway's prices, by its id of the model: what an own key of the same model costs too. */
function priceOf(ref: string): Record<string, unknown> {
  const { provider, id } = parse(ref);
  return (
    catalog.get(provider === null || provider === "gateway" ? id : `${provider}/${id}`)?.pricing ??
    {}
  );
}

/** A model's context window in tokens, as the AI Gateway's catalog gives it; null where unknown. */
export function contextWindowOf(ref: string): number | null {
  const { provider, id } = parse(ref);
  const entry = catalog.get(provider === null || provider === "gateway" ? id : `${provider}/${id}`);
  return typeof entry?.context_window === "number" ? entry.context_window : null;
}

const n = (v: unknown, fallback: number) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
};

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
}

export function usageOf(u: any): TokenUsage {
  return {
    inputTokens: u?.inputTokens ?? 0,
    outputTokens: u?.outputTokens ?? 0,
    cachedInputTokens: u?.cachedInputTokens ?? u?.inputTokenDetails?.cacheReadTokens ?? 0,
  };
}

/** A class's model as Mastra's `Agent` takes it: the AI SDK's model, typed by Mastra's own copy of it. */
export function agentModel(resolved: ResolvedModel<unknown>): MastraModelConfig {
  return resolved.model as unknown as MastraModelConfig;
}

/**
 * What an agent's call used over all its steps: `totalUsage` where Mastra's result has it, else
 * `usage`. Takes a stream's promises and a finished call's values alike.
 */
export async function totalUsage(out: object): Promise<unknown> {
  const result = out as { totalUsage?: unknown; usage?: unknown };
  return (await result.totalUsage) ?? (await result.usage);
}

/** Provider cost of a text call a runtime that runs alone made; the gateway books the others itself. */
export function costOf(resolved: ResolvedModel<unknown>, usage: any): number {
  // An installed client answers on its subscription: nothing to book.
  return resolved.metered || isHarnessVendor(resolved.vendor)
    ? 0
    : tokenCostUsd(resolved.ref, usageOf(usage));
}

export function tokenCostUsd(ref: string, usage: TokenUsage | undefined): number {
  if (!usage) {
    return 0;
  }
  const p = priceOf(ref);
  const input = n(p.input, 0.000003);
  const output = n(p.output, 0.000015);
  const cached = n(p.input_cache_read, input / 10);
  const cachedTokens = usage.cachedInputTokens ?? 0;
  const freshInput = Math.max(0, (usage.inputTokens ?? 0) - cachedTokens);
  return freshInput * input + cachedTokens * cached + (usage.outputTokens ?? 0) * output;
}

export function imageCostUsd(ref: string): number {
  const p = priceOf(ref);
  const tiers = p.image_dimension_quality_pricing as { size: string; cost: string }[] | undefined;
  const tier = tiers?.find((t) => t.size === "default") ?? tiers?.[0];
  return n(tier?.cost ?? p.image, 0.08);
}

export function videoCostUsd(
  ref: string,
  seconds: number,
  resolution: VideoResolution = "720p",
): number {
  const p = priceOf(ref);
  const tiers = p.video_duration_pricing as
    | { cost_per_second: string; resolution?: string; audio?: boolean }[]
    | undefined;
  // We render at 720p or 480p with sound: price that tier where the catalog has one; else the
  // dearest below 4K, so the estimate is never short.
  const exact = tiers?.filter((t) => t.resolution === resolution) ?? [];
  const usable = exact.length ? exact : (tiers?.filter((t) => t.resolution !== "4k") ?? []);
  const withAudio = usable.filter((t) => t.audio !== false);
  const pick = withAudio.length ? withAudio : usable;
  const perSecond = pick.length ? Math.max(...pick.map((t) => n(t.cost_per_second, 0))) : 0.4;
  return perSecond * seconds;
}

/** Speech is priced per character read, or per audio token (about 25 a second, 15 characters). */
export function speechCostUsd(ref: string, characters: number): number {
  const p = priceOf(ref);
  if (p.speech_input_character_cost !== undefined) {
    return n(p.speech_input_character_cost, 0.00003) * characters;
  }
  return n(p.audio_output_token_cost, 0.00001) * Math.ceil((characters / 15) * 25);
}

export const WEB_SEARCH_COST_USD = 0.01;

/** A transcript, priced by the minute; the gateway's catalog has no transcription prices. */
export function transcriptionCostUsd(seconds: number): number {
  return (seconds / 60) * 0.006;
}
