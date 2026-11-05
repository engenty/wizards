import { Agent } from "@mastra/core/agent";
import { createDurableAgent } from "@mastra/core/agent/durable";
import { Mastra } from "@mastra/core";
import type { MastraModelConfig } from "@mastra/core/llm";
import { RequestContext } from "@mastra/core/request-context";
import { createTool } from "@mastra/core/tools";
import { LibSQLStore } from "@mastra/libsql";
import type { Client } from "@libsql/client";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema, tenantClient } from "../db/client.js";
import { currentTenant } from "../tenants/tenant.js";

/**
 * A durable agent step: the turn runs on Mastra's `DurableAgent`, so it goes on at the call it was
 * at after a crash or a deploy. The flow around it stays `drive()`: only the line starts, recovers
 * or resumes a turn, never Mastra's own boot sweep.
 */

/** The turn stopped to ask a person. */
export class TurnAsks extends Error {
  constructor(readonly question: string) {
    super(question);
  }
}

/** What this process built for a turn: closures over the run, found by the turn's id. */
type Held = {
  instructions: string;
  model: MastraModelConfig;
  tools: Record<string, unknown>;
};
const held = new Map<string, Held>();
const TURN = "turnId";

const heldOf = (context: { get(key: string): unknown }): Held => {
  const turn = held.get(String(context.get(TURN)));
  if (!turn) {
    throw new Error("A durable turn runs without what its step built.");
  }
  return turn;
};

type Entry = { client: Client; agent: any; ready: Promise<void> };
const byTenant = new Map<string, Entry>();

function make(client: Client): Entry {
  const store = new LibSQLStore({ id: "wizard-steps", client });
  const agent = new Agent({
    id: "wizard-step",
    name: "Wizard step",
    instructions: async ({ requestContext }) => heldOf(requestContext).instructions,
    model: async ({ requestContext }) => heldOf(requestContext).model,
    tools: async ({ requestContext }: { requestContext: { get(key: string): unknown } }) =>
      heldOf(requestContext).tools as never,
  });
  const durable = createDurableAgent({
    agent,
    // Running checkpoints without Mastra's boot recovery: the line decides who goes on.
    shouldPersistSnapshot: ({ workflowStatus }) =>
      ["pending", "paused", "suspended", "running"].includes(workflowStatus),
  });
  const mastra = new Mastra({
    agents: { wizardStep: durable as never },
    storage: store,
    logger: false,
    recovery: { durableAgents: "off", workflows: "off" },
  });
  return {
    client,
    agent: mastra.getAgent("wizardStep"),
    ready: store.init() as Promise<void>,
  };
}

async function tenantAgent() {
  const tenant = currentTenant();
  const client = await tenantClient(tenant);
  let entry = byTenant.get(tenant);
  if (!entry || entry.client !== client) {
    entry = make(client);
    byTenant.set(tenant, entry);
  }
  await entry.ready;
  return entry.agent;
}

/**
 * The tool that asks a person: it suspends the turn. Nothing waits in memory; the answer comes
 * back through `resume` on whichever runner has the run then.
 */
export function askPersonTool() {
  return createTool({
    id: "ask_person",
    description: "Ask the person a question and go on with the answer.",
    inputSchema: z.object({ question: z.string() }),
    suspendSchema: z.object({ question: z.string() }),
    resumeSchema: z.object({ answer: z.string() }),
    execute: async ({ question }, context) => {
      const resumed = context?.agent?.resumeData as { answer?: string } | undefined;
      if (!resumed?.answer) {
        return (await context?.agent?.suspend({ question })) as never;
      }
      return { answer: resumed.answer } as never;
    },
  });
}

/**
 * Outside tools act once per call. A call the model made keeps its id when a turn goes on after a
 * crash. Found done: the stored result, no second action. Found started: it may have happened, so
 * the model hears that and nothing acts again.
 */
export function onceEach(
  turnId: string,
  runId: string,
  stepId: string,
  tools: Record<string, any>,
  outside: (name: string) => boolean,
): Record<string, any> {
  const wrapped: Record<string, any> = {};
  for (const [name, tool] of Object.entries(tools)) {
    if (!outside(name) || !tool.execute) {
      wrapped[name] = tool;
      continue;
    }
    wrapped[name] = {
      ...tool,
      execute: async (input: unknown, context: any) => {
        const call = context?.agent?.toolCallId;
        if (!call) {
          return tool.execute(input, context);
        }
        const id = `${turnId}:${call}`;
        const before = await db.query.runEffect.findFirst({ where: eq(schema.runEffect.id, id) });
        if (before?.state === "done") {
          return before.output;
        }
        if (before?.state === "started") {
          return {
            uncertain: true,
            note: "This action was started before an interruption and may have happened. Do not do it again; say so.",
          };
        }
        await db.insert(schema.runEffect).values({
          id,
          runId,
          stepId,
          tool: name,
          state: "started",
          output: null,
          at: new Date(),
        });
        const output = await tool.execute(input, context);
        await db
          .update(schema.runEffect)
          .set({ state: "done", output, at: new Date() })
          .where(eq(schema.runEffect.id, id));
        return output;
      },
    };
  }
  return wrapped;
}

const LEASE_WAIT_MS = 25_000;

/** Runs or continues a turn until it ends or stops for a person. */
export async function durableTurn(input: {
  turn: { stepId: string; id: string; answer?: string };
  runId: string;
  stepId: string;
  instructions: string;
  model: MastraModelConfig;
  tools: Record<string, unknown>;
  message: string;
  maxSteps: number;
  signal: AbortSignal;
}): Promise<{ text: string; usage: unknown }> {
  const id = input.turn.id;
  // Mastra drops a finished turn's snapshot. A process that dies before `drive` saves the result
  // would start the whole turn again, with new call ids; so its end is kept here first.
  const endId = `${id}:end`;
  const ended = await db.query.runEffect.findFirst({ where: eq(schema.runEffect.id, endId) });
  if (ended) {
    return ended.output as { text: string; usage: unknown };
  }
  held.set(id, {
    instructions: input.instructions,
    model: input.model,
    tools: {
      ...onceEach(id, input.runId, input.stepId, input.tools, (n) => n !== "ask_person"),
      ask_person: askPersonTool(),
    },
  });
  const agent = await tenantAgent();
  const context = new RequestContext();
  context.set(TURN, id);

  // A cancel stops the turn. A deploy's stop does not: the turn stays for the next runner.
  const onAbort = () => {
    if (input.signal.reason !== "stop") {
      agent.abortRunStream(id);
    }
  };
  input.signal.addEventListener("abort", onAbort, { once: true });

  let asked: string | null = null;
  const callbacks = {
    onSuspended: (data: { suspendPayload?: { question?: string } }) => {
      asked = data?.suspendPayload?.question ?? "";
    },
    onFinish: async (data: { text?: string; totalUsage?: unknown; usage?: unknown }) => {
      await db
        .insert(schema.runEffect)
        .values({
          id: endId,
          runId: input.runId,
          stepId: input.stepId,
          tool: "(end of turn)",
          state: "done",
          output: { text: data.text ?? "", usage: data.totalUsage ?? data.usage ?? null },
          at: new Date(),
        })
        .onConflictDoNothing();
    },
  };
  try {
    const result = await open();
    const stopped = new Promise<"stopped">((res) => {
      const check = setInterval(() => {
        if (asked !== null) {
          clearInterval(check);
          res("stopped");
        }
      }, 25);
      check.unref();
    });
    const gone = new Promise<never>((_, reject) => {
      input.signal.addEventListener("abort", () => reject(new Error("The turn was stopped.")), { once: true });
    });
    const text = await Promise.race([result.output.text as Promise<string>, stopped, gone]);
    if (asked !== null) {
      throw new TurnAsks(asked);
    }
    return { text: text as string, usage: await result.output.totalUsage };
  } finally {
    input.signal.removeEventListener("abort", onAbort);
    held.delete(id);
  }

  async function open() {
    // An answer goes on from the suspended call; a checkpoint goes on from where it was; nothing
    // stored starts the turn. A crashed owner's lease lapses within 15 s, sooner than the takeover.
    if (input.turn.answer !== undefined) {
      return agent.resume(id, { answer: input.turn.answer }, { requestContext: context, ...callbacks });
    }
    const end = Date.now() + LEASE_WAIT_MS;
    for (;;) {
      try {
        return await agent.recover(id, { ...callbacks });
      } catch (err) {
        const code = (err as { id?: string }).id;
        if (code === "DURABLE_AGENT_RUN_ACTIVE" && Date.now() < end) {
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        if (
          code === "DURABLE_AGENT_RECOVER_SNAPSHOT_NOT_FOUND" ||
          code === "DURABLE_AGENT_RECOVER_CHECKPOINT_NOT_AVAILABLE" ||
          code === "DURABLE_AGENT_RECOVER_RUN_NOT_ACTIVE"
        ) {
          return agent.stream(input.message, {
            runId: id,
            requestContext: context,
            maxSteps: input.maxSteps,
            ...callbacks,
          });
        }
        throw err;
      }
    }
  }
}
