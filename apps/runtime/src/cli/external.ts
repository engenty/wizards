import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { join } from "node:path";
import type { Layout } from "./home.js";

/** Where other tools put commands: `wizards <name>` runs the file `<name>` from this folder. */
export const commandsFolder = (paths: Layout): string => join(paths.home, "commands");

/**
 * The file a command that engenty wizards doesn't have itself stands for, or null. A name is lower
 * case letters, digits and dashes, and the file must be an executable file. Not on Windows, where
 * a command is no file to run.
 */
export function findExternal(paths: Layout, name: string, windows = process.platform === "win32") {
  if (windows || !/^[a-z][a-z0-9-]*$/.test(name)) {
    return null;
  }
  const file = join(commandsFolder(paths), name);
  try {
    if (!statSync(file).isFile()) {
      return null;
    }
    accessSync(file, constants.X_OK);
    return file;
  } catch {
    return null;
  }
}

/** Runs the file with the arguments in this terminal and gives its exit code. */
export function runExternal(paths: Layout, file: string, args: string[]): Promise<number> {
  return new Promise((done) => {
    const child = spawn(file, args, {
      stdio: "inherit",
      env: { ...process.env, WIZARDS_HOME: paths.home },
    });
    // Ctrl-C reaches the command as well (same terminal); this one waits for it.
    process.on("SIGINT", () => undefined);
    process.on("SIGTERM", () => child.kill("SIGTERM"));
    child.on("error", (error) => {
      console.error(`${file} did not start: ${error.message}`);
      done(127);
    });
    child.on("exit", (code) => done(code ?? 1));
  });
}
