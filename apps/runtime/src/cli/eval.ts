import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { LOCAL_MCP_HEADER, mintLocalTicket } from "../auth/local-ticket.js";
import type { Layout } from "./home.js";
import { readSecret, runningRuntime, settings } from "./start.js";
import { bad, cmd, dim, ok, tilde } from "./ui.js";

/**
 * `wizards eval <wizard> --dataset <file>`: a wizard in version 0.3.0 of the running studio over
 * a dataset (docs/plans/kernel.md, item 14). The file is a JSON list of entries, each a `name`,
 * the `input` and, by step, the `answers` to the run's waits in order. Each entry becomes a test
 * run, judged by the wizard's evals; the runs stay in the studio with their rows and scores.
 * Signed with the data folder's secret, as `wizards logs` is. The steps and evals use the
 * studio's models and cost what a test run costs.
 */

type Score = { eval: string; row: number; score: number | null; why?: string; error?: string };
type Line =
  | { working: true }
  | { entry: { name: string; runId: string; status: string; error?: string; scores: Score[] } }
  | { summary: Record<string, { mean?: number; scores: number; errors: number }> }
  | { error: string; issues?: { message: string }[] };

const number = (value: number) => value.toFixed(2).replace(/\.?0+$/, "") || "0";

function printLine(line: Line, asJson: boolean): boolean {
  if (asJson) {
    if (!("working" in line)) {
      console.log(JSON.stringify(line));
    }
    return !("error" in line);
  }
  if ("entry" in line) {
    const { entry } = line;
    const mark = entry.status === "failed" ? bad : ok;
    console.log(`${mark} ${entry.name} ${dim(`${entry.status} · run ${entry.runId}`)}`);
    if (entry.error) {
      console.log(`  ${entry.error}`);
    }
    for (const score of entry.scores) {
      const said =
        score.score == null ? `could not judge: ${score.error ?? ""}` : number(score.score);
      console.log(`  ${score.eval.padEnd(28)} ${said}${score.why ? dim(`  ${score.why}`) : ""}`);
    }
  } else if ("summary" in line) {
    const evals = Object.entries(line.summary);
    console.log(evals.length ? "\nMean over the entries" : dim("\nThe wizard has no evals."));
    for (const [id, found] of evals) {
      const mean = found.mean === undefined ? "–" : number(found.mean);
      const errors = found.errors ? dim(`  ${found.errors} could not judge`) : "";
      console.log(`  ${id.padEnd(28)} ${mean} ${dim(`of ${found.scores}`)}${errors}`);
    }
  } else if ("error" in line) {
    console.error(`${bad} ${line.error}`);
    for (const issue of line.issues ?? []) {
      console.error(`  ${issue.message}`);
    }
    return false;
  }
  return true;
}

export async function evalCommand(
  paths: Layout,
  wizard: string,
  datasetPath: string,
  asJson: boolean,
): Promise<number> {
  if (!wizard || !datasetPath) {
    console.error(`Name the wizard and the dataset: ${cmd("eval <wizard> --dataset <file>")}`);
    return 2;
  }
  let dataset: unknown;
  try {
    dataset = JSON.parse(readFileSync(resolve(datasetPath), "utf8"));
  } catch (err) {
    console.error(`Couldn’t read ${datasetPath}: ${(err as Error).message}`);
    return 2;
  }
  const { dataDir } = settings(paths);
  const running = await runningRuntime(dataDir);
  if (!running) {
    console.error(`engenty wizards isn’t running. To start it: ${cmd("start")}`);
    return 1;
  }
  const secret = readSecret(paths);
  if (!secret) {
    console.error(`Couldn’t read the data folder’s secret (${tilde(join(dataDir, "secret"))}).`);
    return 1;
  }
  const res = await fetch(`http://127.0.0.1:${running.port}/api/local/eval`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [LOCAL_MCP_HEADER]: mintLocalTicket(secret, Date.now(), "local-eval"),
    },
    body: JSON.stringify({ wizard, dataset }),
  });
  if (!(res.ok && res.body)) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    console.error(`${bad} ${body.error ?? `The studio answered ${res.status}.`}`);
    return 1;
  }
  let fine = true;
  let rest = "";
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    rest += decoder.decode(chunk, { stream: true });
    const lines = rest.split("\n");
    rest = lines.pop() ?? "";
    for (const text of lines.filter((l) => l.trim())) {
      fine = printLine(JSON.parse(text) as Line, asJson) && fine;
    }
  }
  return fine ? 0 : 1;
}
