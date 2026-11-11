import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRunArgs, type RunArgs, runCommand } from "@engenty/wizards-run/command";
import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * `wizards run` (docs/plans/runs-on-their-own.md, 5.3): the weather example from its folder,
 * started at this runtime with an API key, driven by a host in this process with the terminal as
 * its door, its copies reaching the record (`run.report`) so the studio lists it as it ends. Once
 * with every answer given and the review accepted by flag (nobody there), once with a person who
 * types the answers.
 *
 * The weather example's forecast step is a plain agent step and its model is scripted here: the
 * real one would call a weather API, and the tests make no outside calls.
 */
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "wizards-run-cli-"));
process.env.APP_URL = "http://localhost:5181";
process.env.LOCAL_ACCESS_KEY = "test-key";
process.env.MARKETPLACE_URL = "off";
process.env.AI_GATEWAY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.RUNTIME_ROLE = "all";
process.env.PLUGINS_WATCH = "0";
process.env.PLUGIN_JOBS = "0";
const ON = "durableRuns=on,runServices=on,runHosts=on,wizardsRun=on";
process.env.FEATURES = ON;

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

/** The forecast, from the place and day the prompt names. */
const scripted = vi.hoisted(() => ({ prompts: [] as string[] }));
const forecast = (prompt: string) => {
  const place = /field=\\"place\\">(\w+)<.*field=\\"day\\">(\w+)</.exec(prompt);
  return place ? `${place[1]} ${place[2]}: sun, 21 degrees.` : "No place given.";
};
const model = () =>
  new MockLanguageModelV3({
    doGenerate: async (options) => {
      const prompt = JSON.stringify(options.prompt);
      scripted.prompts.push(prompt);
      return {
        content: [{ type: "text", text: forecast(prompt) }],
        finishReason: { unified: "stop", raw: "stop" },
        usage,
        warnings: [],
      } as never;
    },
    doStream: async (options) => {
      const prompt = JSON.stringify(options.prompt);
      scripted.prompts.push(prompt);
      return {
        stream: convertArrayToReadableStream([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: forecast(prompt) },
          { type: "text-end", id: "t" },
          { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
        ] as never[]),
      };
    },
  });
vi.mock("../src/models.js", async (original) => ({
  ...(await original<typeof import("../src/models.js")>()),
  textModel: async () => ({
    model: model(),
    ref: "test/scripted",
    vendor: "test",
    gateway: false,
    metered: false,
  }),
  systemOneAccess: async () => null,
  embeddingModel: async () => null,
  modelWays: async (classes: Iterable<string>) =>
    Object.fromEntries([...classes].map((cls) => [cls, "credits"])),
}));
vi.mock("../src/safety.js", async (original) => ({
  ...(await original<typeof import("../src/safety.js")>()),
  guestChecksOn: async () => false,
}));
vi.mock("../src/engine/requirements.js", async (original) => ({
  ...(await original<typeof import("../src/engine/requirements.js")>()),
  missingModelsSaid: async () => [],
}));
vi.mock("../src/credits/credits.js", async (original) => ({
  ...(await original<typeof import("../src/credits/credits.js")>()),
  canSpend: async () => true,
  reserveForRun: async () => true,
  releaseRun: async () => undefined,
}));

type App = { request: (path: string, init?: RequestInit) => Response | Promise<Response> };

let client: typeof import("../src/db/client");
let app: App;
let hostKey = "";
const ORIGIN = "http://localhost:5181";
const WEATHER = fileURLToPath(new URL("./fixtures/weather", import.meta.url));
const runsDir = mkdtempSync(join(tmpdir(), "wizards-run-cli-runs-"));

beforeAll(async () => {
  client = await import("../src/db/client");
  await client.migrateControlDb();
  app = (await import("../src/app")).default as unknown as App;
  const keys = await import("../src/auth/keys");
  const { KEY_SCOPES } = await import("../src/mcp/scopes");
  hostKey = (await keys.createLocalKey("wizards run", [...KEY_SCOPES, "runs:host"])).key;
}, 60_000);

vi.setConfig({ testTimeout: 60_000 });

interface Ran {
  code: number;
  out: string;
  said: string[];
  asked: string[];
}

/** Signs as `wizards run` does for engenty wizards on this computer; null: with the API key. */
let signed: (() => Record<string, string>) | null = null;

/** `wizards run <argv>` against this runtime; `typed`: what a person types, one line a question. */
async function run(argv: string[], typed: string[] | null = null): Promise<Ran> {
  const args = parseRunArgs(argv) as RunArgs;
  expect(typeof args).toBe("object");
  const ran: Ran = { code: -1, out: "", said: [], asked: [] };
  const answers = typed ? [...typed] : null;
  ran.code = await runCommand(args, {
    where: {
      url: ORIGIN,
      headers: signed ?? (() => ({ "x-api-key": hostKey })),
      name: "this organization",
    },
    runsDir,
    command: "wizards",
    fetch: (input, init) => Promise.resolve(app.request(String(input), init)),
    io: {
      ask: answers
        ? async (question) => {
            ran.asked.push(question);
            const line = answers.shift();
            if (line === undefined) {
              throw new Error(`Nobody types an answer to “${question}”.`);
            }
            return line;
          }
        : null,
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

/** The run's record at its tenant: what its copies made of it. */
const record = (runId: string) =>
  client.withTenant("local", () =>
    client.db.query.run.findFirst({ where: eq(client.schema.run.id, runId) }),
  );

describe("wizards run", () => {
  it("runs the weather example with nobody there: answers by flag, review accepted", async () => {
    const ran = await run([WEATHER, "--place=Vienna", "--day", "tomorrow", "--accept", "--json"]);
    expect(ran.code, ran.said.join("\n")).toBe(0);
    const result = JSON.parse(ran.out);
    expect(result).toMatchObject({
      status: "done",
      parts: [{ from: "forecast", label: "Forecast", text: "Vienna tomorrow: sun, 21 degrees." }],
      data: { place: "Vienna", forecast: "Vienna tomorrow: sun, 21 degrees." },
      error: null,
    });
    expect(ran.said).toContain("Accepted.");

    // The run's end reached its tenant through the host's copies alone.
    const r = await record(result.runId);
    expect(r).toMatchObject({ status: "done", host: { kind: "node" }, client: "cli" });
    expect((r?.state as { values: Record<string, unknown> }).values).toMatchObject({
      place: "Vienna",
      day: "tomorrow",
    });

    // The run's folder keeps what --continue needs, for the person alone.
    const start = join(runsDir, result.runId, "start.json");
    expect(statSync(start).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(start, "utf8"))).toMatchObject({ runId: result.runId });
  });

  it("runs it with a person who types the answers and accepts the review", async () => {
    const out = mkdtempSync(join(tmpdir(), "wizards-run-out-"));
    // Without a place nobody can go on: the person is asked, and an empty answer is not one.
    const ran = await run([WEATHER, "--out", out], ["", "Graz", "2", "y"]);
    expect(ran.code, ran.said.join("\n")).toBe(0);
    expect(ran.asked).toEqual([
      "Place: ",
      "Place: ",
      "Day (optional) [today]: ",
      "Accept this? (y/n): ",
    ]);
    expect(ran.said).toContain("“Place” needs an answer.");
    expect(ran.said).toContain("Graz tomorrow: sun, 21 degrees.");
    expect(readFileSync(join(out, "forecast.md"), "utf8")).toBe(
      "Graz tomorrow: sun, 21 degrees.\n",
    );
    expect(JSON.parse(readFileSync(join(out, "data.json"), "utf8"))).toMatchObject({
      place: "Graz",
    });
  });

  it("waits without a person, and --continue goes on with the run", async () => {
    const waits = await run([WEATHER, "--place=Linz", "--json"]);
    expect(waits.code).toBe(3);
    const left = JSON.parse(waits.out);
    expect(left).toMatchObject({ status: "waiting_input", waits: [expect.stringMatching(/review/)] });
    expect(waits.said).toContain(`To go on with it: wizards run --continue ${left.runId}`);
    expect(await record(left.runId)).toMatchObject({ status: "waiting_input", cursor: "check" });

    const ran = await run(["--continue", left.runId, "--accept"]);
    expect(ran.code, ran.said.join("\n")).toBe(0);
    expect(ran.out).toBe("Linz today: sun, 21 degrees.\n");
    expect(await record(left.runId)).toMatchObject({ status: "done" });

    // A missing answer with nobody to ask: said, and the run waits at its page.
    const missing = await run([WEATHER]);
    expect(missing.code).toBe(3);
    expect(missing.said).toContain("“Place” has no answer yet. Give it with --place=…");
  });

  it("runs every time as the same wizard of the space", async () => {
    const a = JSON.parse((await run([WEATHER, "--place=Bern", "--accept", "--json"])).out);
    const b = JSON.parse((await run([WEATHER, "--place=Chur", "--accept", "--json"])).out);
    expect((await record(a.runId))?.wizardId).toBe((await record(b.runId))?.wizardId);
  });

  it("starts with this computer's signature, which `wizards mcp`'s can't do", async () => {
    const { env } = await import("../src/env");
    const { LOCAL_MCP_HEADER, mintLocalTicket } = await import("../src/auth/local-ticket");
    const sign = (purpose: "local-run" | "local-mcp") => () => ({
      [LOCAL_MCP_HEADER]: mintLocalTicket(env.authSecret, Date.now(), purpose),
    });
    try {
      signed = sign("local-run");
      const ran = await run([WEATHER, "--place=Basel", "--accept", "--json"]);
      expect(ran.code, ran.said.join("\n")).toBe(0);
      expect(JSON.parse(ran.out)).toMatchObject({ status: "done" });
      signed = sign("local-mcp");
      const refused = await run([WEATHER, "--place=Basel", "--accept"]);
      expect(refused.code).toBe(1);
      expect(refused.said).toEqual([
        "This API key may not run wizards from the command line. Make a key that may.",
      ]);
    } finally {
      signed = null;
    }
  });

  it("says so when the organization doesn't run wizards from the command line", async () => {
    process.env.FEATURES = "durableRuns=on,runServices=on,runHosts=on";
    try {
      const ran = await run([WEATHER, "--place=Bern", "--accept"]);
      expect(ran.code).toBe(1);
      expect(ran.said).toEqual([
        "Running wizards from the command line isn’t available for this organization yet.",
      ]);
    } finally {
      process.env.FEATURES = ON;
    }
    const wrong = await run(["./nowhere", "--accept"]);
    expect(wrong.code).toBe(1);
    expect(wrong.said.join("\n")).toMatch(/can’t run/);
  });
});
