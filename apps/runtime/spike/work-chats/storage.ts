/**
 * Spike for docs/plans/work-chats.md, PR 0: Mastra's libSQL store in a tenant's database beside
 * our tables, a Memory made per request (thread = chat, resource = space), and a tool approval
 * that survives a restart. A scripted model, no costs.
 *
 *   pnpm --filter @engenty/wizards-runtime exec tsx --conditions=wizards-source spike/work-chats/storage.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "wizards-spike-"));
process.env.DATA_DIR = dir;
process.env.APP_URL = "http://localhost:5181";
process.env.MANAGE_URL = "";

const { Agent } = await import("@mastra/core/agent");
const { Mastra } = await import("@mastra/core");
const { createTool } = await import("@mastra/core/tools");
const { RequestContext } = await import("@mastra/core/request-context");
const { Memory } = await import("@mastra/memory");
const { LibSQLStore } = await import("@mastra/libsql");
const { convertArrayToReadableStream, MockLanguageModelV3 } = await import("ai/test");
const { z } = await import("zod");
const { createClient } = await import("@libsql/client");
const client = await import("../../src/db/client.js");

const out: Record<string, unknown> = {};
const timed = async <T>(fn: () => Promise<T>) => {
  const t = performance.now();
  const value = await fn();
  return { value, ms: Math.round(performance.now() - t) };
};
const tables = async () =>
  (await raw.execute("select name from sqlite_master where type='table'")).rows.map((r) =>
    String(r.name),
  );

// --- 1. our tenant database, then Mastra's store in the same file -----------------------------
await client.migrateControlDb();
await client.openTenantDb("spike");
const url = `file:${join(dir, "tenants", "spike.db")}`;
const raw = createClient({ url });
const before = await tables();
const storeFor = (id: string) => new LibSQLStore({ id: `tenant-${id}`, url });
const init = await timed(() => storeFor("spike").init());
const added = (await tables()).filter((t) => !before.includes(t));
client.closeTenantDb("spike");
const reopen = await timed(() => client.openTenantDb("spike"));
out.store = {
  initMs: init.ms,
  ourTables: before.length,
  mastraTables: added,
  notPrefixed: added.filter((t) => !t.startsWith("mastra_")),
  ourMigrationsAfterwardsMs: reopen.ms,
};

// --- 2. a Memory per request: thread = chat, resource = space ---------------------------------
const usage = { inputTokens: { total: 50, noCache: 50 }, outputTokens: { total: 5, text: 5 } };
const say = (text: string) => [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: text },
  { type: "text-end", id: "t" },
  { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
];
const callTool = (name: string, input: unknown) => [
  { type: "stream-start", warnings: [] },
  { type: "tool-call", toolCallId: `c-${name}`, toolName: name, input: JSON.stringify(input) },
  { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage },
];
const script: unknown[][] = [];
const prompts: string[] = [];
const model = new MockLanguageModelV3({
  doStream: async (options: any) => {
    prompts.push(JSON.stringify(options.prompt));
    const next = script.shift();
    if (!next) {
      throw new Error("script empty");
    }
    return { stream: convertArrayToReadableStream(next as never[]) };
  },
});

let memoriesMade = 0;
const memoryFor = (tenant: string) => {
  memoriesMade++;
  return new Memory({ storage: storeFor(tenant), options: { lastMessages: 40 } });
};
const sent: string[] = [];
const sendMail = createTool({
  id: "send_mail",
  description: "Sends a mail.",
  inputSchema: z.object({ to: z.string() }),
  requireApproval: true,
  execute: async ({ to }: { to: string }) => {
    sent.push(to);
    return { sent: to };
  },
});
const makeMastra = () =>
  new Mastra({
    agents: {
      spaceAi: new Agent({
        id: "space-ai",
        name: "Space AI",
        instructions: "You help the team.",
        model,
        tools: { send_mail: sendMail },
        memory: ({ requestContext }: any) => memoryFor(String(requestContext.get("tenant"))),
      }),
    },
    storage: storeFor("spike"),
    logger: false as never,
  });
const ctx = () => {
  const c = new RequestContext();
  c.set("tenant", "spike");
  return c;
};
const thread = { thread: "chat-1", resource: "space-1" };
const ask = async (text: string) => {
  const s = await mastra.getAgent("spaceAi").stream(text, { memory: thread, requestContext: ctx() });
  return await s.text;
};

const made = await timed(async () => makeMastra());
out.mastraInstanceMs = made.ms;
let mastra = made.value;
script.push(say("Hallo zusammen."));
const first = await timed(() => ask('<turn author_name="Anna">Hallo</turn>'));
script.push(say("Gerne."));
const second = await timed(() => ask('<turn author_name="Ben">Und ich?</turn>'));
const recalled = await memoryFor("spike").recall({ threadId: "chat-1", resourceId: "space-1" });
out.memory = {
  firstTurnMs: first.ms,
  secondTurnMs: second.ms,
  memoriesMade,
  recalledMessages: recalled.messages.length,
  secondPromptHasFirstAnswer: (prompts.at(-1) ?? "").includes("Hallo zusammen."),
  secondPromptHasAnna: (prompts.at(-1) ?? "").includes("Anna"),
};

// --- 3. an approval that survives a restart ----------------------------------------------------
script.push(callTool("send_mail", { to: "huber@example.com" }));
const pending = await mastra
  .getAgent("spaceAi")
  .stream('<turn author_name="Anna">Schick Huber die Mail.</turn>', {
    memory: thread,
    requestContext: ctx(),
  });
const types: string[] = [];
const uiTypes: string[] = [];
const { toAISdkStream } = await import("@mastra/ai-sdk");
const [own, forUi] = (pending.fullStream as ReadableStream).tee();
await Promise.all([
  (async () => {
    for await (const chunk of own as unknown as AsyncIterable<any>) {
      types.push(chunk.type);
    }
  })(),
  (async () => {
    const ui = toAISdkStream({ fullStream: forUi } as never, { from: "agent", version: "v7" } as never);
    for await (const chunk of ui as unknown as AsyncIterable<any>) {
      uiTypes.push(chunk.type);
    }
  })(),
]);
const runId = pending.runId;
// The restart: a new Mastra and agent on the same store.
mastra = makeMastra();
const agent = mastra.getAgent("spaceAi") as any;
const found = await agent
  .listSuspendedRuns({ threadId: "chat-1", resourceId: "space-1" })
  .then((r: any) => ({ runs: r.runs?.length ?? r.length, runIdMatches: r.runs?.[0]?.runId === runId }))
  .catch((e: Error) => ({ error: e.message }));
script.push(say("Die Mail ist raus."));
const resumed = await timed(async () => {
  const s = await agent.approveToolCall({ runId, requestContext: ctx() });
  return await s.text;
}).catch((e: Error) => ({ value: `error: ${e.message}`, ms: 0 }));
const count = async (table: string) =>
  Number((await raw.execute(`select count(*) as n from ${table}`)).rows[0]?.n ?? 0);
out.approval = {
  chunkTypes: [...new Set(types)],
  useChatChunkTypes: [...new Set(uiTypes)],
  foundAfterRestart: found,
  resumedText: resumed.value,
  mailsSent: sent,
  snapshotRows: await count("mastra_workflow_snapshot").catch(() => "no table"),
  messagesInThread: (await memoryFor("spike").recall({ threadId: "chat-1", resourceId: "space-1" }))
    .messages.length,
};

console.log(JSON.stringify(out, null, 2));
process.exit(0);
