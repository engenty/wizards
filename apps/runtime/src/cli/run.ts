import { join } from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import { parseRunArgs, type RunArgs, runCommand, type Where } from "@engenty/wizards-run/command";
import { LOCAL_MCP_HEADER, mintLocalTicket } from "../auth/local-ticket.js";
import { feature } from "../features.js";
import type { Layout } from "./home.js";
import { openBrowser, readSecret, runningRuntime, settings } from "./start.js";
import { cmd, cyan } from "./ui.js";

/**
 * `wizards run <wizard>`: runs a wizard in this terminal (`@engenty/wizards-run/command`). The run
 * starts at the organization `--runtime`/`WIZARDS_URL` names with `--key`/`WIZARDS_API_KEY`, else
 * at engenty wizards on this computer, signed with the data folder's secret as `wizards mcp` is,
 * else on this computer alone with a model reached by fetch. Its folder is `runs/<run id>` in
 * this install's home.
 */

export const RUN_HELP = (command: string) => `Usage
  ${cyan(`${command} run <wizard>`)} [answers] [options]
  ${cyan(`${command} run --continue <run>`)} [answers] [options]

Runs a wizard in this terminal: it asks each page’s fields, shows what a review shows and
prints the result. <wizard> is a folder with wizard.json, a .wizard file or an address.

Answers
  --<field>=<value>   the answer to a field, by its id; a field given twice holds a list
  --answers <file>    answers in a JSON file, by field id
  JSON on stdin       the same, piped in
                      Given answers aren’t asked. Without a terminal, a missing one stops the run.

Options
  --accept            accept every review without asking
  --json              print only the result, as JSON
  --out <folder>      save the result there, one file per part, with its files
  --open              open the run’s page in the browser as well
  --continue <run>    go on with a run that waits, e.g. for an answer or a review
  --runtime <url>     where the run starts (WIZARDS_URL); default: engenty wizards on this computer
  --key <key>         an API key there that may run wizards from the command line (WIZARDS_API_KEY)
  --space <id>        the space the run belongs to; default: your first space
  --model <name>      without engenty wizards: the model to run with; default: Ollama’s first

Without engenty wizards running and without --runtime, a wizard that needs only a model runs on
this computer alone: with Ollama (OLLAMA_URL), else with your own API key (OPENAI_API_KEY).
Nothing about the run leaves this computer.

Exit codes: 0 done, 1 failed, 2 wrong arguments, 3 waits (--continue goes on with it).
`;

/**
 * Where the run starts: the address given, else the runtime running on this install, else
 * nowhere (null): the run lives on this computer alone, with Ollama or an own API key.
 */
async function whereOf(args: RunArgs, paths: Layout): Promise<Where | null | string> {
  const url = (args.runtime ?? process.env.WIZARDS_URL ?? "").trim().replace(/\/+$/, "");
  const key = (args.key ?? process.env.WIZARDS_API_KEY ?? "").trim();
  const byKey = (): Record<string, string> => (key ? { "x-api-key": key } : {});
  if (url) {
    return { url, headers: byKey, name: "this organization" };
  }
  const running = await runningRuntime(settings(paths).dataDir);
  if (!running) {
    // This machine's word on the switch: there is nobody else to ask.
    return feature("wizardsRun")
      ? null
      : `engenty wizards isn’t running. To start it: ${cmd("start")}`;
  }
  const secret = readSecret(paths);
  if (!(key || secret)) {
    return "Couldn’t read the data folder’s secret. Give an API key with --key.";
  }
  return {
    url: `http://127.0.0.1:${running.port}`,
    headers: () =>
      key
        ? byKey()
        : { [LOCAL_MCP_HEADER]: mintLocalTicket(secret ?? "", Date.now(), "local-run") },
    name: "engenty wizards on this computer",
  };
}

async function readStdin(): Promise<string | null> {
  if (process.stdin.isTTY) {
    return null;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
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
    console.log(RUN_HELP(command));
    return 0;
  }
  const where = await whereOf(args, paths);
  if (typeof where === "string") {
    console.error(where);
    return 1;
  }
  // Questions need a person at a terminal; stdin that is piped carries answers instead.
  const interactive = Boolean(process.stdin.isTTY && process.stderr.isTTY);
  let lines: Interface | null = null;
  try {
    return await runCommand(args, {
      where,
      runsDir: join(paths.home, "runs"),
      command,
      io: {
        ask: interactive
          ? (question) => {
              lines ??= createInterface({ input: process.stdin, output: process.stderr });
              return lines.question(question);
            }
          : null,
        say: (line) => {
          process.stderr.write(`${line}\n`);
        },
      },
      out: (text) => {
        process.stdout.write(text);
      },
      stdin: args.answersFile ? undefined : readStdin,
      openBrowser,
    });
  } finally {
    (lines as Interface | null)?.close();
  }
}
