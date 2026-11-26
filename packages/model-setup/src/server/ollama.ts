import { spawn } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ollamaAddress, ollamaState } from "@engenty/model-providers/ollama";
import { executable, findOnPath, lastLine, logged, type Outcome, until } from "./install.js";

/** The Ollama app on a Mac: its server and its command are inside it. */
const MAC_APPS = ["/Applications/Ollama.app", join(homedir(), "Applications", "Ollama.app")];
const MAC_DOWNLOAD = "https://ollama.com/download/Ollama-darwin.zip";
/** Ollama's own installer on Linux: it puts the server in a systemd service, with sudo. */
const LINUX_SCRIPT = "https://ollama.com/install.sh";
/**
 * What that installer needs and a fresh Debian lacks: zstd, to unpack Ollama. Installed first
 * with the system's package manager, under the same password.
 */
const LINUX_ZSTD = [
  "if ! command -v zstd >/dev/null 2>&1; then",
  "  if command -v apt-get >/dev/null 2>&1; then sudo apt-get update -qq && sudo apt-get install -y -qq zstd",
  "  elif command -v dnf >/dev/null 2>&1; then sudo dnf install -y -q zstd",
  "  elif command -v pacman >/dev/null 2>&1; then sudo pacman -S --noconfirm --needed zstd",
  "  elif command -v zypper >/dev/null 2>&1; then sudo zypper --non-interactive install zstd",
  "  fi",
  "fi",
].join("\n");

/** The `ollama` command: on the PATH, or inside the app on a Mac that never linked it. */
export function findOllama(env: NodeJS.ProcessEnv = process.env): string | null {
  const onPath = findOnPath("ollama", env.PATH ?? "");
  if (onPath || process.platform !== "darwin") {
    return onPath;
  }
  return (
    MAC_APPS.map((app) => join(app, "Contents", "Resources", "ollama")).find(executable) ?? null
  );
}

/** The app an `ollama` command belongs to on a Mac; null for one from Homebrew or elsewhere. */
function macApp(path: string | null): string | null {
  if (process.platform !== "darwin") {
    return null;
  }
  if (!path) {
    return MAC_APPS.find((app) => existsSync(app)) ?? null;
  }
  try {
    const real = realpathSync(path);
    const at = real.indexOf(".app/");
    return at > 0 ? real.slice(0, at + 4) : null;
  } catch {
    return null;
  }
}

/**
 * Installs Ollama. On a Mac its app goes into Applications (~/Applications where that is not
 * writable) and asks for no password; on Linux Ollama's own script runs in this terminal and
 * asks for one, as it installs a system service.
 */
export async function installOllama(
  logs: string,
  onLine: (line: string) => void,
): Promise<Outcome> {
  if (process.platform === "darwin") {
    let target = "/Applications";
    try {
      accessSync(target, constants.W_OK);
    } catch {
      target = join(homedir(), "Applications");
      mkdirSync(target, { recursive: true });
    }
    const tmp = mkdtempSync(join(tmpdir(), "ollama-"));
    try {
      const zip = join(tmp, "Ollama.zip");
      const download = await logged("curl", ["-fsSL", MAC_DOWNLOAD, "-o", zip], { logs, onLine });
      if (download.code !== 0) {
        return { ok: false, message: `The download failed. ${lastLine(download.tail)}` };
      }
      const unpack = await logged("ditto", ["-x", "-k", zip, target], { logs, onLine });
      if (unpack.code !== 0) {
        return { ok: false, message: `It could not be unpacked. ${lastLine(unpack.tail)}` };
      }
      return { ok: true, message: join(target, "Ollama.app") };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  if (process.platform === "linux") {
    const code = await new Promise<number>((resolve) => {
      const child = spawn("sh", ["-c", `${LINUX_ZSTD}\ncurl -fsSL ${LINUX_SCRIPT} | sh`], {
        stdio: "inherit",
      });
      child.on("error", () => resolve(127));
      child.on("close", (status) => resolve(status ?? 1));
    });
    return code === 0
      ? { ok: true, message: findOllama() ?? "ollama" }
      : { ok: false, message: `Ollama’s installer stopped (exit ${code}).` };
  }
  return { ok: false, message: "Ollama is installed by this setup on macOS and Linux only." };
}

/**
 * Whether the Ollama app asks for the Mac's password when it starts: the first time, it wants to
 * link its `ollama` command into /usr/local/bin, and its server waits for the answer (cancel
 * works too). Not once that link points into the app.
 */
export function appAsksForPassword(path: string | null): boolean {
  const app = macApp(path);
  if (!app) {
    return false;
  }
  try {
    return realpathSync("/usr/local/bin/ollama") !== join(app, "Contents", "Resources", "ollama");
  } catch {
    return true;
  }
}

/**
 * Starts Ollama's server where it does not run: the app on a Mac (it then starts at login by
 * itself), Homebrew's service, else `ollama serve` in the background. Its version once it
 * answers; null where it does not in time — three minutes for the app, which may wait for a
 * password, half a minute otherwise.
 */
export async function startOllama(path: string | null, logs: string): Promise<string | null> {
  const app = macApp(path);
  const brew = findOnPath("brew", process.env.PATH ?? "");
  let real = path ?? "";
  try {
    real = path ? realpathSync(path) : "";
  } catch {
    // a dangling link: started as it is
  }
  if (app) {
    await logged("open", ["-g", app], { logs });
  } else if (brew && real.includes("/Cellar/ollama/")) {
    await logged(brew, ["services", "start", "ollama"], { logs });
  } else if (path) {
    mkdirSync(logs, { recursive: true });
    const out = openSync(join(logs, "ollama.log"), "a");
    spawn(path, ["serve"], { detached: true, stdio: ["ignore", out, out] }).unref();
  } else {
    return null;
  }
  const answers = async () => (await ollamaState(ollamaAddress())).version !== null;
  await until(answers, app ? 180_000 : 30_000);
  return (await ollamaState(ollamaAddress())).version;
}
