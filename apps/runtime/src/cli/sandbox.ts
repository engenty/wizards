import { delimiter, dirname, join } from "node:path";
import {
  ENGINE_PACKAGES,
  engineList,
  installEngine,
  installedVersion,
  removeEngine,
} from "../sandbox/install.js";
import { runtimePath } from "./environment.js";
import { runLogged } from "./exec.js";
import type { Layout } from "./home.js";
import { findOnPath } from "./machine.js";
import { busy, cmd, no, ok, tilde } from "./ui.js";

/** What `sandbox add` installs when no engine is named. */
const DEFAULT_ENGINE = "agentos";

/** Where an engine goes: `SANDBOX_ENGINES_DIR/<name>`, else `engines/<name>` in the install's folder. */
export const engineDirOf = (paths: Layout, name: string) =>
  join(process.env.SANDBOX_ENGINES_DIR?.trim() || join(paths.home, "engines"), name);

/** The engines installed here, with their versions and the versions this release installs. */
export function installedEngines(paths: Layout) {
  return Object.entries(ENGINE_PACKAGES).flatMap(([name, engine]) => {
    const version = installedVersion(engineDirOf(paths, name));
    return version ? [{ name, label: engine.label, version, current: engine.version }] : [];
  });
}

/**
 * `wizards sandbox [add|remove] [engine]`: the sandbox where AI steps run code, without Docker.
 * The engines are not part of engenty wizards; `add` downloads one beside the install.
 */
export async function sandboxCommand(paths: Layout, value: string, engine = ""): Promise<number> {
  const name = engine.toLowerCase() || DEFAULT_ENGINE;
  if ((value === "add" || value === "remove") && !ENGINE_PACKAGES[name]) {
    console.error(`${no} There is no engine “${name}”. ${engineList()}`);
    return 2;
  }
  if (value === "add") {
    return add(paths, name);
  }
  if (value === "remove") {
    removeEngine(engineDirOf(paths, name));
    console.log(
      `${ok} The sandbox ${ENGINE_PACKAGES[name].label} is removed. It goes away with the next ${cmd("restart")}.`,
    );
    return 0;
  }
  if (value) {
    console.error(`Use ${cmd("sandbox add")} or ${cmd("sandbox remove")}.`);
    return 2;
  }
  const installed = installedEngines(paths);
  if (!installed.length) {
    console.log(
      `${no} No sandbox is installed. AI steps can’t run code unless Docker has the engenty-sandbox image. To add one: ${cmd("sandbox add")}`,
    );
    return 0;
  }
  for (const { name, label, version } of installed) {
    console.log(`${ok} The sandbox ${label} ${version} is in ${tilde(engineDirOf(paths, name))}.`);
  }
  console.log(
    `AI steps run code in ${installed.length === 1 ? "it" : "the first one"}, unless Docker has the engenty-sandbox image or SANDBOX names an engine.`,
  );
  return 0;
}

async function add(paths: Layout, name: string): Promise<number> {
  const engine = ENGINE_PACKAGES[name];
  const unsupported = engine.unsupported?.();
  if (unsupported) {
    console.error(`${no} ${unsupported}`);
    return 1;
  }
  const npm = findOnPath(
    "npm",
    [dirname(process.execPath), process.env.PATH ?? ""].join(delimiter),
  );
  if (!npm) {
    console.error(`${no} npm wasn’t found next to this Node.js.`);
    return 1;
  }
  const env = { ...process.env, PATH: runtimePath(paths, process.env) };
  const logFile = join(paths.logs, "install.log");
  const dir = engineDirOf(paths, name);
  const spinner = busy(
    `Installing the sandbox (${engine.label} ${engine.version}, ${engine.size})…`,
  );
  try {
    await installEngine(name, dir, (args) => runLogged(npm, args, { env, logFile }));
  } catch (err) {
    spinner.fail(`The sandbox couldn’t be installed: ${(err as Error).message}`);
    return 1;
  }
  spinner.stop(`${ok} The sandbox is installed in ${tilde(dir)}.`);
  console.log(`AI steps run code in it from the next start: ${cmd("restart")}`);
  return 0;
}
