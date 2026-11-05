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
/** `TURN_REAL_MODEL=anthropic:<model>`: the one case that spends real tokens (see durable-turn.test.ts). */
const realModel = async () => {
  const [maker, id] = (process.env.TURN_REAL_MODEL ?? "").split(":");
  if (maker === "gateway") {
    const { createGateway } = await import("@ai-sdk/gateway");
    return createGateway({ apiKey: process.env.TURN_REAL_KEY })(id);
  }
  if (maker === "anthropic") {
    const { createAnthropic } = await import("@ai-sdk/anthropic");
    return createAnthropic({ apiKey: process.env.TURN_REAL_KEY })(id);
  }
  if (maker === "openai") {
    const { createOpenAI } = await import("@ai-sdk/openai");
    return createOpenAI({ apiKey: process.env.TURN_REAL_KEY })(id);
  }
  return model;
};
vi.mock("../src/models.js", async (original) => ({
  ...(await original<typeof import("../src/models.js")>()),
  textModel: async () => ({
    model: await realModel(),
    ref: "test/scripted",
    vendor: "test",
    gateway: false,
    metered: false,
  }),
}));
vi.mock("../src/engine/requirements.js", async (original) => ({
  ...(await original<typeof import("../src/engine/requirements.js")>()),
  missingModelsSaid: async () => [],
}));

let stopNow: (() => Promise<void>) | null = null;
let cancelNow: (() => Promise<void>) | null = null;
vi.mock("../src/tools/index.js", async (original) => ({
  ...(await original<typeof import("../src/tools/index.js")>()),
  buildStepTools: async (_step: unknown, ctx: any) => {
    const assets: any[] = [];
    return {
      assets,
      tools: {
        send_mail: createTool({
          id: "send_mail",
          description: "Sends a mail.",
          inputSchema: z.object({ n: z.number() }),
          // Through the broker as any outside action: `run_effect` keeps it (broker/effect.ts).
          execute: async ({ n }, context) => {
            const { brokerHost } = await import("../src/broker/host.js");
            const out = await brokerHost({
              who: { kind: "step", id: ctx.stepId } as never,
              where: { runId: ctx.runId, stepId: ctx.stepId },
              url: new URL(`https://mail.example/${n}`),
              method: "POST",
              effect: { turn: ctx.turn, toolCallId: context?.agent?.toolCallId },
              handler: async () => {
                say(`EFFECT mail ${n}`);
                // Each mail leaves a file: a process that goes on has it no longer in memory.
                assets.push(
                  await ctx.saveAsset({
                    kind: "file",
                    mime: "text/plain",
                    name: `mail-${n}.txt`,
                    data: Buffer.from(`mail ${n}`),
                  }),
                );
                if (process.env.TURN_CRASH_AT === String(n)) {
                  say("kill -9");
                  process.kill(process.pid, "SIGKILL");
                  await new Promise(() => undefined);
                }
                if (process.env.TURN_CANCEL_AT === String(n) && cancelNow) {
                  say("cancelled by the person");
                  await cancelNow();
                  return { sent: n };
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
            });
            return out.ok
              ? out.result
              : {
                  error:
                    "This mail was interrupted before and may have gone out. It was not sent again. Do not send it again.",
                };
          },
        }),
      },
    };
  },
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
      instructions: process.env.TURN_REAL_MODEL
        ? "First ask the person which offer this is about, with ask_person. Then send exactly three mails with send_mail, n = 0, then n = 1, then n = 2, one call at a time. Then answer with the words: sent 3 mails."
        : "Send the mails.",
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
    if (process.env.TURN_CRASH_AT_DROP === "1") {
      // The moment Mastra drops the turn's snapshot: synchronously, with nothing awaited before.
      const { DurableAgent } = await import("@mastra/core/agent/durable");
      DurableAgent.prototype.deleteRunSnapshots = async () => {
        say("kill -9 as Mastra drops the snapshot");
        process.kill(process.pid, "SIGKILL");
        await new Promise(() => undefined);
      };
    }
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
    cancelNow = () => client.withTenant(T, () => runner.cancel(id));
    runner.startRunner();
    const read = () =>
      client.withTenant(T, () => client.db.query.run.findFirst({ where: eq(client.schema.run.id, id) }));
    await until(async () => {
      const r = await read();
      return (
        r?.status === "done" ||
        r?.status === "failed" ||
        r?.status === "waiting_input" ||
        r?.status === "cancelled"
      );
    }, 80_000);
    // Whatever still runs after an end would show here.
    await new Promise((res) => setTimeout(res, 1500));
    const r = await read();
    const effects = await client.withTenant(T, () => client.db.query.runEffect.findMany());
    say(
      `END status=${r?.status} error=${r?.error ?? ""} question=${r?.status === "waiting_input" ? (r?.state.turn?.question ?? "") : ""} text=${JSON.stringify(r?.state.outputs.mails?.text ?? null)} effects=${effects.map((e) => e.state).join(",")} assets=${r?.state.outputs.mails?.assets?.map((a) => a.name).join(",") ?? ""} cost=${r?.costMicros} calls=${(await client.withTenant(T, async () => (await client.db.query.runCost.findMany()).map((c) => c.micros))).join(",")}`,
    );
    await new Promise((res) => setTimeout(res, 200));
    expect(r).toBeTruthy();
    process.exit(0);
  });
});
