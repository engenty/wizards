import { totalmem } from "node:os";
import { ollamaRoot } from "./decision-model.js";
import { env } from "./env.js";
import { forgetLocalModels, localOllamaUrl } from "./models.js";

/**
 * The models in Ollama on this computer, for Settings › Models: what is there and what each can
 * do (Ollama's own `capabilities`), the models the Manage-App offers per job (`GET
 * /v1/local-models` of the account's Manage-App), and the downloads and removals the studio
 * starts. Text, search and decisions each pick their model from it.
 */

/** What a model does in the studio: a text class, the search of a space's knowledge, decisions. */
export const LOCAL_JOBS = ["text", "search", "decision"] as const;
export type LocalJob = (typeof LOCAL_JOBS)[number];

/** A model the Manage-App offers for a job; the best of a job comes first. */
export interface OfferedModel {
  name: string;
  job: LocalJob;
  /** The download, in GB. */
  size: number;
  /** About the memory it takes while it answers, in GB. */
  memory: number;
  note: { en: string; de: string };
}

/** A model Ollama holds. */
export interface InstalledModel {
  name: string;
  /** On disk, in GB. */
  size: number;
  jobs: LocalJob[];
  /** As Ollama says: `completion`, `tools`, `vision`, `audio`, `embedding`, `decision`, … */
  capabilities: string[];
  /** `mlx` or `llamacpp`; null where Ollama does not say. */
  runner: string | null;
  quantization: string | null;
  /** In memory right now. */
  loaded: boolean;
}

/** A download into Ollama: while it runs, and how it ended. */
export interface LocalDownload {
  model: string;
  done: number;
  total: number;
  /** `ollama`: Ollama does not run on this computer; else what Ollama said. */
  error: string | null;
  finished: boolean;
}

/** The share of the computer's memory a model may take and still leave room for the rest. */
const MEMORY_SHARE = 0.7;

/** The job a capability of Ollama's serves. */
const JOB_OF: Record<string, LocalJob> = {
  completion: "text",
  embedding: "search",
  decision: "decision",
};

const gb = (bytes: number) => Math.round((bytes / 1e9) * 10) / 10;

async function getJson<T>(url: string, init?: RequestInit, timeoutMs = 2000): Promise<T | null> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

interface ShowAnswer {
  capabilities?: string[];
  details?: { runner?: string; quantization_level?: string };
}

/** What `/api/show` said about a model, by its digest: it does not change while the digest stays. */
const shown = new Map<string, ShowAnswer>();

async function installedModels(root: string): Promise<InstalledModel[]> {
  const [tags, ps] = await Promise.all([
    getJson<{ models?: { name: string; size: number; digest: string }[] }>(`${root}/api/tags`),
    getJson<{ models?: { name: string }[] }>(`${root}/api/ps`),
  ]);
  const loaded = new Set((ps?.models ?? []).map((m) => m.name));
  return Promise.all(
    (tags?.models ?? []).map(async (m) => {
      let show = shown.get(m.digest);
      if (!show) {
        show =
          (await getJson<ShowAnswer>(
            `${root}/api/show`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ model: m.name }),
            },
            5000,
          )) ?? {};
        shown.set(m.digest, show);
      }
      const capabilities = show.capabilities ?? [];
      return {
        name: m.name,
        size: gb(m.size),
        jobs: LOCAL_JOBS.filter((job) => capabilities.some((c) => JOB_OF[c] === job)),
        capabilities,
        runner: show.details?.runner || null,
        quantization: show.details?.quantization_level || null,
        loaded: loaded.has(m.name),
      };
    }),
  );
}

/** The Manage-App's list at the last look: kept for an hour, asked again after five minutes when it did not answer. */
let offered: { models: OfferedModel[] | null; at: number } | null = null;

async function offeredModels(): Promise<OfferedModel[] | null> {
  if (offered && Date.now() < offered.at) {
    return offered.models;
  }
  const body = await getJson<{ models?: OfferedModel[] }>(
    `${env.local.accountUrl}/v1/local-models`,
    undefined,
    3000,
  );
  const models = body?.models?.filter((m) => LOCAL_JOBS.includes(m.job)) ?? null;
  offered = { models, at: Date.now() + (models ? 60 : 5) * 60_000 };
  return models;
}

const downloads = new Map<string, LocalDownload>();

/** While Ollama is being installed or started from the studio, and how that ended. */
let ollamaStart: { running: boolean; error: string | null } | null = null;

/** Ollama on this computer, its models and the ones to download, for the settings page. */
export async function localModels() {
  const url = await localOllamaUrl();
  const root = ollamaRoot(url);
  const { findOllama, freeGb } = await import("./cli/ollama.js");
  const version = (await getJson<{ version?: string }>(`${root}/api/version`))?.version ?? null;
  const memory = Math.round(totalmem() / 2 ** 30);
  const installed = version ? await installedModels(root) : [];
  const held = new Set(installed.map((m) => m.name));
  const list = await offeredModels();
  return {
    ollama: {
      url,
      /** Null: Ollama does not answer at the address. */
      version,
      /** The `ollama` command is on this computer, though it may not run. */
      installed: Boolean(version || findOllama()),
      /** The studio can install Ollama itself: on a Mac, as the setup does. */
      canInstall: process.platform === "darwin",
      start: ollamaStart,
    },
    /** The computer's memory and the free space for models, in GB. */
    memory,
    free: await freeGb(),
    installed,
    /** Null: the Manage-App did not answer, the list shows the installed models alone. */
    offered:
      list?.map((m) => ({
        ...m,
        installed: held.has(m.name) || held.has(`${m.name}:latest`),
        fits: m.memory <= memory * MEMORY_SHARE,
      })) ?? null,
    downloads: [...downloads.values()],
  };
}

/**
 * Pulls a model into Ollama in the background; `then` runs once it ended well. A download of
 * the same model that runs already is left to finish.
 */
export async function downloadLocalModel(model: string, then?: () => Promise<void>) {
  const running = downloads.get(model);
  if (running && !running.finished) {
    return;
  }
  const state: LocalDownload = { model, done: 0, total: 0, error: null, finished: false };
  downloads.set(model, state);
  const { pullModel } = await import("./cli/ollama.js");
  void pullModel(
    model,
    (done, total) => {
      state.done = done;
      state.total = total;
    },
    { OLLAMA_URL: await localOllamaUrl() },
  )
    .then(async () => {
      forgetLocalModels();
      state.finished = true;
      // A finished download is done; the list shows the model itself now.
      downloads.delete(model);
      await then?.();
    })
    .catch((err: Error) => {
      const unreachable = /fetch failed|ECONNREFUSED/i.test(`${err.message} ${err.cause ?? ""}`);
      state.error = unreachable ? "ollama" : err.message;
      state.finished = true;
    });
}

/** Removes a model from Ollama, and a download of it that failed; Ollama's reason where it refuses. */
export async function removeLocalModel(model: string): Promise<void> {
  downloads.delete(model);
  forgetLocalModels();
  const res = await fetch(`${ollamaRoot(await localOllamaUrl())}/api/delete`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const text = (await res.text()).trim();
    let reason = text;
    try {
      reason = (JSON.parse(text) as { error?: string }).error ?? text;
    } catch {}
    throw new Error(reason || `Ollama answered ${res.status}.`);
  }
}

/**
 * Installs Ollama where it is missing (on a Mac) and starts it, as `wizards setup` does, in the
 * background; the settings page follows `ollama.start`.
 */
export async function startLocalOllama() {
  if (ollamaStart?.running) {
    return;
  }
  const state = { running: true, error: null as string | null };
  ollamaStart = state;
  const { findOllama, installOllama, startOllama } = await import("./cli/ollama.js");
  const { layout } = await import("./cli/home.js");
  const paths = layout();
  void (async () => {
    let path = findOllama();
    if (!path) {
      const outcome = await installOllama(paths, () => undefined);
      if (!outcome.ok) {
        throw new Error(outcome.message);
      }
      path = findOllama();
    }
    if (!(await startOllama(path, paths))) {
      throw new Error("Ollama isn’t answering.");
    }
    forgetLocalModels();
  })()
    .catch((err: Error) => {
      state.error = err.message;
    })
    .finally(() => {
      state.running = false;
    });
}
