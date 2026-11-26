import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/**
 * `wizards-mlx` (../../mlx): Apple's MLX as a long-lived child of this process. It holds one
 * model, answers one call after the other, and goes away once nobody asked it for a while, with
 * the memory the model took.
 */

/** How long the model stays in memory, unasked. */
const IDLE_MS = 10 * 60_000;

/** The helper: built into mlx/bin by mlx/build.mjs, or named by the environment. */
export function mlxBin(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.WIZARDS_MLX_BIN?.trim() ||
    join(resolve(fileURLToPath(import.meta.url), "../../.."), "mlx", "bin", "wizards-mlx")
  );
}

/** MLX runs here: a Mac with Apple silicon that has the helper. */
export function mlxSupported(): boolean {
  return process.platform === "darwin" && process.arch === "arm64" && existsSync(mlxBin());
}

/** A pipe no longer keeps this process alive. */
const unref = (pipe: unknown) => (pipe as { unref?: () => void } | undefined)?.unref?.();

/** What a call waits for: the model is loaded, reads (of `total` tokens `done`) or thinks. */
export interface Waiting {
  state: "loading" | "reading" | "thinking";
  done?: number;
  total?: number;
}

/** What the helper says of a call, in the shape of Ollama's chat API. */
export interface HelperChunk {
  id: string;
  wait?: Waiting;
  message?: {
    content?: string;
    thinking?: string;
    tool_calls?: { function: { name: string; arguments: unknown } }[];
  };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

type Listener = (chunk: HelperChunk) => void;

export class Helper {
  private child: ChildProcess | undefined;
  private readonly calls = new Map<string, Listener>();
  /** The call that only reads ahead. What it has read stays read when another call ends it. */
  private ahead: string | undefined;
  private clock: ReturnType<typeof setTimeout> | undefined;
  private next = 0;
  /** The folder of the model in memory. */
  model: string | undefined;

  constructor(
    private readonly bin: () => string = mlxBin,
    private readonly idle = IDLE_MS,
  ) {}

  private start(): ChildProcess {
    if (this.child) {
      return this.child;
    }
    const child = spawn(this.bin(), [], { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (data: Buffer) => {
      stderr = (stderr + data.toString()).slice(-2000);
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
      let chunk: HelperChunk;
      try {
        chunk = JSON.parse(line) as HelperChunk;
      } catch {
        return; // a line the library prints
      }
      this.calls.get(chunk.id)?.(chunk);
    });
    const gone = (why: string) => {
      if (this.child !== child) {
        return;
      }
      this.child = undefined;
      this.model = undefined;
      for (const [id, say] of [...this.calls]) {
        say({ id, error: why });
      }
    };
    child.on("error", (error) => gone(error.message));
    child.on("close", (code, signal) =>
      gone(stderr.trim().split("\n").pop() || `MLX ended (${signal ?? code}).`),
    );
    // The host ends without waiting for it; the helper ends with its stdin.
    child.stdin.on("error", () => undefined);
    child.unref();
    for (const pipe of [child.stdin, child.stdout, child.stderr]) {
      unref(pipe);
    }
    this.child = child;
    return child;
  }

  private write(body: unknown): void {
    this.start().stdin?.write(`${JSON.stringify(body)}\n`);
  }

  private rest(): void {
    clearTimeout(this.clock);
    if (this.calls.size === 0) {
      // Nothing is read any more: the pipe no longer keeps the host alive.
      unref(this.child?.stdout);
      this.clock = setTimeout(() => this.stop(), this.idle);
      this.clock.unref?.();
    }
  }

  /** Ends the helper and frees the memory of its model. */
  stop(): void {
    clearTimeout(this.clock);
    this.child?.stdin?.end();
    this.child?.kill();
  }

  /** One call: what the model says as it says it. */
  chat(chat: { model: string } & Record<string, unknown>, signal?: AbortSignal) {
    const id = String(++this.next);
    clearTimeout(this.clock);
    const over = () => {
      this.calls.delete(id);
      if (this.ahead === id) {
        this.ahead = undefined;
      }
      signal?.removeEventListener("abort", abort);
      this.rest();
    };
    let fail: (reason: unknown) => void = () => undefined;
    // The caller hears it at once; the helper ends the call at its next token.
    const abort = () => {
      this.write({ id, cancel: true });
      over();
      fail(signal?.reason);
    };
    return new ReadableStream<HelperChunk>({
      start: (controller) => {
        if (signal?.aborted) {
          return controller.error(signal.reason);
        }
        // A pipe that is being read keeps the host alive for the answer.
        (this.start().stdout as unknown as { ref?: () => void }).ref?.();
        this.calls.set(id, (chunk) => {
          if (chunk.error || chunk.done) {
            over();
          }
          controller.enqueue(chunk);
          if (chunk.error || chunk.done) {
            controller.close();
          }
        });
        fail = (reason) => controller.error(reason);
        signal?.addEventListener("abort", abort, { once: true });
        this.model = chat.model;
        if (this.ahead !== undefined) {
          this.write({ id: this.ahead, cancel: true });
        }
        this.ahead = chat.warm ? id : undefined;
        this.write({ id, chat });
      },
      cancel: () => {
        this.write({ id, cancel: true });
        over();
      },
    });
  }
}

/** This process's helper. */
export const helper = new Helper();
