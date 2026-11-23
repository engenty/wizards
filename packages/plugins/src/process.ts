import { type ChildProcess, fork } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginSource } from "./discovery.js";
import type { PluginToolInfo } from "./plugin.js";

/*
 * A plugin's server half in a Node process of its own, with fewer rights than its host:
 *
 * - Node's permission model (`--permission`): it reads its own folder, this package and zod,
 *   writes only its data folder, and starts no process, no worker and no native addon.
 * - No environment: none of the host's variables, so none of its keys.
 * - A heap of its own size, and a time limit on each call.
 * - It reaches the host only through the messages of child.ts: it says which tools it has, the
 *   host calls them with an input and reads back a result.
 *
 * Node 24's permission model has no network permission: the process can reach the network. What
 * it could send is only what it was given, which is why a host gives it no secrets.
 */

const here = fileURLToPath(import.meta.url);
const CHILD = join(dirname(here), here.endsWith(".ts") ? "child.ts" : "child.js");
/** This package's folder: the child reads its index and package.json there. */
const PACKAGE_ROOT = realpathSync(dirname(dirname(here)));

/**
 * The folders the child reads zod from: the path Node resolves it through from the child's
 * folder, and where that path leads. With pnpm the first is a link beside this package
 * (`.pnpm/@engenty+plugins@…/node_modules/zod`), and Node checks the permission on the path it
 * reads, not on the link's target.
 */
export function zodPaths(from = dirname(CHILD)): string[] {
  const require = createRequire(join(from, "_.js"));
  const real = realpathSync(dirname(require.resolve("zod/package.json")));
  for (let dir = from; ; dir = dirname(dir)) {
    const linked = join(dir, "node_modules", "zod");
    if (existsSync(join(linked, "package.json"))) {
      return linked === real ? [real] : [linked, real];
    }
    if (dirname(dir) === dir) {
      return [real];
    }
  }
}

export interface PluginProcessOptions {
  source: PluginSource;
  /** The one folder the plugin may write in; made when missing. It is the process's folder too. */
  dataDir: string;
  /** Settings the host keeps for the plugin, read with `config.get`. */
  config?: Record<string, string>;
  /** More folders it may read. */
  readable?: string[];
  /** How long one call may take. Default two minutes. */
  callMs?: number;
  /** How long the plugin may take to register its tools. Default 15 seconds. */
  startMs?: number;
  /** Its heap, in MB. Default 256. */
  memoryMb?: number;
  /** A line the plugin logged or printed. */
  log?(level: "info" | "warn" | "error", line: string): void;
  /** The process ended without being stopped: it failed or was killed. */
  onExit?(reason: string): void;
}

export interface PluginCallOptions {
  signal?: AbortSignal;
  /** A line the tool tells the person while it runs. */
  emit?(message: string): void;
}

export interface PluginProcess {
  readonly id: string;
  readonly tools: PluginToolInfo[];
  /** Runs a tool. Rejects with the tool's error, or when the process ends or the time is up. */
  call(name: string, input: unknown, options?: PluginCallOptions): Promise<unknown>;
  running(): boolean;
  /** Runs the plugin's `onUnload`, then ends the process. */
  stop(): Promise<void>;
}

type FromChild =
  | { type: "ready"; tools: PluginToolInfo[] }
  | { type: "failed"; message: string }
  | { type: "log"; level: "info" | "warn" | "error"; text: string }
  | { type: "emit"; id: number; message: string }
  | { type: "result"; id: number; ok: true; value: unknown }
  | { type: "result"; id: number; ok: false; error: string };

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  emit?(message: string): void;
}

/** The flags that hold the process to its folders. */
export function permissionFlags(
  options: Pick<PluginProcessOptions, "source" | "dataDir" | "readable" | "memoryMb">,
): string[] {
  const readable = [
    realpathSync(options.source.root),
    PACKAGE_ROOT,
    ...zodPaths(),
    realpathSync(options.dataDir),
    ...(options.readable ?? []).map((path) => realpathSync(path)),
  ];
  return [
    "--permission",
    ...[...new Set(readable)].map((path) => `--allow-fs-read=${path}`),
    `--allow-fs-write=${realpathSync(options.dataDir)}`,
    `--max-old-space-size=${options.memoryMb ?? 256}`,
  ];
}

/** Starts the plugin's process and waits until it registered its tools. */
export function startPluginProcess(options: PluginProcessOptions): Promise<PluginProcess> {
  const { source } = options;
  const entry = source.entry;
  if (!entry) {
    return Promise.reject(new Error(`Plugin "${source.id}" has no server half.`));
  }
  mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
  const child: ChildProcess = fork(CHILD, [], {
    cwd: options.dataDir,
    env: {},
    execArgv: permissionFlags(options),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    serialization: "json",
  });
  const log = options.log ?? (() => {});
  const lines = (level: "info" | "error") => (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split("\n")) {
      if (line.trim()) {
        log(level, line);
      }
    }
  };
  child.stdout?.on("data", lines("info"));
  child.stderr?.on("data", lines("error"));

  const pending = new Map<number, Pending>();
  let calls = 0;
  let alive = true;
  let stopping = false;
  let tools: PluginToolInfo[] = [];

  return new Promise((resolveStart, rejectStart) => {
    let started = false;
    const startTimer = setTimeout(() => {
      if (!started) {
        child.kill("SIGKILL");
        rejectStart(new Error(`Plugin "${source.id}" did not start in time.`));
      }
    }, options.startMs ?? 15_000);

    child.on("message", (message: FromChild) => {
      switch (message.type) {
        case "ready":
          started = true;
          clearTimeout(startTimer);
          tools = message.tools;
          resolveStart(handle);
          break;
        case "failed":
          started = true;
          clearTimeout(startTimer);
          stopping = true;
          child.kill("SIGKILL");
          rejectStart(new Error(message.message));
          break;
        case "log":
          log(message.level, message.text);
          break;
        case "emit":
          pending.get(message.id)?.emit?.(message.message);
          break;
        case "result": {
          const call = pending.get(message.id);
          pending.delete(message.id);
          if (message.ok) {
            call?.resolve(message.value);
          } else {
            call?.reject(new Error(message.error));
          }
          break;
        }
      }
    });

    child.on("exit", (code, signal) => {
      alive = false;
      clearTimeout(startTimer);
      const reason = signal ? `stopped by ${signal}` : `ended with code ${code}`;
      for (const call of pending.values()) {
        call.reject(new Error(`The plugin ${source.id} stopped (${reason}).`));
      }
      pending.clear();
      if (!started) {
        started = true;
        rejectStart(
          new Error(`Plugin "${source.id}" stopped before it registered its tools (${reason}).`),
        );
      } else if (!stopping) {
        options.onExit?.(reason);
      }
    });

    child.send({
      type: "start",
      entry: realpathSync(entry),
      root: realpathSync(source.root),
      manifest: source.manifest,
      config: options.config ?? {},
    });

    const handle: PluginProcess = {
      id: source.id,
      get tools() {
        return tools;
      },
      running: () => alive,
      call(name, input, callOptions = {}) {
        if (!alive) {
          return Promise.reject(new Error(`The plugin ${source.id} is not running.`));
        }
        if (callOptions.signal?.aborted) {
          return Promise.reject(new Error("Stopped."));
        }
        const id = ++calls;
        return new Promise((resolve, reject) => {
          const ms = options.callMs ?? 120_000;
          const abort = () => child.send({ type: "abort", id });
          const done = () => {
            clearTimeout(timer);
            callOptions.signal?.removeEventListener("abort", onAbort);
          };
          const onAbort = () => {
            abort();
            pending.delete(id);
            done();
            reject(new Error("Stopped."));
          };
          const timer = setTimeout(() => {
            abort();
            pending.delete(id);
            done();
            reject(new Error(`The tool ${name} took longer than ${Math.round(ms / 1000)} s.`));
          }, ms);
          callOptions.signal?.addEventListener("abort", onAbort, { once: true });
          pending.set(id, {
            resolve: (value) => {
              done();
              resolve(value);
            },
            reject: (error) => {
              done();
              reject(error);
            },
            emit: callOptions.emit,
          });
          child.send({ type: "call", id, name, input });
        });
      },
      stop() {
        if (!alive) {
          return Promise.resolve();
        }
        stopping = true;
        return new Promise<void>((resolve) => {
          const kill = setTimeout(() => child.kill("SIGKILL"), 2_000);
          child.once("exit", () => {
            clearTimeout(kill);
            resolve();
          });
          child.send({ type: "stop" });
        });
      },
    };
  });
}
