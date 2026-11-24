import { randomBytes } from "node:crypto";
import { accessSync, chmodSync, constants } from "node:fs";
import { createRequire } from "node:module";
import type { TerminalEvent } from "../types.js";

/**
 * Why a terminal does not serve: `unavailable`: this computer has none; `not_started`: the
 * command could not be started, `detail` says why; `gone`: no terminal of that id.
 */
export class TerminalError extends Error {
  constructor(
    readonly code: "unavailable" | "not_started" | "gone",
    readonly detail = "",
  ) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

type Listener = (event: TerminalEvent) => void;

interface Pty {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
}

interface Session {
  id: string;
  pty: Pty;
  /** The last of what was printed; a page that opens later starts from it. */
  buffer: string;
  listeners: Set<Listener>;
  exit: { code: number } | null;
  done: boolean;
  poll: ReturnType<typeof setInterval> | null;
  reaper: ReturnType<typeof setTimeout> | null;
}

const BUFFER = 200_000;
/** A session nobody looks at is ended after this long. */
const IDLE_MS = 20 * 60_000;
/** An ended session is kept this long for a page to read its last lines. */
const LINGER_MS = 5 * 60_000;

type PtyModule = {
  spawn(file: string, args: string[], opts: Record<string, unknown>): Pty;
};

/**
 * @lydell/node-pty: node-pty with its binaries built for every platform it supports (Linux too),
 * one package per platform, so nothing compiles at install. On macOS it forks through a helper
 * that must be executable; a copy that lost the bit gets it back.
 */
const PTY = "@lydell/node-pty";

function ensureHelper() {
  if (process.platform !== "darwin") {
    return;
  }
  try {
    const entry = createRequire(import.meta.url).resolve(PTY);
    const helper = createRequire(entry).resolve(
      `${PTY}-${process.platform}-${process.arch}/spawn-helper`,
    );
    try {
      accessSync(helper, constants.X_OK);
    } catch {
      chmodSync(helper, 0o755);
    }
  } catch {
    // Not installed, or not ours to change: spawning tells.
  }
}

async function ptyModule(): Promise<PtyModule> {
  try {
    ensureHelper();
    const mod = (await import("@lydell/node-pty")) as unknown as Partial<PtyModule> & {
      default?: PtyModule;
    };
    const spawn = mod.spawn ?? mod.default?.spawn;
    if (!spawn) {
      throw new Error(`${PTY} has no spawn`);
    }
    return { spawn };
  } catch {
    throw new TerminalError("unavailable");
  }
}

function emit(session: Session, event: TerminalEvent) {
  for (const listener of session.listeners) {
    listener(event);
  }
}

export interface TerminalOptions {
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  cols?: number;
  rows?: number;
  /** Asked every few seconds: once true, the session is done and the command is ended. */
  until?: () => Promise<boolean>;
  onDone?: () => void;
}

/**
 * Terminals a page shows inline: a real pseudo-terminal running one command (a client's install
 * or sign-in) whose screen the browser renders and whose keyboard it is. A session lives while
 * someone looks at it; what the command printed is kept so a reopened page shows it again.
 */
export class Terminals {
  private readonly sessions = new Map<string, Session>();

  /** Starts a command in a new terminal; the id names it to the page. */
  async open(opts: TerminalOptions): Promise<string> {
    const { spawn } = await ptyModule();
    const id = randomBytes(12).toString("base64url");
    let pty: Pty;
    try {
      pty = spawn(opts.bin, opts.args, {
        name: "xterm-256color",
        cols: opts.cols ?? 100,
        rows: opts.rows ?? 28,
        cwd: opts.cwd,
        env: opts.env as Record<string, string>,
      });
    } catch (err) {
      throw new TerminalError("not_started", (err as Error).message);
    }
    const session: Session = {
      id,
      pty,
      buffer: "",
      listeners: new Set(),
      exit: null,
      done: false,
      poll: null,
      reaper: null,
    };
    this.sessions.set(id, session);
    pty.onData((data) => {
      session.buffer = (session.buffer + data).slice(-BUFFER);
      emit(session, { type: "data", data });
    });
    pty.onExit(({ exitCode }) => {
      session.exit = { code: exitCode };
      if (session.poll) {
        clearInterval(session.poll);
        session.poll = null;
      }
      emit(session, { type: "exit", code: exitCode });
      this.rearm(session);
    });
    if (opts.until) {
      this.watch(session, opts.until, opts.onDone);
    }
    this.rearm(session);
    return id;
  }

  /** Follows a terminal: what it printed so far, then everything new, then its end. */
  subscribe(id: string, listener: Listener): () => void {
    const session = this.session(id);
    if (session.buffer) {
      listener({ type: "data", data: session.buffer });
    }
    if (session.done) {
      listener({ type: "done" });
    }
    if (session.exit) {
      listener({ type: "exit", code: session.exit.code });
    }
    session.listeners.add(listener);
    this.rearm(session);
    return () => {
      session.listeners.delete(listener);
      this.rearm(session);
    };
  }

  write(id: string, data: string) {
    const session = this.session(id);
    if (!session.exit) {
      session.pty.write(data);
    }
  }

  resize(id: string, cols: number, rows: number) {
    const session = this.session(id);
    if (!session.exit && cols > 0 && rows > 0) {
      session.pty.resize(Math.min(cols, 500), Math.min(rows, 200));
    }
  }

  close(id: string) {
    const session = this.sessions.get(id);
    if (!session) {
      return;
    }
    if (!session.exit) {
      session.pty.kill();
    }
    this.forget(session);
  }

  private session(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) {
      throw new TerminalError("gone");
    }
    return session;
  }

  /** Asks `until` every few seconds and ends the command once it is true. */
  private watch(session: Session, until: () => Promise<boolean>, onDone?: () => void) {
    let asking = false;
    session.poll = setInterval(() => {
      if (asking || session.done) {
        return;
      }
      asking = true;
      void until()
        .then((ok) => {
          if (ok && !session.done) {
            session.done = true;
            emit(session, { type: "done" });
            onDone?.();
            if (!session.exit) {
              // The command did its job; an app that stays open is ended for the person.
              setTimeout(() => {
                if (!session.exit) {
                  session.pty.kill();
                }
              }, 1500).unref();
            }
          }
        })
        .catch(() => undefined)
        .finally(() => {
          asking = false;
        });
    }, 3000);
  }

  private forget(session: Session) {
    if (session.poll) {
      clearInterval(session.poll);
    }
    if (session.reaper) {
      clearTimeout(session.reaper);
    }
    this.sessions.delete(session.id);
  }

  private rearm(session: Session) {
    if (session.reaper) {
      clearTimeout(session.reaper);
    }
    session.reaper = setTimeout(
      () => {
        if (session.listeners.size) {
          this.rearm(session);
          return;
        }
        if (!session.exit) {
          session.pty.kill();
        }
        this.forget(session);
      },
      session.exit ? LINGER_MS : IDLE_MS,
    );
    session.reaper.unref();
  }
}
