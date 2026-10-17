import { spawn } from "node:child_process";
import { join } from "node:path";
import { runFile } from "../cli/exec.js";
import { layout } from "../cli/home.js";
import type { EnvSpec, HarnessAuth } from "./types.js";

export const run = runFile;

let shellEnv: Promise<Record<string, string>> | null = null;

/** The person's login shell, asked once: a desktop app and a bare dev server start without its variables. */
export function loginShellEnv(): Promise<Record<string, string>> {
  shellEnv ??= new Promise<Record<string, string>>((done) => {
    // Windows has no login shell to ask: the runtime's own environment is the person's.
    if (process.platform === "win32") {
      done({});
      return;
    }
    const shell = process.env.SHELL || "/bin/zsh";
    // In a session of its own, away from the terminal `wizards` runs in: an interactive
    // shell takes over that terminal for its job control and keeps it when it ends, and Ctrl-C
    // then reaches nobody. (execFile cannot do this: it drops `detached`.)
    const child = spawn(shell, ["-l", "-i", "-c", "env"], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
      env: {
        HOME: process.env.HOME,
        USER: process.env.USER,
        PATH: process.env.PATH,
        TERM: "dumb",
      },
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.on("error", () => done({}));
    child.on("close", (code) => {
      const out: Record<string, string> = {};
      for (const line of code === 0 ? stdout.split("\n") : []) {
        const at = line.indexOf("=");
        if (at > 0) {
          out[line.slice(0, at)] = line.slice(at + 1);
        }
      }
      done(out);
    });
  });
  return shellEnv;
}

/**
 * The environment a client gets: its sign-in as the login shell sets it (else as this process
 * has it), PATH as the shell has it so the client is found from a GUI app too, and nothing else —
 * no key of ours, no session of a parent client.
 */
export function pickEnv(
  shell: Record<string, string | undefined>,
  own: Record<string, string | undefined>,
  passThrough: RegExp,
  /** Folders before the shell's PATH: the clients the setup installed. */
  first: string[] = [],
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const picked: NodeJS.ProcessEnv = {};
  const source = Object.keys(shell).length ? shell : own;
  for (const [key, value] of Object.entries(source)) {
    if (passThrough.test(key) && value) {
      picked[key] = value;
    }
  }
  const windows = platform === "win32";
  if (windows) {
    for (const [key, value] of Object.entries(own)) {
      if (WINDOWS_BASE.test(key) && value) {
        picked[key] = value;
      }
    }
  }
  const sep = windows ? ";" : ":";
  const ownPath = own.PATH ?? own.Path ?? "";
  const path = [...first, ...(shell.PATH ?? "").split(sep), ...ownPath.split(sep)].filter(Boolean);
  return {
    ...picked,
    PATH: [...new Set(path)].join(sep),
    HOME: own.HOME,
    USER: own.USER,
    LANG: "en_US.UTF-8",
    TERM: "dumb",
  };
}

/**
 * What a Windows program needs of the environment to start at all: the system's folders, the
 * user's folders, and how commands are found and run (a .cmd needs ComSpec).
 */
const WINDOWS_BASE =
  /^(SystemRoot|SystemDrive|windir|ComSpec|PATHEXT|TEMP|TMP|USERPROFILE|USERNAME|USERDOMAIN|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|ProgramData|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|CommonProgramFiles|CommonProgramFiles\(x86\)|CommonProgramW6432|COMPUTERNAME|OS|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS)$/i;

export function stripKeys(env: NodeJS.ProcessEnv, keyVars: string[]): NodeJS.ProcessEnv {
  const bare = { ...env };
  for (const key of keyVars) {
    delete bare[key];
  }
  return bare;
}

/**
 * Where the setup installs clients, whoever started this runtime: npm's prefix (on Windows the
 * prefix itself), and on Windows where Claude Code and Cursor Agent put themselves.
 */
const installed = () => {
  if (process.platform !== "win32") {
    return [join(layout().clients, "bin")];
  }
  const { USERPROFILE: home, LOCALAPPDATA: local } = process.env;
  return [
    layout().clients,
    ...(home ? [join(home, ".local", "bin")] : []),
    ...(local ? [join(local, "cursor-agent"), join(local, "agy", "bin")] : []),
  ];
};

export interface ResolvedEnv {
  env: NodeJS.ProcessEnv;
  auth: HarnessAuth;
}

const resolved = new Map<string, Promise<ResolvedEnv>>();

/**
 * The environment a client runs in, decided once: the subscription sign-in comes first — it is
 * what the person installed the client for — so a key the shell sets is held back while the
 * client is signed in without it, and used only where it is the one way in.
 */
export function resolveEnv(spec: EnvSpec): Promise<ResolvedEnv> {
  let pending = resolved.get(spec.id);
  if (!pending) {
    pending = (async () => {
      const withKey = pickEnv(await loginShellEnv(), process.env, spec.passThrough, installed());
      const bare = stripKeys(withKey, spec.keyVars);
      const own = await spec.auth(bare);
      if (own !== "none") {
        return { env: bare, auth: own };
      }
      if (spec.keyVars.some((key) => withKey[key])) {
        const keyed = await spec.auth(withKey);
        if (keyed !== "none") {
          return { env: withKey, auth: "api_key" };
        }
      }
      return { env: bare, auth: "none" };
    })();
    resolved.set(spec.id, pending);
  }
  return pending;
}

/** The environment of a sign-in: the client on its own, without a key of the shell, in a real terminal. */
export async function loginEnv(spec: EnvSpec): Promise<NodeJS.ProcessEnv> {
  const bare = stripKeys(
    pickEnv(await loginShellEnv(), process.env, spec.passThrough, installed()),
    spec.keyVars,
  );
  return { ...bare, TERM: "xterm-256color", COLORTERM: "truecolor" };
}

/** The client's sign-in right now, on its own: asked again and again while the person signs in. */
export async function freshAuth(spec: EnvSpec): Promise<HarnessAuth> {
  return spec.auth(await loginEnv(spec));
}

/** Forgets what was decided: the person may just have signed in or changed their shell. */
export function forgetEnv(id?: string) {
  shellEnv = null;
  if (id) {
    resolved.delete(id);
  } else {
    resolved.clear();
  }
}
