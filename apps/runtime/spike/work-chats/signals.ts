/**
 * Spike for docs/plans/work-chats.md, PR 0: Mastra's signals in a chat of several people, on a
 * scripted model. A message the AI isn't asked about is kept without a run; a message during a
 * turn goes into the running loop; one for after the answer waits; Stop drops what waits.
 *
 *   pnpm --filter @engenty/wizards-runtime exec tsx --conditions=wizards-source spike/work-chats/signals.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "wizards-spike-"));
const { Agent } = await import("@mastra/core/agent");
const { Mastra } = await import("@mastra/core");
const { Memory } = await import("@mastra/memory");
const { LibSQLStore } = await import("@mastra/libsql");
const { convertArrayToReadableStream, MockLanguageModelV3 } = await import("ai/test");

const store = new LibSQLStore({ id: "spike", url: `file:${join(dir, "spike.db")}` });
const usage = { inputTokens: { total: 50, noCache: 50 }, outputTokens: { total: 5, text: 5 } };
const say = (text: string) => [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: text },
  { type: "text-end", id: "t" },
  { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
];
const callTool = (name: string) => [
  { type: "stream-start", warnings: [] },
  { type: "tool-call", toolCallId: `c-${name}-${Math.random()}`, toolName: name, input: "{}" },
  { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage },
];
const gate = () => {
  let open!: () => void;
  const wait = new Promise<void>((r) => {
    open = r;
  });
  return { wait, open };
};
const script: { wait?: Promise<void>; chunks: unknown[] }[] = [];
const prompts: string[] = [];
const model = new MockLanguageModelV3({
  doStream: async (options: any) => {
    prompts.push(JSON.stringify(options.prompt));
    const next = script.shift();
    if (!next) {
      throw new Error("script empty");
    }
    await next.wait;
    return { stream: convertArrayToReadableStream(next.chunks as never[]) };
  },
});
const { createTool } = await import("@mastra/core/tools");
const { z } = await import("zod");
const lookup = createTool({
  id: "lookup",
  description: "Looks something up.",
  inputSchema: z.object({}),
  execute: async () => ({ found: "Protokoll vom 21. Oktober" }),
});
const memory = new Memory({ storage: store, options: { lastMessages: 40 } });
const mastra = new Mastra({
  agents: {
    ai: new Agent({ id: "ai", name: "AI", instructions: "Help.", model, memory, tools: { lookup } }),
  },
  storage: store,
  logger: false as never,
});
const agent = mastra.getAgent("ai") as any;
const thread = { resourceId: "space-1", threadId: "chat-1" };
const out: Record<string, unknown> = {};
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

// --- a message the AI isn't asked about: kept, no run --------------------------------------------
const kept = agent.sendMessage(
  { contents: "Ich schaue mir das morgen an.", attributes: { name: "Ben" } },
  { ...thread, ifIdle: { behavior: "persist" } },
);
const keptResult = await kept.accepted;
await settle();
out.keptWithoutRun = { action: keptResult?.action, modelCalls: prompts.length };

// --- a turn, and a message during it --------------------------------------------------------------
const firstStep = gate();
script.push({ wait: firstStep.wait, chunks: callTool("lookup") }, { chunks: say("Gefunden.") });
const sub = await agent.subscribeToThread(thread);
const started = agent.sendMessage(
  { contents: "Such das Protokoll.", attributes: { name: "Anna" } },
  thread,
);
const startedResult = await started.accepted;
await settle();
const during = agent.sendMessage(
  { contents: "Und die Frist bitte auch.", attributes: { name: "Ben" } },
  thread,
);
const duringResult = await during.accepted;
firstStep.open();
const chunks: string[] = [];
for await (const chunk of sub.stream as AsyncIterable<any>) {
  chunks.push(chunk.type);
  if (chunk.type === "finish") {
    break;
  }
}
const lastPrompt = prompts.at(-1) ?? "";
out.duringTurn = {
  started: startedResult?.action,
  during: duringResult?.action,
  modelCalls: prompts.length,
  secondStepHasBen: lastPrompt.includes("Und die Frist bitte auch."),
  firstPromptHadKeptMessage: (prompts[0] ?? "").includes("Ich schaue mir das morgen an."),
  authorsInPrompt: [...lastPrompt.matchAll(/name=\\"(\w+)\\"/g)].map((m) => m[1]),
};

// --- a message for after the answer, and Stop -----------------------------------------------------
const slow = gate();
script.push({ wait: slow.wait, chunks: say("Langsame Antwort.") }, { chunks: say("Danach.") });
const callsBefore = prompts.length;
agent.sendMessage({ contents: "Fass zusammen.", attributes: { name: "Anna" } }, thread);
await settle();
const queued = agent.queueMessage({ contents: "Danach bitte die Mail.", attributes: { name: "Anna" } }, thread);
const queuedResult = await queued.accepted;
const stopped = agent.abortThreadStream({ ...thread, clearPendingSignals: true });
slow.open();
await settle(800);
out.afterAndStop = {
  queued: queuedResult?.action,
  stopped,
  modelCallsAfter: prompts.length - callsBefore,
  queuedRan: prompts.slice(callsBefore).some((p) => p.includes("Danach bitte die Mail.")),
};

const recalled = await memory.recall(thread);
out.stored = recalled.messages.map((m: any) => ({
  role: m.role,
  text: JSON.stringify(m.content).slice(0, 80),
}));
console.log(JSON.stringify(out, null, 2));
process.exit(0);
