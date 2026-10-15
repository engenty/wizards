import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, win32 } from "node:path";

/**
 * The first executable called `name` in the folders of `path` (a PATH value). On Windows a
 * command is a file with one of the endings in PATHEXT: `codex` is `codex.cmd`, `claude` is
 * `claude.exe`.
 */
export function findOnPath(
  name: string,
  path: string,
  platform: NodeJS.Platform = process.platform,
  pathext = process.env.PATHEXT,
): string | null {
  const windows = platform === "win32";
  const endings = windows
    ? ["", ...(pathext || ".COM;.EXE;.BAT;.CMD").toLowerCase().split(";").filter(Boolean)]
    : [""];
  for (const dir of path.split(windows ? ";" : delimiter)) {
    if (!dir) {
      continue;
    }
    for (const ending of endings) {
      // A file without an ending is no command on Windows, unless the name brought one.
      if (windows && !ending && !/\.\w+$/.test(name)) {
        continue;
      }
      const file = join(dir, name + ending);
      try {
        accessSync(file, windows ? constants.F_OK : constants.X_OK);
        return file;
      } catch {
        // not here
      }
    }
  }
  return null;
}

/**
 * The browser the runtime renders PDF and PNG with and drives for websites: `CHROME_PATH`, else
 * the first Chromium-based browser installed (Chrome, Edge, Chromium, Brave). The setup and
 * `wizards doctor` report this one, and env.ts starts it, so a browser they show is the one used.
 */
export function findChrome(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.CHROME_PATH) {
    return existsSync(env.CHROME_PATH) ? env.CHROME_PATH : null;
  }
  if (process.platform === "darwin") {
    const apps = [
      "Google Chrome.app/Contents/MacOS/Google Chrome",
      "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "Chromium.app/Contents/MacOS/Chromium",
      "Brave Browser.app/Contents/MacOS/Brave Browser",
    ];
    const roots = ["/Applications", join(homedir(), "Applications")];
    for (const app of apps) {
      for (const root of roots) {
        if (existsSync(join(root, app))) {
          return join(root, app);
        }
      }
    }
    return null;
  }
  if (process.platform === "win32") {
    const apps = [
      "Google\\Chrome\\Application\\chrome.exe",
      "Microsoft\\Edge\\Application\\msedge.exe",
      "Chromium\\Application\\chrome.exe",
      "BraveSoftware\\Brave-Browser\\Application\\brave.exe",
    ];
    const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(Boolean);
    for (const app of apps) {
      for (const root of roots) {
        const file = win32.join(root as string, app);
        if (existsSync(file)) {
          return file;
        }
      }
    }
    return null;
  }
  for (const name of ["google-chrome", "chromium", "chromium-browser", "microsoft-edge"]) {
    const file = findOnPath(name, env.PATH ?? "");
    if (file) {
      return file;
    }
  }
  return null;
}
