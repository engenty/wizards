import { totalmem } from "node:os";
import { fits, type LocalServer } from "@engenty/model-sources/servers";
import {
  type HeldModel,
  type LocalModelsState,
  MODEL_JOBS,
  type ModelDownload,
  type ModelJob,
  type OfferedModel,
  type ServerStatus,
} from "../types.js";
import { freeGb } from "./install.js";
import { SERVER_APPS } from "./server-apps.js";

/** The job a capability serves. */
const JOB_OF: Record<string, ModelJob> = {
  completion: "text",
  embedding: "search",
  decision: "decision",
};

const gb = (bytes: number) => Math.round((bytes / 1e9) * 10) / 10;

export interface LocalModelsOptions {
  server: LocalServer;
  /** Where the server answers: a root or `…/v1`. */
  url: () => Promise<string> | string;
  /** The models to download; null: the list is not reachable. */
  offered: () => Promise<readonly OfferedModel[] | null> | readonly OfferedModel[] | null;
  /** The share of the memory a model may take and still leave room for the rest. */
  share: number;
  /** A folder for the logs of an install. */
  logs: () => string;
  /** A model came or went, or the server started. */
  changed?: () => void;
  /** A download begins; what it answers runs once the download ended well. */
  pulling?: (model: string) => Promise<() => Promise<void> | void>;
  /** This computer's memory in bytes. */
  memory?: () => number;
}

/**
 * The models of a server on this computer: what is there and what each can do, what to download,
 * the downloads and removals a page starts, and the server itself installed and started. Nothing
 * here loads a model.
 */
export class LocalModels {
  private readonly downloads = new Map<string, ModelDownload>();
  /** While the server is being installed or started, and how that ended. */
  private starting: { running: boolean; error: string | null } | null = null;

  constructor(private readonly options: LocalModelsOptions) {}

  get id() {
    return this.options.server.id;
  }

  private get app() {
    return SERVER_APPS[this.id];
  }

  /** Whether it is on this computer, and whether it runs. */
  async status(): Promise<ServerStatus> {
    const { server, url } = this.options;
    const { running } = await server.state(await url());
    return {
      id: server.id,
      name: server.name,
      installed: running || this.app.find() !== null,
      running,
    };
  }

  async state(): Promise<LocalModelsState> {
    const { options } = this;
    const { server } = options;
    const url = await options.url();
    const { running, version, trouble } = await server.state(url);
    const bytes = options.memory?.() ?? totalmem();
    const memory = Math.round(bytes / 2 ** 30);
    const installed = running ? await this.held(url, bytes) : [];
    const names = new Set(installed.map((m) => m.name));
    const list = await options.offered();
    return {
      server: {
        id: server.id,
        name: server.name,
        installed: running || this.app.find() !== null,
        running,
        url,
        version,
        trouble,
        canInstall: this.app.install !== undefined,
        download: this.app.download,
        removes: server.remove !== undefined,
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

  /** The models the server holds, with the jobs each can do here. */
  private async held(url: string, memory: number): Promise<HeldModel[]> {
    return (await this.options.server.models(url)).map((m) => ({
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
   * Downloads a model in the background. A download of the same model that runs already is left
   * to finish.
   */
  async pull(model: string): Promise<void> {
    const running = this.downloads.get(model);
    if (running && !running.finished) {
      return;
    }
    const state: ModelDownload = { model, done: 0, total: 0, error: null, finished: false };
    this.downloads.set(model, state);
    const pulled = await this.options.pulling?.(model);
    void this.options.server
      .download(await this.options.url(), model, (done, total) => {
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
        state.error = unreachable ? "unreachable" : err.message;
        state.finished = true;
      });
  }

  /** Removes a model, and a download of it that failed; the server's reason where it refuses. */
  async remove(model: string): Promise<void> {
    const { server, url } = this.options;
    this.downloads.delete(model);
    this.options.changed?.();
    if (!server.remove) {
      throw new Error(`${server.name} removes its models itself.`);
    }
    await server.remove(await url(), model);
  }

  /** Installs the server where it is missing and the host can, and starts it, in the background. */
  start(): void {
    if (this.starting?.running) {
      return;
    }
    const state = { running: true, error: null as string | null };
    this.starting = state;
    const { server, url, logs, changed } = this.options;
    const folder = logs();
    void (async () => {
      if (!this.app.find()) {
        if (!this.app.install) {
          throw new Error(`${server.name} isn’t on this computer.`);
        }
        const outcome = await this.app.install(folder, () => undefined);
        if (!outcome.ok) {
          throw new Error(outcome.message);
        }
      }
      const address = await url();
      const answers = async () => (await server.state(address)).running;
      if (!(await this.app.start(folder, answers))) {
        throw new Error(`${server.name} isn’t answering.`);
      }
      changed?.();
    })()
      .catch((err: Error) => {
        state.error = err.message;
      })
      .finally(() => {
        state.running = false;
      });
  }
}
