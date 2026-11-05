import { appendFileSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createTool } from "@mastra/core/tools";
import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

// One process of the durable turn test: durable-turn.test.ts starts it per phase, on one DATA_DIR.
const PHASE = process.env.TURN_PHASE;
const DIR = process.env.DATA_DIR ?? "";
const say = (what: string) =>
  DIR && appendFileSync(join(DIR, "log"), `${Date.now()} ${process.pid} ${what}\n`);

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const tail = (reason: string) => ({ type: "finish", finishReason: { unified: reason, raw: reason }, usage });
const model = new MockLanguageModelV3({
  doStream: async (options: any) => {
    const results = options.prompt
      .filter((m: any) => m.role === "tool")
      .flatMap((m: any) => m.content)
      .filter((c: any) => c.type === "tool-result");
    const asked = results.some((r: any) => r.toolName === "ask_person");
    const mails = results.filter((r: any) => r.toolName === "send_mail").length;
    say(`LLM sees mails=${mails} asked=${asked}`);
    const call = (name: string, input: unknown) => [
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: `call-${name}-${mails}-${Math.random().toString(36).slice(2, 6)}`,
        toolName: name,
        input: JSON.stringify(input),
      },
      tail("tool-calls"),
    ];
    if (process.env.TURN_ASK === "1" && !asked) {
      return { stream: convertArrayToReadableStream(call("ask_person", { question: "Which offer?" }) as never[]) };
    }
    if (mails < 3) {
      return { stream: convertArrayToReadableStream(call("send_mail", { n: mails }) as never[]) };
    }
    return {
      stream: convertArrayToReadableStream([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: `sent ${mails} mails` },
        { type: "text-end", id: "t" },
        tail("stop"),
      ] as never[]),
    };
  },
});
vi.mock("../src/models.js", async (original) => ({
  ...(await original<typeof import("../src/models.js")>()),
  textModel: async () => ({ model, ref: "test/scripted", vendor: "test", gateway: false, metered: true }),
}));
vi.mock("../src/engine/requirements.js", async (original) => ({
  ...(await original<typeof import("../src/engine/requirements.js")>()),
  missingModelsSaid: async () => [],
}));

let stopNow: (() => Promise<void>) | null = null;
vi.mock("../src/tools/index.js", async (original) => ({
  ...(await original<typeof import("../src/tools/index.js")>()),
  buildStepTools: async () => ({
    assets: [],
    tools: {
      send_mail: createTool({
        id: "send_mail",
        description: "Sends a mail.",
        inputSchema: z.object({ n: z.number() }),
        execute: async ({ n }) => {
          say(`EFFECT mail ${n}`);
          if (process.env.TURN_CRASH_AT === String(n)) {
            say("kill -9");
            process.kill(process.pid, "SIGKILL");
            await new Promise(() => undefined);
          }
          if (process.env.TURN_STOP_AT === String(n) && stopNow) {
            say("stopping as a deploy does");
            await stopNow();
            // The process ends here; vitest would catch a plain exit.
            process.kill(process.pid, "SIGKILL");
            await new Promise(() => undefined);
          }
          return { sent: n };
        },
      }),
    },
  }),
}));

vi.mock("../src/credits/credits.js", async (original) => ({
  ...(await original<typeof import("../src/credits/credits.js")>()),
  // The first thing `drive` does after a step: dying here is dying before its result is saved.
  syncRunCost: async () => {
    if (process.env.TURN_CRASH_AT_END === "1") {
      say("kill -9 before the result is saved");
      process.kill(process.pid, "SIGKILL");
      await new Promise(() => undefined);
    }
  },
}));

const T = "tenant-durable-turn";
const definition = {
  version: 1,
  title: "Turn",
  description: "",
  avatar: "round",
  steps: [
    {
      id: "mails",
      type: "agent",
      title: "Mails",
      instructions: "Send the mails.",
      tools: [],
      output: { format: "text" },
      durable: true,
    },
    { id: "done", type: "result", title: "Fertig", deliverables: [] },
  ],
};

async function until(ok: () => Promise<boolean>, ms: number) {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    if (await ok()) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

describe.runIf(PHASE)(`turn phase ${PHASE}`, () => {
  it("runs", { timeout: 90_000 }, async () => {
    const client = await import("../src/db/client");
    await client.migrateControlDb();
    const runner = await import("../src/engine/runner");
    const wizards = await import("../src/services/wizards");
    stopNow = runner.stopRunner;
    const idFile = join(DIR, "run-id");
    let id = "";
    await client.withTenant(T, async () => {
      if (PHASE === "start") {
        const created = await wizards.createWizard("u", { definition: definition as never });
        const w = await wizards.ownedWizard("u", created.id);
        id = await runner.createRun({
          wizardId: w.id,
          definition: w.draft,
          files: [],
          version: null,
          mode: "test",
          userId: "u",
        });
        writeFileSync(idFile, id);
      } else {
        id = readFileSync(idFile, "utf8");
      }
      if (PHASE === "answer") {
        await runner.answerTurn(id, "the big one");
      }
    });
    runner.startRunner();
    const read = () =>
      client.withTenant(T, () => client.db.query.run.findFirst({ where: eq(client.schema.run.id, id) }));
    await until(async () => {
      const r = await read();
      return r?.status === "done" || r?.status === "failed" || r?.status === "waiting_input";
    }, 80_000);
    const r = await read();
    const effects = await client.withTenant(T, () => client.db.query.runEffect.findMany());
    say(
      `END status=${r?.status} error=${r?.error ?? ""} question=${r?.state.turn?.question ?? ""} text=${JSON.stringify(r?.state.outputs.mails?.text ?? null)} effects=${effects.map((e) => e.state).join(",")}`,
    );
    await new Promise((res) => setTimeout(res, 200));
    expect(r).toBeTruthy();
    process.exit(0);
  });
});
