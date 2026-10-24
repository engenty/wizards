import { homedir } from "node:os";
import { sep } from "node:path";
import { layout } from "./cli/home.js";
import { env } from "./env.js";

/** A folder as a shell reads it: `~/…` inside the home folder, quoted where it must be. */
function shellPath(path: string): string {
  const home = homedir();
  const inHome = path === home || path.startsWith(home + sep);
  const rest = inHome ? path.slice(home.length) : path;
  if (/^[\w./-]*$/.test(rest)) {
    return inHome ? `~${rest}` : rest;
  }
  return `"${inHome ? `$HOME${rest}` : path}"`;
}

/**
 * What the sign-in page of a runtime that runs alone tells the person to type. `wizards open`
 * reads the install's data folder (cli/start.ts), so a runtime on another folder (a checkout's
 * `data/`, a trial install) names its own. Null when no command can let a browser in: the secret
 * came from APP_SECRET, not from the data folder, and the runtime printed its link at the start.
 */
export function openCommand(): string | null {
  if (env.dataDir === layout().data) {
    return "wizards open";
  }
  if (process.env.APP_SECRET?.trim()) {
    return null;
  }
  return process.platform === "win32"
    ? `$env:DATA_DIR="${env.dataDir}"; wizards open`
    : `DATA_DIR=${shellPath(env.dataDir)} wizards open`;
}
