import { accessSync, chmodSync, constants } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { note } from "@engenty-wizards/shared/run";
import { nanoid } from "nanoid";
import { ServiceError } from "../services/errors.js";

/**
 * Terminals the studio shows inline: a real pseudo-terminal running one command — a client's
 * sign-in — whose screen the browser renders and whose keyboard it is. A session lives while
 * someone looks at it; what the command printed is kept so a reopened page shows it again.
 */

export type TerminalEvent =
  | { type: "data"; data: string }
  | { type: "exit"; code: number }
  | { type: "done" };

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

const sessions = new Map<string, Session>();

type PtyModule = {
  spawn(file: string, args: string[], opts: Record<string, unknown>): Pty;
};

/** The prebuilt helper node-pty forks must be executable; an install that skips scripts leaves it without the bit. */
function ensureHelper() {
  try {
    const entry = createRequire(import.meta.url).resolve("node-pty");
    const helper = join(
      dirname(entry),
      "..",
      "prebuilds",
      `${process.platform}-${process.arch}`,
      "spawn-helper",
    );
    try {
      accessSync(helper, constants.X_OK);
    } catch {
      chmodSync(helper, 0o755);
    }
  } catch {
    // Not on this platform, or not ours to change: spawning tells.
  }
}

async function ptyModule(): Promise<PtyModule> {
  try {
    ensureHelper();
    const mod = (await import("node-pty")) as unknown as Partial<PtyModule> & {
      default?: PtyModule;
    };
    const spawn = mod.spawn ?? mod.default?.spawn;
    if (!spawn) {
      throw new Error("node-pty has no spawn");
    }
    return { spawn };
  } catch {
    throw new ServiceError("refused", note("builtTerminalNotAvailable"));
  }
}

function emit(session: Session, event: TerminalEvent) {
  for (const listener of session.listeners) {
    listener(event);
  }
}

function forget(session: Session) {
  if (session.poll) {
    clearInterval(session.poll);
  }
  if (session.reaper) {
    clearTimeout(session.reaper);
  }
  sessions.delete(session.id);
}

function rearm(session: Session) {
  if (session.reaper) {
    clearTimeout(session.reaper);
  }
  session.reaper = setTimeout(
    () => {
      if (session.listeners.size) {
        rearm(session);
        return;
      }
      if (!session.exit) {
        session.pty.kill();
      }
      forget(session);
    },
    session.exit ? LINGER_MS : IDLE_MS,
  );
  session.reaper.unref();
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

/** Starts a command in a new terminal; the id names it to the page. */
export async function openTerminal(opts: TerminalOptions): Promise<string> {
  const { spawn } = await ptyModule();
  const id = nanoid(16);
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
    throw new ServiceError(
      "refused",
      note("commandNotStarted", { detail: (err as Error).message }),
    );
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
  sessions.set(id, session);
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
    rearm(session);
  });
  if (opts.until) {
    const until = opts.until;
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
            opts.onDone?.();
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
  rearm(session);
  return id;
}

function sessionOf(id: string): Session {
  const session = sessions.get(id);
  if (!session) {
    throw new ServiceError("not_found", note("terminalNoLongerExists"));
  }
  return session;
}

/** Follows a terminal: what it printed so far, then everything new, then its end. */
export function subscribeTerminal(id: string, listener: Listener): () => void {
  const session = sessionOf(id);
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
  rearm(session);
  return () => {
    session.listeners.delete(listener);
    rearm(session);
  };
}

export function writeTerminal(id: string, data: string) {
  const session = sessionOf(id);
  if (!session.exit) {
    session.pty.write(data);
  }
}

export function resizeTerminal(id: string, cols: number, rows: number) {
  const session = sessionOf(id);
  if (!session.exit && cols > 0 && rows > 0) {
    session.pty.resize(Math.min(cols, 500), Math.min(rows, 200));
  }
}

export function closeTerminal(id: string) {
  const session = sessions.get(id);
  if (!session) {
    return;
  }
  if (!session.exit) {
    session.pty.kill();
  }
  forget(session);
}
