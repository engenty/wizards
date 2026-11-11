import { join } from "node:path";
import { parseRunArgs, type RunArgs, type Where } from "@engenty/wizards-run/command";
import { apiKeyHeaders, givenWhere, runHelp, runInTerminal } from "@engenty/wizards-run/console";
import { LOCAL_MCP_HEADER, mintLocalTicket } from "../auth/local-ticket.js";
import { feature } from "../features.js";
import type { Layout } from "./home.js";
import { openBrowser, readSecret, runningRuntime, settings } from "./start.js";
import { cmd } from "./ui.js";

/**
 * `wizards run <wizard>`: runs a wizard in this terminal (`@engenty/wizards-run`, whose own
 * `wizards-run` runs the same code). The run starts at the organization `--runtime`/`WIZARDS_URL`
 * names with `--key`/`WIZARDS_API_KEY`, else at engenty wizards on this computer, signed with the
 * data folder's secret as `wizards mcp` is, else on this computer alone with a model reached by
 * fetch. Its folder is `runs/<run id>` in this install's home.
 */

/**
 * Where the run starts: the address given, else the runtime running on this install, else
 * nowhere (null): the run lives on this computer alone, with Ollama or an own API key.
 */
async function whereOf(args: RunArgs, paths: Layout): Promise<Where | null | string> {
  const given = givenWhere(args);
  if (given) {
    return given;
  }
  const running = await runningRuntime(settings(paths).dataDir);
  if (!running) {
    // This machine's word on the switch: there is nobody else to ask.
    return feature("wizardsRun")
      ? null
      : `engenty wizards isn’t running. To start it: ${cmd("start")}`;
  }
  const byKey = apiKeyHeaders(args);
  const keyed = Object.keys(byKey).length > 0;
  const secret = readSecret(paths);
  if (!(keyed || secret)) {
    return "Couldn’t read the data folder’s secret. Give an API key with --key.";
  }
  return {
    url: `http://127.0.0.1:${running.port}`,
    headers: () =>
      keyed
        ? byKey
        : { [LOCAL_MCP_HEADER]: mintLocalTicket(secret ?? "", Date.now(), "local-run") },
    name: "engenty wizards on this computer",
  };
}

export async function runWizardCommand(
  argv: string[],
  paths: Layout,
  command: string,
): Promise<number> {
  const args = parseRunArgs(argv);
  if (typeof args === "string") {
    console.error(`${args} Run ${cmd("run --help")} to see how.`);
    return 2;
  }
  if (args.help) {
    console.log(runHelp(`${command} run`, true));
    return 0;
  }
  const where = await whereOf(args, paths);
  if (typeof where === "string") {
    console.error(where);
    return 1;
  }
  return runInTerminal(args, {
    where,
    runsDir: join(paths.home, "runs"),
    command: `${command} run`,
    openBrowser,
  });
}
