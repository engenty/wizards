import type { Lang, ModelClass, TextClass } from "./definition.js";
import { type Line, type Texts, textOf } from "./texts.js";

/**
 * What a wizard asks models for, as a person thinks of it. Each stands for model classes; the
 * names are the marketplace's capabilities.
 */
export const MODEL_CAPABILITIES = ["text", "image", "video", "speech", "listening"] as const;
export type ModelCapability = (typeof MODEL_CAPABILITIES)[number];

export const CAPABILITY_CLASSES: Record<ModelCapability, readonly ModelClass[]> = {
  text: ["classifier", "standard", "high", "highest"],
  image: ["image"],
  video: ["video"],
  speech: ["speech"],
  listening: ["audio"],
};

export function capabilityOf(cls: ModelClass): ModelCapability {
  return (Object.keys(CAPABILITY_CLASSES) as ModelCapability[]).find((c) =>
    CAPABILITY_CLASSES[c].includes(cls),
  ) as ModelCapability;
}

/**
 * A binding that sends a class to the credits of the account (or of the team in the cloud),
 * whatever keys are there; engenty picks the model. `credits:<model>` names the model, as the
 * gateway lists it (`fal:fal-ai/flux/schnell`, `elevenlabs:eleven_multilingual_v2`,
 * `google/veo-3.1-fast-generate-001`).
 */
export const CREDITS = "credits";
const CREDITS_PREFIX = `${CREDITS}:`;

/** A binding to the credits: the class's model (`credits`) or a model named (`credits:<id>`). */
export function isCreditsRef(ref: string | undefined): boolean {
  return ref === CREDITS || Boolean(ref?.startsWith(CREDITS_PREFIX));
}

/** The model a credits binding names; null where engenty picks it. */
export function creditsModelOf(ref: string | undefined): string | null {
  return ref?.startsWith(CREDITS_PREFIX) ? ref.slice(CREDITS_PREFIX.length) || null : null;
}

export function creditsRef(model: string | null): string {
  return model ? `${CREDITS_PREFIX}${model}` : CREDITS;
}

/** A media model the credits pay for, as the model-gateway lists it (`/v1/models`, `models`). */
export interface CreditModel {
  id: string;
  name: string;
  /** Who serves it: `ai-gateway`, `fal`, `elevenlabs`. */
  source: string;
  /** Who made it: `google`, `bfl`, `fal`, `elevenlabs` … */
  provider: string;
  kind: "image" | "video" | "speech" | "transcription";
  creditsPerImage?: number;
  creditsPerSecond?: number;
  creditsPer1kCharacters?: number;
  creditsPerMinute?: number;
}

/** The capability a credit model serves. */
export function capabilityOfKind(kind: CreditModel["kind"]): ModelCapability {
  return kind === "transcription" ? "listening" : kind;
}

/** The providers whose API key a person can bring. */
export const PROVIDER_IDS = [
  "openai",
  "anthropic",
  "google",
  "fal",
  "elevenlabs",
  "replicate",
  "gateway",
] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

const PROVIDER_EN = {
  "about.openai": "GPT models, GPT Image and voices.",
  fast: "fast",
  thorough: "thorough",
  versatile: "versatile",
  lowCost: "low cost",
  fastLowCost: "fast, low cost",
  "about.anthropic": "The Claude models.",
  strongest: "strongest",
  "about.google": "Gemini, Veo for video and voices – one key from AI Studio.",
  fastEditsPhotos: "fast, edits photos",
  bestQuality: "best quality",
  withSound: "with sound",
  "about.fal":
    "Hundreds of image, video and audio models with one key: FLUX, Recraft, Veo, Luma, MiniMax.",
  highQuality: "high quality",
  graphicsLogosTextIn: "graphics, logos, text in images",
  photorealistic: "photorealistic",
  "about.elevenlabs": "Natural voices in many languages and accurate transcripts.",
  naturalManyLanguages: "natural, many languages",
  expressive: "expressive",
  veryAccurate: "very accurate",
  "about.replicate": "Open image and video models, billed per run.",
  "about.gateway": "One key for many providers’ models, billed by Vercel.",
} as const satisfies Record<string, Line>;
/** A line about a provider or one of its models, in `PROVIDER_TEXTS`. */
export type ProviderWords = keyof typeof PROVIDER_EN;

const PROVIDER_DE: Partial<Record<ProviderWords, Line>> = {
  "about.openai": "GPT-Modelle, GPT Image und Stimmen.",
  fast: "schnell",
  thorough: "gründlich",
  versatile: "vielseitig",
  lowCost: "günstig",
  fastLowCost: "schnell, günstig",
  "about.anthropic": "Die Claude-Modelle.",
  strongest: "am stärksten",
  "about.google": "Gemini, Veo für Videos und Stimmen – ein Key aus dem AI Studio.",
  fastEditsPhotos: "schnell, bearbeitet Fotos",
  bestQuality: "beste Qualität",
  withSound: "mit Ton",
  "about.fal":
    "Hunderte Bild-, Video- und Audio-Modelle mit einem Key: FLUX, Recraft, Veo, Luma, MiniMax.",
  highQuality: "hohe Qualität",
  graphicsLogosTextIn: "Grafiken, Logos, Text im Bild",
  photorealistic: "fotorealistisch",
  "about.elevenlabs": "Natürliche Stimmen in vielen Sprachen und genaue Transkripte.",
  naturalManyLanguages: "natürlich, viele Sprachen",
  expressive: "ausdrucksstark",
  veryAccurate: "sehr genau",
  "about.replicate": "Offene Bild- und Video-Modelle, abgerechnet pro Lauf.",
  "about.gateway": "Ein Key für die Modelle vieler Anbieter, abgerechnet bei Vercel.",
};

export const PROVIDER_TEXTS: Texts<ProviderWords> = { en: PROVIDER_EN, de: PROVIDER_DE };

/** A line about a provider or a model, in a language. */
export const providerText = (key: ProviderWords, lang: Lang): string =>
  textOf(PROVIDER_TEXTS, key, lang);

export interface ModelOption {
  /** The binding: `<provider>:<the provider's model id>`. */
  ref: string;
  /** The model's own name; not translated. */
  label: string;
  note?: ProviderWords;
}

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  /** One line on what it is, for someone who never heard of it. */
  about: ProviderWords;
  /** Where a person makes a key. */
  keyUrl: string;
  /** How a key looks, for the input's placeholder. */
  keyPlaceholder: string;
  /** The models offered per capability, the first one is taken when the provider is picked. */
  models: Partial<Record<ModelCapability, ModelOption[]>>;
  /** For text: the model of each class when this provider thinks. */
  text?: Record<TextClass, string>;
}

export const PROVIDERS: readonly ProviderInfo[] = [
  {
    id: "openai",
    name: "OpenAI",
    about: "about.openai",
    keyUrl: "https://platform.openai.com/api-keys",
    keyPlaceholder: "sk-…",
    text: {
      classifier: "openai:gpt-5.4-mini",
      standard: "openai:gpt-5.4-mini",
      high: "openai:gpt-5.5",
      highest: "openai:gpt-5.5",
    },
    models: {
      text: [
        { ref: "openai:gpt-5.4-mini", label: "GPT-5.4 mini", note: "fast" },
        { ref: "openai:gpt-5.5", label: "GPT-5.5", note: "thorough" },
      ],
      image: [
        { ref: "openai:gpt-image-2", label: "GPT Image 2", note: "versatile" },
        {
          ref: "openai:gpt-image-1-mini",
          label: "GPT Image 1 mini",
          note: "lowCost",
        },
      ],
      speech: [
        {
          ref: "openai:gpt-4o-mini-tts",
          label: "GPT-4o mini TTS",
          note: "lowCost",
        },
      ],
      listening: [
        {
          ref: "openai:gpt-4o-mini-transcribe",
          label: "GPT-4o mini Transcribe",
          note: "fastLowCost",
        },
        { ref: "openai:whisper-1", label: "Whisper" },
      ],
    },
  },
  {
    id: "anthropic",
    name: "Anthropic",
    about: "about.anthropic",
    keyUrl: "https://console.anthropic.com/settings/keys",
    keyPlaceholder: "sk-ant-…",
    text: {
      classifier: "anthropic:claude-haiku-4-5",
      standard: "anthropic:claude-haiku-4-5",
      high: "anthropic:claude-sonnet-5-5",
      highest: "anthropic:claude-opus-5-5",
    },
    models: {
      text: [
        {
          ref: "anthropic:claude-haiku-4-5",
          label: "Claude Haiku 4.5",
          note: "fast",
        },
        { ref: "anthropic:claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
        {
          ref: "anthropic:claude-opus-5-5",
          label: "Claude Opus 5.5",
          note: "strongest",
        },
      ],
    },
  },
  {
    id: "google",
    name: "Google Gemini",
    about: "about.google",
    keyUrl: "https://aistudio.google.com/apikey",
    keyPlaceholder: "AIza…",
    text: {
      classifier: "google:gemini-flash-lite-latest",
      standard: "google:gemini-flash-latest",
      high: "google:gemini-pro-latest",
      highest: "google:gemini-pro-latest",
    },
    models: {
      text: [
        {
          ref: "google:gemini-flash-lite-latest",
          label: "Gemini Flash-Lite",
          note: "lowCost",
        },
        { ref: "google:gemini-flash-latest", label: "Gemini Flash" },
        {
          ref: "google:gemini-pro-latest",
          label: "Gemini Pro",
          note: "thorough",
        },
      ],
      image: [
        {
          ref: "google:gemini-3.1-flash-image-preview",
          label: "Gemini 3.1 Flash Image",
          note: "fastEditsPhotos",
        },
        {
          ref: "google:gemini-3-pro-image-preview",
          label: "Gemini 3 Pro Image",
          note: "bestQuality",
        },
      ],
      video: [
        {
          ref: "google:veo-3.1-fast-generate-preview",
          label: "Veo 3.1 Fast",
          note: "withSound",
        },
        {
          ref: "google:veo-3.1-generate-preview",
          label: "Veo 3.1",
          note: "bestQuality",
        },
      ],
      speech: [{ ref: "google:gemini-3.8-flash-tts", label: "Gemini Flash TTS" }],
      listening: [{ ref: "google:gemini-flash-lite-latest", label: "Gemini Flash-Lite" }],
    },
  },
  {
    id: "fal",
    name: "fal.ai",
    about: "about.fal",
    keyUrl: "https://fal.ai/dashboard/keys",
    keyPlaceholder: "xxxxxxxx-…:…",
    models: {
      image: [
        {
          ref: "fal:fal-ai/flux/schnell",
          label: "FLUX.1 schnell",
          note: "fastLowCost",
        },
        {
          ref: "fal:fal-ai/flux-pro/v1.1",
          label: "FLUX 1.1 pro",
          note: "highQuality",
        },
        {
          ref: "fal:fal-ai/recraft/v3/text-to-image",
          label: "Recraft V3",
          note: "graphicsLogosTextIn",
        },
        {
          ref: "fal:fal-ai/imagen4/preview",
          label: "Imagen 4",
          note: "photorealistic",
        },
      ],
      video: [
        { ref: "fal:veo3/fast", label: "Veo 3 Fast", note: "withSound" },
        { ref: "fal:luma-ray-2-flash", label: "Luma Ray 2 Flash", note: "fast" },
        { ref: "fal:minimax-video", label: "MiniMax Hailuo" },
      ],
      speech: [
        {
          ref: "fal:fal-ai/minimax/speech-02-turbo",
          label: "MiniMax Speech-02 Turbo",
          note: "fast",
        },
        { ref: "fal:fal-ai/minimax/speech-02-hd", label: "MiniMax Speech-02 HD" },
      ],
      listening: [
        { ref: "fal:wizper", label: "Wizper", note: "fast" },
        { ref: "fal:whisper", label: "Whisper" },
      ],
    },
  },
  {
    id: "elevenlabs",
    name: "ElevenLabs",
    about: "about.elevenlabs",
    keyUrl: "https://elevenlabs.io/app/settings/api-keys",
    keyPlaceholder: "sk_…",
    models: {
      speech: [
        {
          ref: "elevenlabs:eleven_multilingual_v2",
          label: "Multilingual v2",
          note: "naturalManyLanguages",
        },
        {
          ref: "elevenlabs:eleven_flash_v2_5",
          label: "Flash v2.5",
          note: "fastLowCost",
        },
        {
          ref: "elevenlabs:eleven_v3",
          label: "Eleven v3",
          note: "expressive",
        },
      ],
      listening: [
        {
          ref: "elevenlabs:scribe_v2",
          label: "Scribe v2",
          note: "veryAccurate",
        },
      ],
    },
  },
  {
    id: "replicate",
    name: "Replicate",
    about: "about.replicate",
    keyUrl: "https://replicate.com/account/api-tokens",
    keyPlaceholder: "r8_…",
    models: {
      image: [
        {
          ref: "replicate:black-forest-labs/flux-schnell",
          label: "FLUX.1 schnell",
          note: "fastLowCost",
        },
        { ref: "replicate:black-forest-labs/flux-1.1-pro", label: "FLUX 1.1 pro" },
        { ref: "replicate:recraft-ai/recraft-v3", label: "Recraft V3" },
      ],
      video: [{ ref: "replicate:minimax/video-01", label: "MiniMax Video-01" }],
    },
  },
  {
    id: "gateway",
    name: "Vercel AI Gateway",
    about: "about.gateway",
    keyUrl: "https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai-gateway%2Fapi-keys",
    keyPlaceholder: "vck_…",
    text: {
      classifier: "anthropic/claude-haiku-4.5",
      standard: "anthropic/claude-haiku-4.5",
      high: "anthropic/claude-sonnet-5.5",
      highest: "anthropic/claude-sonnet-5.5",
    },
    models: {
      text: [
        {
          ref: "anthropic/claude-haiku-4.5",
          label: "Claude Haiku 4.5",
          note: "fast",
        },
        { ref: "anthropic/claude-sonnet-5.5", label: "Claude Sonnet 5.5" },
        { ref: "openai/gpt-5.5", label: "GPT-5.5" },
        { ref: "google/gemini-3.5-flash", label: "Gemini 3.5 Flash" },
      ],
      image: [{ ref: "google/gemini-3.1-flash-image", label: "Gemini 3.1 Flash Image" }],
      video: [
        {
          ref: "google/veo-3.1-fast-generate-001",
          label: "Veo 3.1 Fast",
          note: "withSound",
        },
      ],
      speech: [{ ref: "google/gemini-3.8-flash-tts", label: "Gemini Flash TTS" }],
      listening: [{ ref: "google/gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite" }],
    },
  },
];

export function providerInfo(id: string): ProviderInfo | null {
  return PROVIDERS.find((p) => p.id === id) ?? null;
}

/**
 * The provider a binding goes to: `fal:…` names it, a binding without one (`google/veo-…`) goes
 * through the AI Gateway. Null for an installed client (`codex/…`), a local model and credits.
 */
export function providerOfRef(ref: string): ProviderId | null {
  if (isCreditsRef(ref)) {
    return null;
  }
  const prefix = /^([a-z]+):/.exec(ref)?.[1];
  if (prefix) {
    return (PROVIDER_IDS as readonly string[]).includes(prefix) ? (prefix as ProviderId) : null;
  }
  return ref?.includes("/") ? "gateway" : null;
}

/** The name of a bound model as a person reads it: the offered label, else the provider's id. */
export function modelLabel(ref: string): string {
  for (const p of PROVIDERS) {
    for (const list of Object.values(p.models)) {
      const hit = list?.find((m) => m.ref === ref);
      if (hit) {
        return hit.label;
      }
    }
  }
  return ref.replace(/^[a-z]+:/, "");
}
