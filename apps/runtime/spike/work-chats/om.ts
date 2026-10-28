/**
 * Spike for docs/plans/work-chats.md, PR 0: observational memory and prompt caching. The same
 * chat as cache.ts (system and newest message marked), with observational memory set to activate
 * after a few turns, to see what an activation costs the cache and how fast it comes back.
 *
 *   SPIKE_PROVIDER=gateway pnpm --filter @engenty/wizards-runtime exec tsx --conditions=wizards-source spike/work-chats/om.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "wizards-spike-"));
const { Agent } = await import("@mastra/core/agent");
const { Memory } = await import("@mastra/memory");
const { LibSQLStore } = await import("@mastra/libsql");
const { anthropic } = await import("@ai-sdk/anthropic");
const { gateway } = await import("@ai-sdk/gateway");
const { openai } = await import("@ai-sdk/openai");

// SPIKE_PROVIDER: anthropic (default), gateway (Anthropic through the AI Gateway) or openai.
const provider = process.env.SPIKE_PROVIDER ?? "anthropic";
const modelId =
  process.env.SPIKE_MODEL ??
  { anthropic: "claude-haiku-5-5", gateway: "anthropic/claude-haiku-5.5", openai: "gpt-5-mini" }[
    provider
  ] ??
  "claude-haiku-5-5";
const makeModel = () =>
  provider === "gateway" ? gateway(modelId) : provider === "openai" ? openai(modelId) : anthropic(modelId);
const store = new LibSQLStore({ id: "spike", url: `file:${join(dir, "spike.db")}` });

// A space's instructions and context, long enough to be cached (several thousand tokens).
const facts = Array.from(
  { length: 160 },
  (_, i) =>
    `Fact ${i + 1}: the firm Huber & Partner keeps matter ${1000 + i} for client ${
      ["Maier", "Lang", "Gruber", "Wagner"][i % 4]
    }, deadline in week ${(i % 52) + 1}, contact by mail, files in the folder Mandate/${1000 + i}.`,
).join("\n");
const instructions = `You are the AI of the space "Kanzlei Huber". Answer briefly, in German.\n\n${facts}`;

type Turn = { input: number; cached: number; written: number };

const lastMessageMark = {
  id: "cache-last-message",
  processLLMRequest: ({ prompt }: any) => {
    const copy = prompt.map((m: any) => ({ ...m }));
    for (let i = copy.length - 1; i >= 0; i--) {
      if (copy[i].role !== "system") {
        copy[i] = {
          ...copy[i],
          providerOptions: {
            ...copy[i].providerOptions,
            anthropic: { cacheControl: { type: "ephemeral" } },
          },
        };
        break;
      }
    }
    return { prompt: copy };
  },
};

const run = async (variant: "A" | "B") => {
  const prompts: string[] = [];
  const recorder = {
    id: "record-prompt",
    processLLMRequest: ({ prompt }: any) => {
      prompts.push(JSON.stringify(prompt.map((m: any) => ({ role: m.role, content: m.content }))));
      return {};
    },
  };
  const agent = new Agent({
    id: `ai-${variant}`,
    name: "AI",
    instructions: {
      role: "system",
      content: instructions,
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    },
    model: makeModel(),
    memory: new Memory({
      storage: store,
      options: {
        lastMessages: 100,
        observationalMemory: {
          model: makeModel(),
          scope: "thread",
          observation: { messageTokens: Number(process.env.SPIKE_OM_TOKENS ?? 1500), bufferTokens: 0.5 },
        },
      },
    }),
    inputProcessors: (variant === "B" ? [recorder, lastMessageMark] : [recorder]) as never,
  });
  const thread = { thread: `chat-${variant}`, resource: "space-1" };
  const turns: Turn[] = [];
  const observed: boolean[] = [];
  for (const [who, text] of [
    ["Anna", "Welche Akten hat Maier? Liste alle mit Frist."],
    ["Ben", "Und welche Fristen davon sind in den Wochen 1 bis 20?"],
    ["Anna", "Mach daraus eine Tabelle mit Akte, Woche, Ordner."],
    ["Ben", "Jetzt dasselbe für Gruber."],
    ["Anna", "Und für Lang."],
    ["Ben", "Welche drei Fristen sind am dringendsten, über alle?"],
    ["Anna", "Fass alles bisher in fünf Sätzen zusammen."],
    ["Ben", "Was hatte Anna am Anfang gefragt?"],
  ] as const) {
    const s = await agent.stream(`<user name="${who}">${text}</user>`, {
      memory: thread,
      modelSettings: { maxOutputTokens: 800 },
    });
    await s.text;
    const usage: any = await s.totalUsage;
    const meta: any = await s.providerMetadata;
    const sentPrompt = prompts.at(-1) ?? "";
    observed.push(/observation/i.test(sentPrompt));
    turns.push({
      input: usage?.inputTokens ?? 0,
      cached: usage?.cachedInputTokens ?? 0,
      written: Number(
        meta?.anthropic?.cacheCreationInputTokens ?? meta?.gateway?.cacheCreationInputTokens ?? 0,
      ),
    });
  }
  const prefixKept = prompts.slice(1).map((p, i) => {
    const before = prompts[i] ?? "";
    // The new prompt starts with the previous one, minus its closing brackets.
    return p.startsWith(before.slice(0, -2));
  });
  const answer = turns.length;
  return {
    turns: turns.map((t, i) => ({ ...t, share: Math.round((t.cached / Math.max(t.input, 1)) * 100), observed: observed[i] })),
    prefixKept,
    turnsRun: answer,
  };
};

const result = await run("B");
const { createClient } = await import("@libsql/client");
const raw = createClient({ url: `file:${join(dir, "spike.db")}` });
const omTables = (await raw.execute("select name from sqlite_master where type='table' and name like '%observ%'")).rows.map((r) => String(r.name));
const omRows: Record<string, unknown> = {};
for (const t of omTables) {
  omRows[t] = (await raw.execute(`select * from ${t} limit 3`)).rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, String(v).slice(0, 160)])));
}
const out = { provider, model: modelId, withObservations: result, omTables, omRows };
console.log(JSON.stringify(out, null, 2));
await new Promise((r) => setTimeout(r, 20_000));
console.log(JSON.stringify({ afterWait: (await raw.execute("select count(*) as n from mastra_observational_memory").catch(() => ({ rows: [{ n: 'no table' }] }))).rows[0] }));
process.exit(0);
