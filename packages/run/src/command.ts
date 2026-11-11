/**
 * `wizards run <source>` (docs/plans/runs-on-their-own.md, phase 5): runs a wizard in this
 * process, with the terminal as its door.
 *
 * 1. The wizard comes from a folder, a `.wizard` file or an address (`resolveWizard`).
 * 2. The organization (or engenty wizards on this computer) starts the run: it checks the wizard,
 *    keeps the run's record and answers with the run's token and where its services are
 *    (`POST /api/v1/spaces/:spaceId/runs`, host `node`). With neither (`where` null), the run
 *    starts here alone: only a wizard that needs nothing but a model, which Ollama or an own API
 *    key gives (`alone.ts`). Its folder is its only record.
 * 3. `nodeHost` drives the run in a folder of its own, `<runs>/<run id>/`, which also keeps what
 *    `--continue` needs to go on with it in another process (`start.json`, the token among it).
 * 4. The terminal asks the pages and reviews (`terminal.ts`); the result goes to stdout or a folder.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { handOverSchema } from "@engenty/wizards-engine/host-api";
import type { WizardDefinition } from "@engenty/wizards-shared/definition";
import type { WorkspaceFile } from "@engenty/wizards-shared/workspace";
import { z } from "zod";
import {
  type AloneModel,
  aloneMissing,
  aloneServices,
  findModel,
  keepWorkspace,
  modelWords,
} from "./alone.js";
import { type NodeHost, nodeHost } from "./node-host.js";
import { type ResolvedWizard, resolveWizard, WizardRefused } from "./resolve.js";
import {
  type DoorEnd,
  keepResultFiles,
  RESULT_FILES,
  type RunResult,
  resultOf,
  type TerminalIO,
  terminalDoor,
  writeResult,
} from "./terminal.js";

export interface RunArgs {
  /** A folder, a `.wizard` file or an address; null with `continue`. */
  source: string | null;
  /** The run to go on with. */
  continue: string | null;
  /** `--<field>=<value>`: answers by field id. A field given twice holds a list. */
  answers: Record<string, unknown>;
  /** A JSON file of answers by field id. */
  answersFile: string | null;
  json: boolean;
  accept: boolean;
  open: boolean;
  out: string | null;
  runtime: string | null;
  key: string | null;
  space: string | null;
  /** Without an organization: the model to run with; left out, Ollama’s first. */
  model: string | null;
  help: boolean;
}

/** Options of the command itself; any other `--name` is an answer. */
const VALUED = { "--out": "out", "--continue": "continue", "--answers": "answersFile" } as const;
const WHERE = {
  "--runtime": "runtime",
  "--key": "key",
  "--space": "space",
  "--model": "model",
} as const;
const SWITCHES = { "--json": "json", "--accept": "accept", "--open": "open" } as const;

/** The arguments after `run`; a string says what is wrong with them. */
export function parseRunArgs(argv: string[]): RunArgs | string {
  const args: RunArgs = {
    source: null,
    continue: null,
    answers: {},
    answersFile: null,
    json: false,
    accept: false,
    open: false,
    out: null,
    runtime: null,
    key: null,
    space: null,
    model: null,
    help: false,
  };
  const answer = (id: string, value: string | boolean) => {
    const had = args.answers[id];
    args.answers[id] =
      had === undefined ? value : Array.isArray(had) ? [...had, value] : [had, value];
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      if (args.source !== null) {
        return `Unexpected argument “${arg}”.`;
      }
      args.source = arg;
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq < 0 ? arg : arg.slice(0, eq);
    const inline = eq < 0 ? null : arg.slice(eq + 1);
    const next = () => {
      if (inline !== null) {
        return inline;
      }
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        return null;
      }
      i++;
      return value;
    };
    if (name in SWITCHES) {
      args[SWITCHES[name as keyof typeof SWITCHES]] = true;
    } else if (name in VALUED || name in WHERE) {
      const value = next();
      if (!value) {
        return `${name} needs a value.`;
      }
      const key = { ...VALUED, ...WHERE }[name as keyof typeof VALUED | keyof typeof WHERE];
      args[key] = value;
    } else {
      const id = name.slice(2);
      if (!id) {
        return `Unknown option ${arg}.`;
      }
      answer(id, next() ?? true);
    }
  }
  if (args.help) {
    return args;
  }
  if (args.continue && args.source) {
    return "Give a wizard or --continue with a run, not both.";
  }
  if (!(args.continue || args.source)) {
    return "Which wizard? Give a folder, a .wizard file or an address.";
  }
  return args;
}

/** Where runs start: the organization, or engenty wizards on this computer. */
export interface Where {
  /** Its origin: `https://engenty.ai`, `http://127.0.0.1:24368`. */
  url: string;
  /** What signs a call to its API: an API key, or this computer's signature. */
  headers(): Record<string, string>;
  /** How messages name it: "this organization", "engenty wizards on this computer". */
  name: string;
}

export interface RunDeps {
  /**
   * Null: no organization and no engenty wizards here. The run lives on this computer only, with
   * a model reached by fetch (`alone.ts`), and only a wizard that needs nothing more starts.
   */
  where: Where | null;
  /** Left out: `process.env`. Where Ollama answers, an own API key (`findModel`). */
  env?: Record<string, string | undefined>;
  /** The folder the runs' folders go in. */
  runsDir: string;
  io: TerminalIO;
  /** The result: stdout. */
  out(text: string): void;
  /** How the command is typed, for hints: `wizards`. */
  command: string;
  /** Left out: the global `fetch`. Reaches the API and the run's services. */
  fetch?: typeof fetch;
  /** The answers piped in, as text; null or left out: none. */
  stdin?: () => Promise<string | null>;
  /** Opens an address in the browser; false when there is none here. */
  openBrowser?(url: string): boolean;
}

/** What the start route answers: the run handed over, and where it lives. */
const startedSchema = handOverSchema.extend({
  wizardId: z.string(),
  services: z.string(),
  host: z.object({ kind: z.string(), url: z.string() }),
});

/** What a run's folder keeps beside the run, for `--continue`. Holds the run's token: the file is the person's alone. */
interface StartFile {
  runId: string;
  wizardId: string;
  token: string;
  services: string;
  runtime: string;
  spaceId: string;
  title: string;
  definition: WizardDefinition;
  files: WorkspaceFile[];
  /** The revision of the run's record when it started: the host's writes go on from it. */
  rev: number;
  /**
   * A run without an organization: the model it runs with, its API key left out. Such a run has
   * no token, tenant, wizard or space (empty strings) and no services' address.
   */
  alone?: Omit<AloneModel, "key">;
}

const START_FILE = "start.json";
/** Which wizard of a space each source ran as, so a source runs as the same wizard each time. */
const WIZARDS_FILE = "wizards.json";

/** Exit codes: the run is done; it failed or was stopped; it waits (`--continue` goes on). */
export const EXIT = { done: 0, failed: 1, usage: 2, waits: 3 } as const;

class Refused extends Error {}

export async function runCommand(args: RunArgs, deps: RunDeps): Promise<number> {
  const { io } = deps;
  const fetchOf = deps.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const env = deps.env ?? process.env;
  let answers: Record<string, unknown>;
  let start: StartFile;
  let model: AloneModel | null = null;
  try {
    answers = await answersOf(args, deps);
    if (args.continue) {
      start = await readStart(deps.runsDir, args.continue);
      model = start.alone ? keyOf(start.alone, env) : null;
    } else if (deps.where) {
      start = await startRun(args, deps.where, deps, fetchOf);
    } else {
      ({ start, model } = await startAlone(args, deps, env, fetchOf));
    }
  } catch (err) {
    if (err instanceof Refused || err instanceof WizardRefused) {
      io.say(err.message);
      return EXIT.failed;
    }
    throw err;
  }

  const dir = join(deps.runsDir, start.runId);
  let node: NodeHost | null = null;
  node = await nodeHost({
    dir,
    services: model
      ? {
          alone: aloneServices({
            model,
            dir,
            def: start.definition,
            say: (line) => io.say(line),
            fetch: fetchOf,
          }),
        }
      : { url: start.services, token: start.token, fetch: fetchOf },
    def: start.definition,
    files: start.files,
    run: { id: start.runId, rev: start.rev },
    // The result's files, fetched while the run's token still reaches them.
    onWrite: async (run) => {
      if (run.status !== "done" || !node) {
        return;
      }
      try {
        await keepResultFiles(node.host.services.files, start.definition, run, dir);
      } catch (err) {
        io.say(`The result’s files couldn’t be fetched: ${(err as Error).message}`);
      }
    },
  });
  try {
    if (model) {
      // No organization keeps the run or tells anyone of it: its folder is all there is.
      io.say(`This run is on this computer only, with ${modelWords(model)}.`);
      if (args.open) {
        io.say("It has no page to open.");
      }
    } else if (args.open) {
      const page = `${start.services.replace(/\/+$/, "")}/studio/edit/${start.wizardId}?run=${start.runId}`;
      if (!deps.openBrowser?.(page)) {
        io.say(`The run’s page: ${page}`);
      }
    }
    io.say(`${args.continue ? "Going on with" : "Running"} “${start.title}” (run ${start.runId})`);
    const end = await terminalDoor(node, start.definition, io, {
      answers,
      accept: args.accept,
    });
    return await give(end, start, dir, args, deps);
  } finally {
    await node.close();
  }
}

/** The answers given before the run: a file or stdin, then the flags over them. */
async function answersOf(args: RunArgs, deps: RunDeps): Promise<Record<string, unknown>> {
  let text: string | null = null;
  let from = "";
  if (args.answersFile) {
    from = args.answersFile;
    try {
      text = await readFile(args.answersFile, "utf8");
    } catch {
      throw new Refused(`Couldn’t read ${args.answersFile}.`);
    }
  } else if (deps.stdin) {
    from = "stdin";
    text = await deps.stdin();
  }
  let given: Record<string, unknown> = {};
  if (text?.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (!(parsed && typeof parsed === "object" && !Array.isArray(parsed))) {
      throw new Refused(`The answers in ${from} aren’t a JSON object of field ids and values.`);
    }
    given = parsed as Record<string, unknown>;
  }
  return { ...given, ...args.answers };
}

async function readStart(runsDir: string, runId: string): Promise<StartFile> {
  try {
    return JSON.parse(await readFile(join(runsDir, runId, START_FILE), "utf8")) as StartFile;
  } catch {
    throw new Refused(`There’s no run ${runId} on this computer.`);
  }
}

/**
 * A run without an organization: the wizard if it needs nothing but a model, the model if one
 * answers, and a folder of its own with the workspace in it. Nothing is asked of anyone else.
 */
async function startAlone(
  args: RunArgs,
  deps: RunDeps,
  env: Record<string, string | undefined>,
  fetchOf: typeof fetch,
): Promise<{ start: StartFile; model: AloneModel }> {
  const wizard: ResolvedWizard = await resolveWizard(args.source ?? "");
  const missing = aloneMissing(
    wizard.definition,
    wizard.files.map((f) => f.path),
  );
  if (missing.length) {
    throw new Refused(
      [
        `${wizard.source.where} can’t run on this computer alone:`,
        ...missing.map((line) => `  ${line}`),
        "It runs with engenty wizards, or at your organization with --runtime.",
      ].join("\n"),
    );
  }
  const model = await findModel({ env, model: args.model, fetch: fetchOf });
  if (typeof model === "string") {
    throw new Refused(model);
  }
  const { key: _, ...kept } = model;
  const start: StartFile = {
    runId: randomBytes(8).toString("hex"),
    wizardId: "",
    token: "",
    services: "",
    runtime: "",
    spaceId: "",
    title: wizard.definition.title,
    definition: wizard.definition,
    files: wizard.files.map(({ data: _data, ...f }) => f),
    rev: 1,
    alone: kept,
  };
  const dir = join(deps.runsDir, start.runId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await keepWorkspace(dir, wizard.files);
  await writeFile(join(dir, START_FILE), JSON.stringify(start), { mode: 0o600 });
  return { start, model };
}

/** The model a run without an organization goes on with: an API key comes from the environment again. */
function keyOf(
  model: Omit<AloneModel, "key">,
  env: Record<string, string | undefined>,
): AloneModel {
  if (model.way !== "key") {
    return model;
  }
  const key = env.OPENAI_API_KEY?.trim();
  if (!key) {
    throw new Refused("The run uses your own API key. Set OPENAI_API_KEY again to go on with it.");
  }
  return { ...model, key };
}

/** Calls the API of `where`; answers its status and JSON body. */
async function api(
  where: Where,
  fetchOf: typeof fetch,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  let res: Response;
  try {
    res = await fetchOf(`${where.url.replace(/\/+$/, "")}/api/v1${path}`, {
      method: init.method ?? "GET",
      headers: {
        ...where.headers(),
        "x-wizards-client": "cli",
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch (err) {
    throw new Refused(`Couldn’t reach ${where.url}: ${(err as Error).message}`);
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body };
}

/** What a refusal of the API says: its own words, or what its status means. */
function refusal(where: Where, status: number, body: Record<string, unknown>): string {
  const said = typeof body.error === "string" ? body.error : "";
  if (status === 401) {
    return "The API key isn’t valid. Give one with --key or WIZARDS_API_KEY.";
  }
  if (body.code === "insufficient_scope") {
    return "This API key may not run wizards from the command line. Make a key that may.";
  }
  return said || `${where.url} answered ${status}.`;
}

async function startRun(
  args: RunArgs,
  where: Where,
  deps: RunDeps,
  fetchOf: typeof fetch,
): Promise<StartFile> {
  const wizard: ResolvedWizard = await resolveWizard(args.source ?? "");
  let spaceId = args.space;
  if (!spaceId) {
    const space = await api(where, fetchOf, "/space");
    if (space.status !== 200 || typeof space.body.id !== "string") {
      throw new Refused(refusal(where, space.status, space.body));
    }
    spaceId = space.body.id;
  }
  const known = await readKnown(deps.runsDir);
  const key = `${where.url} ${spaceId} ${wizard.source.where}`;
  const body = {
    host: "node",
    definition: wizard.definition,
    files: wizard.files.map((f) => ({
      path: f.path,
      mime: f.mime,
      data: Buffer.from(f.data).toString("base64"),
    })),
  };
  const path = `/spaces/${encodeURIComponent(spaceId)}/runs`;
  let res = await api(where, fetchOf, path, {
    method: "POST",
    body: known[key] ? { ...body, wizardId: known[key] } : body,
  });
  if (res.status === 404 && known[key]) {
    // The wizard it ran as before is gone: a new one holds it.
    res = await api(where, fetchOf, path, { method: "POST", body });
  }
  if (res.status === 404) {
    const space = await api(where, fetchOf, `/space?space=${encodeURIComponent(spaceId)}`);
    throw new Refused(
      space.status === 404
        ? `There’s no space ${spaceId} at ${where.url}.`
        : `Running wizards from the command line isn’t available for ${where.name} yet.`,
    );
  }
  if (res.status === 400 && Array.isArray(res.body.issues)) {
    const issues = res.body.issues as { stepId?: string; message: string }[];
    throw new Refused(
      [
        `${wizard.source.where} can’t run:`,
        ...issues.map((i) => `  ${i.stepId ? `${i.stepId}: ` : ""}${i.message}`),
      ].join("\n"),
    );
  }
  if (res.status !== 200) {
    throw new Refused(refusal(where, res.status, res.body));
  }
  const started = startedSchema.parse(res.body);
  await writeKnown(deps.runsDir, { ...known, [key]: started.wizardId });
  const start: StartFile = {
    runId: started.runId,
    wizardId: started.wizardId,
    token: started.token,
    services: started.services,
    runtime: where.url,
    spaceId,
    title: started.definition.title,
    definition: started.definition,
    files: started.files,
    rev: started.run.rev,
  };
  const dir = join(deps.runsDir, started.runId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, START_FILE), JSON.stringify(start), { mode: 0o600 });
  return start;
}

async function readKnown(runsDir: string): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(join(runsDir, WIZARDS_FILE), "utf8")) as Record<
      string,
      string
    >;
  } catch {
    return {};
  }
}

async function writeKnown(runsDir: string, known: Record<string, string>) {
  await mkdir(runsDir, { recursive: true, mode: 0o700 });
  await writeFile(join(runsDir, WIZARDS_FILE), JSON.stringify(known, null, 2));
}

/** Gives the run's end back: the result, what failed, or what the run waits for. */
async function give(
  end: DoorEnd,
  start: StartFile,
  dir: string,
  args: RunArgs,
  deps: RunDeps,
): Promise<number> {
  const { io } = deps;
  const result: RunResult = resultOf(start.runId, start.definition, end.state, dir);
  const again = `${deps.command} run --continue ${start.runId}`;
  if (end.kind === "waits") {
    if (args.json) {
      deps.out(`${JSON.stringify({ ...result, status: end.state.run.status, waits: end.why })}\n`);
    }
    io.say("");
    for (const line of end.why) {
      io.say(line);
    }
    io.say(`To go on with it: ${again}`);
    return EXIT.waits;
  }
  const written = args.out ? await writeResult(result, args.out) : [];
  if (args.json) {
    deps.out(`${JSON.stringify({ ...result, ...(args.out ? { written } : {}) })}\n`);
  }
  if (result.status !== "done") {
    io.say(
      result.status === "failed"
        ? `The run failed${result.error ? `: ${result.error}` : "."}`
        : "The run was stopped.",
    );
    return EXIT.failed;
  }
  if (args.out) {
    io.say(`Saved the result in ${args.out}:`);
    for (const path of written) {
      io.say(`  ${path}`);
    }
  } else if (!args.json) {
    const parts = result.parts.filter((p) => p.text);
    deps.out(
      `${parts.map((p) => (parts.length > 1 ? `## ${p.label}\n\n${p.text}` : p.text)).join("\n\n")}\n`,
    );
    const files = result.parts.flatMap((p) => p.files);
    if (files.length) {
      io.say(`Its files are in ${join(dir, RESULT_FILES)}.`);
    }
  }
  return EXIT.done;
}
