/**
 * Spike for docs/plans/work-chats.md, PR 0: an installed client (Claude Code) as the model under
 * a Mastra agent with memory: does a tool with `requireApproval` still stop the turn when the
 * client runs the tools itself over MCP, what reaches the stream, what the usage says about the
 * cache, and what `toAISdkStream` makes of it for `useChat`. Runs `claude` on this computer's
 * sign-in.
 *
 *   pnpm --filter @engenty/wizards-runtime exec tsx --conditions=wizards-source spike/work-chats/client.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "wizards-spike-"));
process.env.DATA_DIR = dir;
process.env.API_PORT = process.env.API_PORT ?? "18999";
process.env.APP_URL = `http://127.0.0.1:${process.env.API_PORT}`;
process.env.MANAGE_URL = "";

const { Agent } = await import("@mastra/core/agent");
const { Mastra } = await import("@mastra/core");
const { createTool } = await import("@mastra/core/tools");
const { Memory } = await import("@mastra/memory");
const { LibSQLStore } = await import("@mastra/libsql");
const { toAISdkStream } = await import("@mastra/ai-sdk");
const { z } = await import("zod");
const { Hono } = await import("hono");
const { serve } = await import("@hono/node-server");
const { bridgeRequest } = await import("../../src/mcp/bridge.js");
const { harness } = await import("../../src/harness/index.js");

// The bridge the client reaches the tools through is a route of the runtime: serve it alone.
const app = new Hono().all("/api/mcp/bridge/:token", (c) =>
  bridgeRequest(c.req.param("token"), c.req.raw),
);
const server = serve({ fetch: app.fetch, port: Number(process.env.API_PORT) });

const claude = harness("claude");
if (!claude) {
  throw new Error("no claude harness");
}
const model = claude.model(process.env.SPIKE_ALIAS ?? "haiku");
const store = new LibSQLStore({ id: "spike", url: `file:${join(dir, "spike.db")}` });

const calls: string[] = [];
const lookup = createTool({
  id: "lookup_files",
  description: "Lists the files of a client of the firm.",
  inputSchema: z.object({ client: z.string() }),
  execute: async ({ client }: { client: string }) => {
    calls.push(`lookup_files:${client}`);
    return { files: [`Mandate/1000-${client}.pdf`, `Mandate/1004-${client}.pdf`] };
  },
});
const sendMail = createTool({
  id: "send_mail",
  description: "Sends a mail to a client of the firm.",
  inputSchema: z.object({ to: z.string(), text: z.string() }),
  requireApproval: true,
  execute: async ({ to }: { to: string }) => {
    calls.push(`send_mail:${to}`);
    return { sent: true };
  },
});
// As models.ts does for a client: the tools the client may call, run over the bridge.
(model as any).attach({ lookup_files: lookup, send_mail: sendMail });
const mastra = new Mastra({
  agents: {
    ai: new Agent({
      id: "ai",
      name: "AI",
      instructions:
        "You are the AI of the space Kanzlei Huber. Use the tools. Answer in one short German sentence.",
      model: model as never,
      memory: new Memory({ storage: store, options: { lastMessages: 40 } }),
      tools: { lookup_files: lookup, send_mail: sendMail },
    }),
  },
  storage: store,
  logger: false as never,
});
const agent = mastra.getAgent("ai") as any;
const thread = { thread: "chat-1", resource: "space-1" };

const turn = async (text: string) => {
  const t = performance.now();
  const s = await agent.stream(text, { memory: thread, maxSteps: 6 });
  const mastraTypes = new Set<string>();
  const aiSdkTypes = new Set<string>();
  const [a, b] = (s.fullStream as ReadableStream).tee();
  const reading = (async () => {
    for await (const c of a as unknown as AsyncIterable<any>) {
      mastraTypes.add(c.type);
    }
  })();
  const converting = (async () => {
    const ui = toAISdkStream({ fullStream: b } as never, { from: "agent", version: "v7" } as never);
    for await (const c of ui as unknown as AsyncIterable<any>) {
      aiSdkTypes.add(c.type);
    }
  })().catch((e: Error) => aiSdkTypes.add(`error: ${e.message}`));
  await Promise.all([reading, converting]);
  const usage: any = await s.totalUsage;
  return {
    ms: Math.round(performance.now() - t),
    text: (await s.text).slice(0, 200),
    mastraChunks: [...mastraTypes],
    aiSdkChunks: [...aiSdkTypes],
    usage: { input: usage?.inputTokens, cached: usage?.cachedInputTokens, output: usage?.outputTokens },
  };
};

const out = {
  lookup: await turn('<user name="Anna">Welche Dateien hat der Mandant Maier?</user>'),
  approval: await turn(
    '<user name="Ben">Schick an maier@example.com eine Mail mit dem Text "Termin am Freitag". Frag nicht nach.</user>',
  ),
  toolCalls: calls,
  suspended: await agent
    .listSuspendedRuns({ threadId: "chat-1", resourceId: "space-1" })
    .then((r: any) => r.runs?.length ?? 0)
    .catch((e: Error) => e.message),
  followUp: await turn('<user name="Anna">Was hatte Ben gefragt?</user>'),
};
console.log(JSON.stringify(out, null, 2));
server.close();
process.exit(0);
