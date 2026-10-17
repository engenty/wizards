import { mkdirSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { runtimePath } from "./environment.js";
import { type Logged, runLogged } from "./exec.js";
import type { Layout } from "./home.js";
import { type Client, findOnPath } from "./machine.js";

/** A word for the shell: quoted when it holds anything but plain characters. */
const shellWord = (word: string) =>
  /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;

/** The command the setup runs for a client, as the person would type it. */
export function installCommand(client: Client, paths: Layout): string {
  return client.install.kind === "npm"
    ? `npm install --global --prefix ${shellWord(paths.clients)} ${client.install.pkg}`
    : `curl -fsSL ${client.install.url} | bash`;
}

/**
 * Installs an AI client. One that comes from npm goes into the install's own prefix
 * (`clients/`), with the npm of the Node that runs this command: nothing of the person's own
 * Node, if they have one, is touched. The others bring their own installer.
 */
export function installClient(
  client: Client,
  paths: Layout,
  onLine?: (line: string) => void,
): Promise<Logged> {
  const logFile = join(paths.logs, "install.log");
  const env = { ...process.env, PATH: runtimePath(paths, process.env) };
  if (client.install.kind === "script") {
    return runLogged("bash", ["-c", `set -o pipefail; curl -fsSL ${client.install.url} | bash`], {
      env,
      logFile,
      onLine,
    });
  }
  const npm = findOnPath(
    "npm",
    [dirname(process.execPath), process.env.PATH ?? ""].join(delimiter),
  );
  if (!npm) {
    return Promise.resolve({ code: 127, tail: "npm wasn’t found next to this Node.js." });
  }
  mkdirSync(paths.clients, { recursive: true });
  return runLogged(
    npm,
    [
      "install",
      "--global",
      "--prefix",
      paths.clients,
      "--no-audit",
      "--no-fund",
      "--loglevel=error",
      client.install.pkg,
    ],
    { env, logFile, onLine },
  );
}
