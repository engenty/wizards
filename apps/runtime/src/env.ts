import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { findChrome } from "./render/browser-path.js";
import { enginesDir } from "./sandbox/install.js";

/** Load `.env.local` then `.env` without overriding the real environment. */
function loadEnvFiles() {
  for (const name of [".env.local", ".env"]) {
    const path = resolve(process.cwd(), name);
    if (!existsSync(path)) {
      continue;
    }
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!match || process.env[match[1]] !== undefined) {
        continue;
      }
      process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  }
}
loadEnvFiles();

const str = (key: string, fallback = ""): string => process.env[key]?.trim() || fallback;

/** A comma-separated list. */
const list = (key: string): string[] =>
  str(key)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
const num = (key: string, fallback: number): number => {
  const v = Number(process.env[key]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

const dataDir = resolve(str("DATA_DIR", "data"));

/**
 * Signs cookies and links and derives the store's encryption key. A runtime that runs alone
 * makes its own once and keeps it in the data folder.
 */
function appSecret(): string {
  const given = str("APP_SECRET");
  if (given) {
    return given;
  }
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, "secret");
  if (!existsSync(file)) {
    writeFileSync(file, randomBytes(32).toString("hex"), { mode: 0o600 });
  }
  return readFileSync(file, "utf8").trim();
}

const manageUrl = str("MANAGE_URL").replace(/\/$/, "");
const port = num("API_PORT", 24368);
/** From source the Vite dev server on :5181 serves the pages; built, this server does. */
const fromSource = import.meta.url.endsWith(".ts");
const sandboxImage = str("SANDBOX_IMAGE", "engenty-sandbox:latest");

const ROLES = ["studio", "doors", "web", "runner", "all"] as const;
type Role = (typeof ROLES)[number];

function role(): Role {
  const given = str("RUNTIME_ROLE", "all");
  if (!ROLES.includes(given as Role)) {
    throw new Error(`RUNTIME_ROLE must be one of ${ROLES.join(", ")}, not "${given}"`);
  }
  return given as Role;
}

/** The origin people open, e.g. https://wizards.localhost — auth callbacks and links use it. */
const appUrl = str(
  "APP_URL",
  fromSource ? "http://localhost:5181" : `http://localhost:${port}`,
).replace(/\/$/, "");

export const env = {
  production: process.env.NODE_ENV === "production",
  /** Running from source: Vite serves the pages, this server only `/api`. */
  fromSource,
  port,
  /** Listen address; a runtime that runs alone stays on the loopback interface. */
  host: str("API_HOST", manageUrl ? "0.0.0.0" : "127.0.0.1"),
  /**
   * What this process does. `studio`: the makers' half (authoring, publishing, sign-in, MCP, the
   * studio's pages). `doors`: the customers' half (wizard pages, their API, shared results, the
   * plugins' public routes). `web`: both halves. `runner`: takes the runs that wait and drives
   * them (it serves the routes too, for what the web hands it). `all`: everything in one process
   * (a runtime that runs alone). docs/plans/runner-process.md.
   */
  role: role(),
  /** Which parts this process serves, from its role. */
  serves: {
    studio: ["studio", "web", "runner", "all"].includes(role()),
    doors: ["doors", "web", "runner", "all"].includes(role()),
    runner: ["runner", "all"].includes(role()),
  },
  runner: {
    /** This runner's name in the control database; a new one each start. */
    id: `${hostname()}-${randomBytes(3).toString("hex")}`,
    /** Where the web reaches this runner (the browser's screen of a run it holds). */
    url: str("RUNNER_URL").replace(/\/$/, ""),
  },
  appUrl,
  /**
   * Where the wizards' pages live (`/w/<token>`, `/s/<token>`, the embed script): the doors'
   * origin, when they are served apart from the studio. Links to a wizard, a result or a public
   * file carry it. Default: APP_URL, the same origin.
   */
  publicUrl: str("PUBLIC_URL", appUrl).replace(/\/$/, ""),
  /** More host names this server answers under, besides APP_URL's and the loopback names. */
  allowedHosts: list("ALLOWED_HOSTS"),
  dataDir,
  /** The control database; empty = a libSQL file in the data folder. */
  databaseUrl: str("DATABASE_URL", ""),
  databaseAuthToken: str("DATABASE_AUTH_TOKEN"),
  /** Tenant databases on a libSQL server: `{tenant}` is replaced by the tenant id. Empty = files. */
  tenantDbUrlTemplate: str("TENANT_DB_URL_TEMPLATE"),
  tenantDbAuthToken: str("TENANT_DB_AUTH_TOKEN", str("DATABASE_AUTH_TOKEN")),
  authSecret: appSecret(),
  /** Where OAuth providers send people back after connecting an account; default <APP_URL>/api/connect/callback. */
  connectRedirectUrl: str("CONNECT_REDIRECT_URL"),
  /** Encrypts connected accounts and kept browser sessions; falls back to the app secret. */
  storeKey: str("STORE_ENC_KEY"),
  devLogin: process.env.NODE_ENV !== "production" && str("DEV_LOGIN") === "1",
  /**
   * `1`: the studio assistant's developer mode may be switched on here (steps, tools, prompt,
   * the turns' events). A managed runtime offers it to the platform's admins instead.
   */
  assistantDev: str("ASSISTANT_DEV") === "1",

  /**
   * The Manage-App this runtime belongs to. Set = people sign in there, tenants come from its
   * tokens and model calls go through its gateway. Empty = the runtime runs alone with one tenant.
   */
  manage: {
    url: manageUrl,
    gatewayUrl: str("GATEWAY_URL").replace(/\/$/, ""),
    clientId: str("MANAGE_CLIENT_ID"),
    clientSecret: str("MANAGE_CLIENT_SECRET"),
    /** Authenticates this runtime at the Manage-App and the gateway, and the Manage-App here. */
    serviceKey: str("MANAGE_SERVICE_KEY"),
  },
  /**
   * A runtime that runs alone answers the studio only with a cookie, set by opening
   * `/api/local/enter?k=<key>` once. The desktop app passes the key; else one is printed at start.
   */
  local: {
    accessKey: str("LOCAL_ACCESS_KEY"),
    /** The Manage-App a local runtime links an account to (credits, publishing). */
    accountUrl: str("ACCOUNT_URL", "https://account.engenty.ai").replace(/\/$/, ""),
    gatewayUrl: str("ACCOUNT_GATEWAY_URL", "https://gateway.engenty.ai").replace(/\/$/, ""),
    /** The cloud runtime "publish to the cloud" sends wizards to. */
    cloudUrl: str("CLOUD_URL", "https://engenty.ai").replace(/\/$/, ""),
  },

  /**
   * The marketplace (docs/marketplace-contract.md): searched live, its starters and what people
   * starred kept for offline use. `off` = none.
   */
  marketplace: {
    url: str("MARKETPLACE_URL", "https://engenty.ai/wizards")
      .replace(/^off$/, "")
      .replace(/\/+$/, ""),
  },

  aiGatewayKey: str("AI_GATEWAY_API_KEY"),
  openaiKey: str("OPENAI_API_KEY"),
  /** The realtime speech model of live conversations; empty: the runtime's default. */
  conversationModel: str("CONVERSATION_MODEL"),
  anthropicKey: str("ANTHROPIC_API_KEY"),
  googleKey: str("GOOGLE_GENERATIVE_AI_API_KEY"),
  falKey: str("FAL_KEY"),
  elevenlabsKey: str("ELEVENLABS_API_KEY"),
  replicateKey: str("REPLICATE_API_TOKEN"),
  /** TypeSafe's own API, for the classifier that checks what a search found (Jev). */
  typesafeKey: str("TYPESAFE_API_KEY"),
  /**
   * `off`: agent steps get no `browser_run_fast`, where a decision model would pick each click
   * on a page. Otherwise they get it wherever a decision model can be reached.
   */
  browserFastLoop: str("BROWSER_FAST_LOOP") !== "off",
  ollamaUrl: str("OLLAMA_URL", "http://127.0.0.1:11434/v1"),

  /** What each model class runs on when this runtime resolves classes itself (own keys, Ollama). */
  models: {
    classifier: str("MODEL_CLASSIFIER", "anthropic/claude-haiku-4.5"),
    standard: str("MODEL_STANDARD", "anthropic/claude-haiku-4.5"),
    high: str("MODEL_HIGH", "anthropic/claude-sonnet-5.5"),
    highest: str("MODEL_HIGHEST", "anthropic/claude-sonnet-5.5"),
    image: str("MODEL_IMAGE", "google/gemini-3.1-flash-image"),
    video: str("MODEL_VIDEO", "google/veo-3.1-fast-generate-001"),
    audio: str("MODEL_AUDIO", "google/gemini-3.5-flash-lite"),
    speech: str("MODEL_SPEECH", "google/gemini-3.8-flash-tts"),
    /** Vectors for a project's document index; not a class a step names. */
    embedding: str("MODEL_EMBEDDING", "openai/text-embedding-3-small"),
  },

  /**
   * Reverse geocoder for location fields (Nominatim's `/reverse`); unset = coordinates only,
   * nothing about where a person stands leaves this server.
   */
  geocoderUrl: str("GEOCODER_URL"),
  /** CDP endpoint of a Chromium (the engenty-browser image); else a local Chrome is launched. */
  browserCdpUrl: str("BROWSER_CDP_URL"),
  /** The browser the setup and `wizards doctor` found (render/browser-path.ts). */
  chromePath: str(
    "CHROME_PATH",
    findChrome({ PATH: process.env.PATH }) ??
      (process.platform === "darwin"
        ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        : "/usr/bin/chromium"),
  ),
  /** Encodes widget animations to MP4; without it widgets offer no video. */
  ffmpegPath: str("FFMPEG_PATH", "ffmpeg"),
  /**
   * The engine that runs an agent's shell and code (sandbox/index.ts): `off`, an engine's name,
   * or empty for the first one that is ready here.
   */
  sandbox: str("SANDBOX_ENABLED", "1") === "1" ? str("SANDBOX").toLowerCase() : "off",
  sandboxImage,
  /** Where `wizards sandbox add` installs the engines that aren't part of the runtime. */
  sandboxEngines: enginesDir(),
  /** Hosts an agentOS sandbox reaches besides the npm and PyPI registries: `api.example.com`. */
  sandboxHosts: list("SANDBOX_ALLOW_HOSTS"),

  /** Assets and workspace files in an S3-compatible bucket (R2); empty = the data folder. */
  s3: {
    endpoint: str("S3_ENDPOINT").replace(/\/$/, ""),
    bucket: str("S3_BUCKET"),
    region: str("S3_REGION", "auto"),
    accessKeyId: str("S3_ACCESS_KEY_ID"),
    secretAccessKey: str("S3_SECRET_ACCESS_KEY"),
  },

  turnstile: { siteKey: str("TURNSTILE_SITE_KEY"), secret: str("TURNSTILE_SECRET_KEY") },

  /**
   * The mobile app (the apps repo engenty-wizards-apps, mobile/): a phone opens this runtime's `/w/` and `/s/` links in it.
   * Served as /.well-known/apple-app-site-association and /.well-known/assetlinks.json.
   */
  mobile: {
    /** `<team id>.<bundle id>` of the iOS apps; empty = no file. */
    iosAppIds: list("MOBILE_IOS_APP_IDS"),
    androidPackage: str("MOBILE_ANDROID_PACKAGE", "ai.engenty.wizards"),
    /** SHA-256 fingerprints of the Android app's signing certificates; empty = no file. */
    androidCertSha256: list("MOBILE_ANDROID_CERT_SHA256"),
  },

  /** Plugins (docs/content/dev/plugins). Code in these folders runs with the runtime's own rights. */
  plugins: {
    /** Folders to look in, besides the `modules/` this runtime ships with. */
    dirs: list("PLUGINS_DIR").map((dir) => resolve(dir)),
    /** Managed: plugins every tenant has. The Manage-App switches further ones on per tenant. */
    defaults: list("PLUGINS_DEFAULT"),
    /**
     * A plugin loads again when one of its files changes. Default: on where the runtime runs
     * alone. A runtime of a Manage-App never reloads: it would hit every tenant.
     */
    watch: !manageUrl && str("PLUGINS_WATCH", "1") === "1",
    /** Plugins' jobs (`server.every`) run. Off (`PLUGIN_JOBS=0`) where another process runs them. */
    jobs: str("PLUGIN_JOBS", "1") === "1",
    /**
     * Public keys (Ed25519, SPKI DER in base64) whose signature a Pro module may carry, besides
     * the one this runtime ships with (plugins/pro-keys.ts). For testing packages signed elsewhere.
     */
    proKeys: list("PRO_MODULES_KEYS"),
  },

  limits: {
    visitorRunsPerHour: num("LIMIT_VISITOR_RUNS_PER_HOUR", 6),
    defaultDailyRuns: num("LIMIT_DEFAULT_DAILY_RUNS", 50),
    /** Runs of one tenant that work at the same time; the Manage-App can set another number per tenant. */
    concurrentRuns: num("LIMIT_CONCURRENT_RUNS", 4),
    /**
     * Projects a tenant works with. One: the studio shows no project switcher. The Manage-App
     * can set another number per tenant; the database holds any number either way.
     */
    projects: num("LIMIT_PROJECTS", 1),
    /** Wizards a local install may keep on this runtime in its synced project. */
    syncedWizards: num("LIMIT_SYNCED_WIZARDS", 50),
    /** End-user runs (no account) and their shared links are deleted after this many days. */
    resultTtlDays: num("RESULT_TTL_DAYS", 7),
    /** What a wizard keeps for a person (lists, files, accounts) goes when unused this long. */
    storeTtlDays: num("STORE_TTL_DAYS", 400),
  },
};

/**
 * The path APP_URL ends in: `/wizards` for https://example.com/wizards, empty for an origin alone. The proxy
 * may strip it or not, so the server takes both; what it writes into a cookie or a redirect
 * carries it.
 */
export const basePath = new URL(env.appUrl).pathname.replace(/\/+$/, "");

if (env.production) {
  const required = [
    "APP_URL",
    ...(manageUrl ? ["APP_SECRET", "MANAGE_SERVICE_KEY", "MANAGE_CLIENT_ID"] : []),
  ];
  const missing = required.filter((k) => !process.env[k]?.trim());
  if (missing.length) {
    throw new Error(`Missing required environment in production: ${missing.join(", ")}`);
  }
}

export type Env = typeof env;
