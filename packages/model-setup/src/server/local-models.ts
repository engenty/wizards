import { totalmem } from "node:os";
import {
  fits,
  installedModels,
  ollamaRoot,
  ollamaState,
  pullModel,
} from "@engenty/local-models/ollama";
import {
  type HeldModel,
  MODEL_JOBS,
  type ModelDownload,
  type ModelJob,
  type OfferedModel,
  type OllamaModelsState,
} from "../types.js";
import { findOllama, freeGb, installOllama, startOllama } from "./ollama.js";

/** The job a capability of Ollama's serves. */
const JOB_OF: Record<string, ModelJob> = {
  completion: "text",
  embedding: "search",
  decision: "decision",
};

const gb = (bytes: number) => Math.round((bytes / 1e9) * 10) / 10;

export interface OllamaModelsOptions {
  /** Where Ollama answers: a root or `…/v1`. */
  url: () => Promise<string> | string;
  /** The models to download; null: the list is not reachable. */
  offered: () => Promise<readonly OfferedModel[] | null> | readonly OfferedModel[] | null;
  /** The share of the memory a model may take and still leave room for the rest. */
  share: number;
  /** A folder for the logs of an install. */
  logs: () => string;
  /** A model came or went, or Ollama started. */
  changed?: () => void;
  /** A download begins; what it answers runs once the download ended well. */
  pulling?: (model: string) => Promise<() => Promise<void> | void>;
  /** This computer's memory in bytes. */
  memory?: () => number;
}

/**
 * The models in Ollama on this computer: what is there and what each can do, what to download,
 * the downloads and removals a page starts, and Ollama itself installed and started. Nothing
 * here loads a model.
 */
export class OllamaModels {
  private readonly downloads = new Map<string, ModelDownload>();
  /** While Ollama is being installed or started, and how that ended. */
  private starting: { running: boolean; error: string | null } | null = null;

  constructor(private readonly options: OllamaModelsOptions) {}

  async state(): Promise<OllamaModelsState> {
    const { options } = this;
    const url = await options.url();
    const root = ollamaRoot(url);
    const { version } = await ollamaState(root);
    const bytes = options.memory?.() ?? totalmem();
    const memory = Math.round(bytes / 2 ** 30);
    const installed = version ? await this.held(root, bytes) : [];
    const names = new Set(installed.map((m) => m.name));
    const list = await options.offered();
    return {
      ollama: {
        url,
        version,
        installed: Boolean(version || findOllama()),
        canInstall: process.platform === "darwin",
        start: this.starting,
      },
      memory,
      free: await freeGb(),
      installed,
      offered:
        list?.map((m) => ({
          ...m,
          installed: names.has(m.name) || names.has(`${m.name}:latest`),
          fits: fits(m.memory, memory, options.share),
        })) ?? null,
      downloads: [...this.downloads.values()],
    };
  }

  /** The models Ollama holds, with the jobs each can do here. */
  private async held(root: string, memory: number): Promise<HeldModel[]> {
    return (await installedModels(root)).map((m) => ({
      name: m.name,
      size: gb(m.size),
      jobs: MODEL_JOBS.filter((job) => m.capabilities.some((c) => JOB_OF[c] === job)),
      capabilities: m.capabilities,
      runner: m.runner,
      quantization: m.quantization,
      fits: fits(m.size, memory, this.options.share),
      loaded: m.running,
    }));
  }

  /**
   * Pulls a model into Ollama in the background. A download of the same model that runs already
   * is left to finish.
   */
  async pull(model: string): Promise<void> {
    const running = this.downloads.get(model);
    if (running && !running.finished) {
      return;
    }
    const state: ModelDownload = { model, done: 0, total: 0, error: null, finished: false };
    this.downloads.set(model, state);
    const pulled = await this.options.pulling?.(model);
    void pullModel(ollamaRoot(await this.options.url()), model, (done, total) => {
      state.done = done;
      state.total = total;
    })
      .then(async () => {
        this.options.changed?.();
        state.finished = true;
        // A finished download is done; the list shows the model itself now.
        this.downloads.delete(model);
        await pulled?.();
      })
      .catch((err: Error) => {
        const unreachable = /fetch failed|ECONNREFUSED/i.test(`${err.message} ${err.cause ?? ""}`);
        state.error = unreachable ? "ollama" : err.message;
        state.finished = true;
      });
  }

  /** Removes a model from Ollama, and a download of it that failed; Ollama's reason where it refuses. */
  async remove(model: string): Promise<void> {
    this.downloads.delete(model);
    this.options.changed?.();
    const res = await fetch(`${ollamaRoot(await this.options.url())}/api/delete`, {
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
      } catch {
        // the text as it came
      }
      throw new Error(reason || `Ollama answered ${res.status}.`);
    }
  }

  /** Installs Ollama where it is missing (on a Mac) and starts it, in the background. */
  start(): void {
    if (this.starting?.running) {
      return;
    }
    const state = { running: true, error: null as string | null };
    this.starting = state;
    const logs = this.options.logs();
    void (async () => {
      let path = findOllama();
      if (!path) {
        const outcome = await installOllama(logs, () => undefined);
        if (!outcome.ok) {
          throw new Error(outcome.message);
        }
        path = findOllama();
      }
      if (!(await startOllama(path, logs))) {
        throw new Error("Ollama isn’t answering.");
      }
      this.options.changed?.();
    })()
      .catch((err: Error) => {
        state.error = err.message;
      })
      .finally(() => {
        state.running = false;
      });
  }
}
