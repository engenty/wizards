import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { layout, readEnvFile } from "./home.js";

/**
 * Imported first by the command: before the runtime's modules load, this process sees the
 * install the way its runtime does. env.ts reads the process once, when it is first imported,
 * and `.env` from the working directory; the runtime starts in the install's folder (start.ts)
 * and so reads the install's `.env`, with its data folder beside it. The command goes there
 * too — else `wizards account` or `wizards status` from another folder would open a `data/`
 * of its own there, with a secret of its own, and a vault the runtime cannot read.
 *
 * What the terminal exports for other projects never reaches the runtime (environment.ts); a
 * few keys that would make this process another runtime are taken from the install's `.env`
 * alone. The rest the runtime inherits, so the terminal's word stands.
 */
const paths = layout();
const fileEnv = readEnvFile(paths.envFile);

/** The install's data folder, as start.ts hands it to the runtime: the terminal's word first. */
const given = process.env.DATA_DIR?.trim() || fileEnv.DATA_DIR?.trim();
process.env.DATA_DIR = given ? resolve(paths.home, given) : paths.data;

for (const key of ["MANAGE_URL", "APP_SECRET", "DATABASE_URL", "DATABASE_AUTH_TOKEN"]) {
  process.env[key] = fileEnv[key] ?? "";
}

// Keys and the account's sign-in live in the Keychain on a Mac, as the runtime keeps them.
if (
  process.platform === "darwin" &&
  process.env.SECRETS === undefined &&
  fileEnv.SECRETS === undefined
) {
  process.env.SECRETS = "keychain";
}

/** Where the command was typed: `wizards validate ./my.wizard` means a path from there. */
export const startedIn = process.cwd();

mkdirSync(paths.home, { recursive: true });
process.chdir(paths.home);
