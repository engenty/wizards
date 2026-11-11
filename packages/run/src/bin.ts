/**
 * `wizards-run`, the small package's own command (`@engenty/wizards-run`): `wizards run` without
 * engenty wizards installed. It runs the same code (`console.ts`, `command.ts`); what it doesn't
 * know is a runtime on this computer. The run starts at the organization `--runtime`/`WIZARDS_URL`
 * names, with `--key`/`WIZARDS_API_KEY`, else on this computer alone with a model reached by
 * fetch (`alone.ts`). Its folder is `runs/<run id>` in `~/.engenty` (`ENGENTY_HOME` moves it).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseRunArgs } from "./command.js";
import { givenWhere, runHelp, runInTerminal } from "./console.js";

const COMMAND = "wizards-run";

async function main(argv: string[]): Promise<number> {
  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v")) {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    console.log(manifest.version);
    return 0;
  }
  const args = parseRunArgs(argv);
  if (typeof args === "string") {
    console.error(`${args} Run ${COMMAND} --help to see how.`);
    return 2;
  }
  if (args.help) {
    console.log(runHelp(COMMAND, false));
    return 0;
  }
  const base = process.env.ENGENTY_HOME?.trim() || join(homedir(), ".engenty");
  return runInTerminal(args, {
    where: givenWhere(args),
    runsDir: join(resolve(base), "runs"),
    command: COMMAND,
  });
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: Error) => {
    console.error(err.message);
    process.exitCode = 1;
  },
);
