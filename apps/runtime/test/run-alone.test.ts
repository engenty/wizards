import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRunArgs, type RunArgs, runCommand } from "@engenty/wizards-run/command";
import { wizardSchema } from "@engenty/wizards-shared/definition";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decision } from "./fixtures/pinned-runs/runs.js";

/**
 * `wizards run` without an organization (docs/plans/runs-on-their-own.md, 5.5): no engenty
 * wizards running, no `--runtime`, nothing installed but Ollama. The refund example
 * (fixtures/refund, the pinned decision run's steps) runs to its end on this computer alone: its
 * model is a fake Ollama on a local port that streams scripted answers as Ollama's
 * OpenAI-compatible API does, and nothing else is called. A wizard that needs what only an
 * organization has (a connection, an AI client installed with engenty wizards) is refused before
 * anything starts.
 *
 * This file loads nothing of the runtime: the run needs none of it.
 */

const REFUND = fileURLToPath(new URL("./fixtures/refund", import.meta.url));
const MESSAGE = "Broken on arrival, I want my money back!";

interface Asked {
  path: string;
  /** "<step>" for a written answer, "<step>?" for a decision, as the pinned run lists them. */
  call: string | null;
  model?: string;
}

/** Everything the fake Ollama was asked. */
const asked: Asked[] = [];
let ollama: Server;
let ollamaUrl = "";

/** What the pinned refund run answers, by what the call asks. */
function answer(body: {
  messages: { content: string | null }[];
  response_format?: { json_schema?: { schema?: { properties?: Record<string, unknown> } } };
}): { call: string; text: string } {
  const said = body.messages.map((m) => m.content ?? "").join("\n");
  const asks = body.response_format?.json_schema?.schema?.properties ?? null;
  if (asks) {
    // The decision step's question, then the branch rule of "refund": its first `ask`.
    return "kind" in asks
      ? { call: "triage?", text: JSON.stringify({ kind: "refund" }) }
      : { call: "refund?", text: JSON.stringify({ next: "r0" }) };
  }
  if (said.includes("Start the refund.")) {
    return { call: "refund", text: "Refund started." };
  }
  if (said.includes("Apologise.")) {
    return { call: "soothe", text: "We are sorry." };
  }
  return { call: "?", text: "?" };
}

/** A chunk of a streamed chat completion, as Ollama sends one. */
const chunk = (model: string, delta: object, finish: string | null = null) =>
  `data: ${JSON.stringify({
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1,
    model,
    system_fingerprint: "fp_ollama",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;

beforeAll(async () => {
  ollama = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      const path = req.url ?? "";
      if (req.method === "GET" && path === "/v1/models") {
        asked.push({ path, call: null });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            object: "list",
            data: [
              { id: "nomic-embed-text:latest", object: "model", owned_by: "library" },
              { id: "tiny:1b", object: "model", owned_by: "library" },
            ],
          }),
        );
        return;
      }
      if (req.method === "POST" && path === "/v1/chat/completions") {
        const body = JSON.parse(raw);
        const { call, text } = answer(body);
        asked.push({ path, call, model: body.model });
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(chunk(body.model, { role: "assistant", content: "" }));
        // The answer in two pieces, as a model streams it.
        const half = Math.ceil(text.length / 2);
        res.write(chunk(body.model, { role: "assistant", content: text.slice(0, half) }));
        res.write(chunk(body.model, { role: "assistant", content: text.slice(half) }));
        res.write(chunk(body.model, { role: "assistant", content: "" }, "stop"));
        res.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-1",
            object: "chat.completion.chunk",
            choices: [],
            usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
          })}\n\n`,
        );
        res.end("data: [DONE]\n\n");
        return;
      }
      asked.push({ path, call: null });
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
  });
  await new Promise<void>((resolve) => ollama.listen(0, "127.0.0.1", resolve));
  ollamaUrl = `http://127.0.0.1:${(ollama.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => ollama.close(resolve));
});

interface Ran {
  code: number;
  out: string;
  said: string[];
}

/** `wizards run <argv>` with no organization and nobody at the terminal. */
async function run(
  argv: string[],
  runsDir: string,
  env: Record<string, string | undefined> = { OLLAMA_URL: ollamaUrl },
): Promise<Ran> {
  const args = parseRunArgs(argv) as RunArgs;
  expect(typeof args).toBe("object");
  const ran: Ran = { code: -1, out: "", said: [] };
  ran.code = await runCommand(args, {
    where: null,
    env,
    runsDir,
    command: "wizards run",
    io: {
      ask: null,
      say: (line) => {
        ran.said.push(line);
      },
    },
    out: (text) => {
      ran.out += text;
    },
  });
  return ran;
}

/** The run's log as its folder keeps it: [step, type, a note by its code and params, else its text]. */
const logOf = (dir: string) =>
  readFileSync(join(dir, "events.ndjson"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .map((e) => [
      e.stepId,
      e.type,
      e.note
        ? `${e.note.code}${e.note.params ? ` ${JSON.stringify(e.note.params)}` : ""}`
        : e.message,
    ]);

/** A wizard in a folder of its own. */
function wizardFolder(definition: object): string {
  const dir = mkdtempSync(join(tmpdir(), "wizards-run-alone-wizard-"));
  writeFileSync(join(dir, "wizard.json"), JSON.stringify(definition));
  return dir;
}

describe("wizards run without an organization", () => {
  it("the refund example is the pinned decision run's steps", () => {
    const fixture = JSON.parse(readFileSync(join(REFUND, "wizard.json"), "utf8"));
    expect(wizardSchema.parse(fixture.definition).steps).toEqual(decision.wizard.steps);
  });

  it("runs the refund example with Ollama and nothing else, every answer by flag", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "wizards-run-alone-"));
    asked.length = 0;
    const ran = await run([REFUND, `--message=${MESSAGE}`, "--json"], runsDir);
    expect(ran.code, ran.said.join("\n")).toBe(0);
    expect(ran.said).toContain("This run is on this computer only, with tiny:1b on Ollama.");

    const result = JSON.parse(ran.out);
    expect(result).toMatchObject({
      status: "done",
      error: null,
      parts: [
        { from: "triage", text: "What does the customer want?: refund", json: { kind: "refund" } },
        { from: "refund", text: "Refund started." },
        { from: "soothe", text: "We are sorry." },
      ],
    });

    // What the model was asked, as the pinned run has it, and nothing but the model was called.
    expect(asked.filter((a) => a.call).map((a) => a.call)).toEqual(decision.calls);
    expect(asked.filter((a) => a.model).every((a) => a.model === "tiny:1b")).toBe(true);
    expect(new Set(asked.map((a) => a.path))).toEqual(
      new Set(["/v1/models", "/v1/chat/completions"]),
    );

    // The run's folder is its record: the pinned log and state.
    const dir = join(runsDir, result.runId);
    expect(logOf(dir)).toEqual(decision.log);
    const stored = JSON.parse(readFileSync(join(dir, "run.json"), "utf8"));
    expect({ cursor: stored.run.cursor, status: stored.run.status }).toEqual({
      cursor: "done",
      status: "done",
    });
    expect(stored.run.state).toEqual(decision.state);

    // No token, no organization: what the folder keeps names the model and no key.
    const start = JSON.parse(readFileSync(join(dir, "start.json"), "utf8"));
    expect(start).toMatchObject({
      runId: result.runId,
      token: "",
      services: "",
      alone: { way: "ollama", url: `${ollamaUrl}/v1`, name: "tiny:1b" },
    });
    expect(start.alone.key).toBeUndefined();
  });

  it("waits for a missing answer, and --continue goes on with the run alone", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "wizards-run-alone-"));
    // The refund example with its one field required: without an answer, the run waits there.
    const { definition } = JSON.parse(readFileSync(join(REFUND, "wizard.json"), "utf8"));
    definition.steps[0].fields[0].required = true;
    const refund = wizardFolder(definition);
    const waits = await run([refund, "--model", "tiny:1b"], runsDir);
    expect(waits.code, waits.said.join("\n")).toBe(3);
    const again = waits.said.find((line) => line.startsWith("To go on with it: "));
    const runId = again?.split(" ").at(-1) ?? "";
    expect(again).toBe(`To go on with it: wizards run --continue ${runId}`);

    const ran = await run(["--continue", runId, `--message=${MESSAGE}`, "--json"], runsDir);
    expect(ran.code, ran.said.join("\n")).toBe(0);
    expect(ran.said).toContain("This run is on this computer only, with tiny:1b on Ollama.");
    expect(JSON.parse(ran.out)).toMatchObject({ runId, status: "done" });
  });

  it("refuses a wizard that needs a connection or an installed AI client before it starts", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "wizards-run-alone-"));
    const mail = wizardFolder({
      version: 1,
      title: "Mail digest",
      requires: { models: ["standard"], connections: ["mail"] },
      connections: [{ id: "inbox", kind: "mail" }],
      steps: [
        {
          id: "read",
          type: "agent",
          title: "Read the mail",
          instructions: "Sum up today's mail.",
          connections: ["inbox"],
          output: { format: "text" },
        },
        { id: "done", type: "result", title: "Done", deliverables: [] },
      ],
    });
    const film = wizardFolder({
      version: 1,
      title: "Film",
      requires: { models: ["low"] },
      steps: [
        { id: "film", type: "motion-graphics", title: "The film", brief: "A short film." },
        { id: "done", type: "result", title: "Done", deliverables: [] },
      ],
    });
    asked.length = 0;

    const refusedMail = await run([mail, "--json"], runsDir);
    expect(refusedMail.code).toBe(1);
    expect(refusedMail.said).toEqual([
      [
        `${mail} can’t run on this computer alone:`,
        "  It connects to accounts. Only engenty wizards keeps connections.",
        "It runs with engenty wizards, or at your organization with --runtime.",
      ].join("\n"),
    ]);

    const refusedFilm = await run([film, "--json"], runsDir);
    expect(refusedFilm.code).toBe(1);
    expect(refusedFilm.said).toEqual([
      [
        `${film} can’t run on this computer alone:`,
        "  “The film” is made by engenty wizards. It can’t run on this computer alone.",
        "It runs with engenty wizards, or at your organization with --runtime.",
      ].join("\n"),
    ]);

    // Nothing started: no model was asked, no run has a folder.
    expect(asked).toEqual([]);
    expect(readdirSync(runsDir)).toEqual([]);
  });

  it("says so when nothing on this computer runs a model", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "wizards-run-alone-"));
    const ran = await run([REFUND, `--message=${MESSAGE}`], runsDir, {
      OLLAMA_URL: "http://127.0.0.1:9/v1",
    });
    expect(ran.code).toBe(1);
    expect(ran.said).toEqual([
      "Nothing on this computer runs a model. Start Ollama, or set OPENAI_API_KEY to your own API key.",
    ]);
    expect(readdirSync(runsDir)).toEqual([]);
  });
});
