import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/** The first executable called `name` in the folders of `path` (a PATH value). */
export function findOnPath(name: string, path: string): string | null {
  for (const dir of path.split(delimiter)) {
    if (!dir) {
      continue;
    }
    const file = join(dir, name);
    try {
      accessSync(file, constants.X_OK);
      return file;
    } catch {
      // not here
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
  for (const name of ["google-chrome", "chromium", "chromium-browser", "microsoft-edge"]) {
    const file = findOnPath(name, env.PATH ?? "");
    if (file) {
      return file;
    }
  }
  return null;
}
