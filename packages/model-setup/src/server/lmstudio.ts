import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { executable, findOnPath, logged, until } from "./install.js";

/** The LM Studio app on a Mac. */
const MAC_APPS = ["/Applications/LM Studio.app", join(homedir(), "Applications", "LM Studio.app")];

const WINDOWS_APPS = ["LM Studio", join("Programs", "LM Studio")];

/** LM Studio's `lms` command: there once the app ran for the first time, or with `llmster`. */
export function findLms(env: NodeJS.ProcessEnv = process.env): string | null {
  const own = join(homedir(), ".lmstudio", "bin", process.platform === "win32" ? "lms.exe" : "lms");
  return executable(own) ? own : findOnPath("lms", env.PATH ?? "");
}

/** The app on this computer. */
function findApp(): string | null {
  if (process.platform === "darwin") {
    return MAC_APPS.find((app) => existsSync(app)) ?? null;
  }
  const local = process.env.LOCALAPPDATA;
  if (process.platform === "win32" && local) {
    return (
      WINDOWS_APPS.map((dir) => join(local, dir, "LM Studio.exe")).find((app) => existsSync(app)) ??
      null
    );
  }
  return null;
}

/** LM Studio on this computer: its command, or the app that brings it. */
export function findLmStudio(): string | null {
  return findLms() ?? findApp();
}

/** The app's first start has its own pages, which the person goes through. */
const FIRST_START = 300_000;

/**
 * Starts LM Studio's server. The app was never opened: it opens, and once the person is through
 * its first start, its command is there and starts the server.
 */
export async function startLmStudio(
  logs: string,
  answers: () => Promise<boolean>,
): Promise<boolean> {
  if (!findLms()) {
    const app = findApp();
    if (process.platform !== "darwin" || !app) {
      return false;
    }
    await logged("open", [app], { logs });
    const ready = async () => findLms() !== null || (await answers());
    if (!(await until(ready, FIRST_START))) {
      return false;
    }
  }
  const lms = findLms();
  if (lms && !(await answers())) {
    await logged(lms, ["server", "start"], { logs });
  }
  return until(answers, 60_000);
}
