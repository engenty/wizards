/**
 * `wizards run` in a real terminal: its help, where `--runtime` points, and the command run with
 * this process's stdin, stdout and stderr. Both commands use it: `wizards run` of engenty wizards
 * (apps/runtime/src/cli/run.ts), which also knows the runtime on this computer, and the small
 * package's own `wizards-run` (bin.ts), which knows only an address given or nothing.
 */
import { createInterface, type Interface } from "node:readline/promises";
import { styleText } from "node:util";
import { type RunArgs, type RunDeps, runCommand, type Where } from "./command.js";

const cyan = (text: string) => styleText("cyan", text);

/**
 * The help of `<command> <wizard>`. `local`: engenty wizards on this computer is where a run
 * starts when no address is given; else such a run is on this computer alone.
 */
export const runHelp = (command: string, local: boolean) => `Usage
  ${cyan(`${command} <wizard>`)} [answers] [options]
  ${cyan(`${command} --continue <run>`)} [answers] [options]

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
  --runtime <url>     where the run starts (WIZARDS_URL); default: ${local ? "engenty wizards on this computer" : "this computer alone"}
  --key <key>         an API key there that may run wizards from the command line (WIZARDS_API_KEY)
  --space <id>        the space the run belongs to; default: your first space
  --model <name>      ${local ? "without engenty wizards" : "without --runtime"}: the model to run with; default: Ollama’s first

${local ? "Without engenty wizards running and without --runtime" : "Without --runtime"}, a wizard that needs only a model runs on
this computer alone: with Ollama (OLLAMA_URL), else with your own API key (OPENAI_API_KEY).
Nothing about the run leaves this computer.

Exit codes: 0 done, 1 failed, 2 wrong arguments, 3 waits (--continue goes on with it).
`;

/**
 * The organization `--runtime`/`WIZARDS_URL` names, signed with `--key`/`WIZARDS_API_KEY`; null
 * when no address is given.
 */
export function givenWhere(
  args: Pick<RunArgs, "runtime" | "key">,
  env: Record<string, string | undefined> = process.env,
): Where | null {
  const url = (args.runtime ?? env.WIZARDS_URL ?? "").trim().replace(/\/+$/, "");
  if (!url) {
    return null;
  }
  return { url, headers: () => apiKeyHeaders(args, env), name: "this organization" };
}

/** `--key`/`WIZARDS_API_KEY` as the header the API reads; none without a key. */
export function apiKeyHeaders(
  args: Pick<RunArgs, "key">,
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const key = (args.key ?? env.WIZARDS_API_KEY ?? "").trim();
  return key ? { "x-api-key": key } : {};
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

/**
 * Runs the command with this process's terminal: questions on stderr when a person is at it,
 * answers piped in on stdin, the result on stdout. Answers the exit code.
 */
export async function runInTerminal(
  args: RunArgs,
  deps: Pick<RunDeps, "where" | "runsDir" | "command" | "openBrowser">,
): Promise<number> {
  // Questions need a person at a terminal; stdin that is piped carries answers instead.
  const interactive = Boolean(process.stdin.isTTY && process.stderr.isTTY);
  let lines: Interface | null = null;
  try {
    return await runCommand(args, {
      ...deps,
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
    });
  } finally {
    (lines as Interface | null)?.close();
  }
}
