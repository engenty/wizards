import type { AssetRef, RunState, RunTurn } from "@engenty/wizards-shared/run";
import type { Client } from "@libsql/client";
import { Mastra } from "@mastra/core";
import { Agent } from "@mastra/core/agent";
import { createDurableAgent } from "@mastra/core/agent/durable";
import type { MastraModelConfig } from "@mastra/core/llm";
import { RequestContext } from "@mastra/core/request-context";
import { createTool } from "@mastra/core/tools";
import { LibSQLStore } from "@mastra/libsql";
import { nanoid } from "nanoid";
import { z } from "zod";
import { tenantClient } from "../db/client.js";
import { prompt } from "../prompts.js";
import { currentTenant } from "../tenants/tenant.js";
import { type StepContext, StepError } from "./types.js";

/**
 * A durable agent step: the turn runs on Mastra's `DurableAgent`, so after a crash or a deploy it
 * goes on at the call it was at, and it can stop to ask a person with no process waiting. The flow
 * around it stays `drive()`, and only the line starts, recovers or resumes a turn: Mastra's own
 * sweep at boot is off (docs/plans/durable-runs).
 *
 * What is ours and what is Mastra's:
 *
 * - The turn's id, its question and answer, the files it made and how it ended are on the run's
 *   row (`RunState.turn`). The row decides.
 * - The conversation is in Mastra's snapshot, in the tenant's database. Mastra drops it when the
 *   turn has ended, and the sweep in `purgeExpiredRuns` takes what a run left behind; a space's sync
 *   knows no `mastra_` table (docs/plans/tenant-sync.md).
 * - Tools stay closures over the run: each process builds them again in `runAgentStep`, and the
 *   one registered agent finds them through the turn's id in the request context.
 */

/** The turn stopped to ask a person: `drive` lets the run wait and no process holds it. */
export class TurnAsks extends Error {
  constructor(readonly question: string) {
    super(question);
  }
}

/** A new turn for a step, with the run's id in its own: its snapshots go with the run. */
export function newTurn(runId: string, stepId: string): RunTurn {
  return { stepId, id: `${runId}.${nanoid(12)}` };
}

/** What this process built for a turn. */
interface Held {
  instructions: string;
  model: MastraModelConfig;
  tools: Record<string, unknown>;
}
const held = new Map<string, Held>();
const TURN = "wizardTurn";

function heldOf(context: { get(key: string): unknown }): Held {
  const turn = held.get(String(context.get(TURN)));
  if (!turn) {
    throw new Error("A durable turn runs without what its step built.");
  }
  return turn;
}

interface TenantTurns {
  client: Client;
  ready: Promise<void>;
  agent: any;
}
const byTenant = new Map<string, TenantTurns>();

/** A checkpoint per model step, also while running: the only way a later process finds one. */
const KEEPS = new Set(["pending", "paused", "suspended", "running"]);

function make(client: Client): TenantTurns {
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
    // `read` below has the stream as it comes; nobody comes back to it later.
    cache: false,
    shouldPersistSnapshot: ({ workflowStatus }) => KEEPS.has(workflowStatus),
  });
  const mastra = new Mastra({
    agents: { wizardStep: durable as never },
    storage: store,
    logger: false,
    recovery: { durableAgents: "off", workflows: "off" },
  });
  return { client, ready: store.init(), agent: mastra.getAgent("wizardStep") };
}

/** The current tenant's agent, its store ready. */
async function tenantAgent() {
  const tenant = currentTenant();
  const client = await tenantClient(tenant);
  let entry = byTenant.get(tenant);
  if (!entry || entry.client !== client) {
    entry = make(client);
    byTenant.set(tenant, entry);
    entry.ready.catch(() => byTenant.delete(tenant));
  }
  await entry.ready;
  return entry.agent;
}

/** Aborts when `signal` does, except for a deploy's stop (`abort("stop")` in `stopRunner`). */
function turnSignal(signal: AbortSignal): AbortSignal {
  const own = new AbortController();
  const pass = () => {
    if (signal.reason !== "stop") {
      own.abort(signal.reason);
    }
  };
  if (signal.aborted) {
    pass();
  } else {
    signal.addEventListener("abort", pass, { once: true });
  }
  return own.signal;
}

/**
 * What a turn's tools work with. A cancel reaches them. A deploy's stop does not: what a tool would
 * make of it (an error, a person's "no") would stay in the conversation for the next runner, which
 * goes on at that call as if nothing had stopped.
 */
export function turnContext(ctx: StepContext, turn: RunTurn): StepContext {
  return {
    ...ctx,
    turn: turn.id,
    signal: turnSignal(ctx.signal),
    ask: async (ask) => {
      const answer = await ctx.ask(ask);
      // The wait ended because this process stops: nobody said no, the next runner asks again.
      if (ctx.signal.aborted && ctx.signal.reason === "stop") {
        await new Promise(() => undefined);
      }
      return answer;
    },
  };
}

/**
 * Asks the person: the turn suspends and nothing waits in memory. The question is on the row before
 * that, so a process that dies in between leaves a run the next one can let wait.
 */
function askPersonTool(turn: RunTurn, save: () => Promise<void>) {
  return createTool({
    id: "ask_person",
    description: prompt("tools", "tool.ask_person"),
    inputSchema: z.object({ question: z.string().min(1).max(2000) }),
    suspendSchema: z.object({ question: z.string() }),
    resumeSchema: z.object({ answer: z.string() }),
    execute: async ({ question }, context) => {
      const resumed = context?.agent?.resumeData as { answer?: string } | undefined;
      if (resumed?.answer !== undefined) {
        return { answer: resumed.answer } as never;
      }
      // Asked again after a crash: the answer to this question is on the row.
      if (turn.question === question && turn.answer !== undefined) {
        return { answer: turn.answer } as never;
      }
      turn.question = question;
      delete turn.answer;
      await save();
      return (await context?.agent?.suspend({ question })) as never;
    },
  });
}

/** How many results the conversation already holds for this tool call id. */
function resultsOf(id: string, context: any): number {
  const messages: any[] = context?.agent?.getMessages?.() ?? [];
  let found = 0;
  for (const message of messages) {
    for (const part of message?.content?.parts ?? []) {
      const call = part?.toolInvocation;
      if (call?.toolCallId === id && call.state === "result") {
        found += 1;
      }
    }
  }
  return found;
}

/**
 * `run_effect` knows a call by its tool call id, and a write found done is not done again. OpenAI,
 * Anthropic and Google don't repeat an id; a server that counts them per model step would have its
 * second write swallowed, and Mastra would show its model only the first result. So a call whose id
 * the conversation already has a result for stops the turn, before it acts. A crash that repeats a
 * call never gets here: its result is not in the conversation.
 */
function repeatsCallId(context: any): boolean {
  const id = context?.agent?.toolCallId;
  return id ? resultsOf(id, context) > 0 : false;
}

/**
 * The step's tools for a turn: what they made is on the row at once, and `stop` ends the turn when
 * a model repeats a tool call id.
 */
function turnTools(
  tools: Record<string, any>,
  turn: RunTurn,
  assets: AssetRef[],
  save: () => Promise<void>,
  stop: (why: StepError) => void,
): Record<string, unknown> {
  let kept = 0;
  const keep = async () => {
    if (assets.length > kept) {
      turn.assets = [...(turn.assets ?? []), ...assets.slice(kept)];
      kept = assets.length;
      await save();
    }
  };
  const out: Record<string, unknown> = {};
  for (const [name, tool] of Object.entries(tools)) {
    out[name] =
      typeof tool?.execute === "function"
        ? {
            ...tool,
            execute: async (input: unknown, context: unknown) => {
              if (repeatsCallId(context)) {
                const why = new StepError({ code: "toolCallIdRepeated" });
                stop(why);
                throw why;
              }
              const answer = await tool.execute(input, context);
              // Before the result goes into the conversation: whoever finds it there finds the file.
              await keep();
              return answer;
            },
          }
        : tool;
  }
  out.ask_person = askPersonTool(turn, save);
  return out;
}

/** Mastra's lease on a turn lapses within 15 s of its owner's end. */
const LEASE_WAIT_MS = 25_000;
const LEASE_LOOK_MS = 1000;

const STILL_HELD = new Set([
  "DURABLE_AGENT_RUN_ACTIVE",
  "DURABLE_AGENT_RECOVER_RUN_ACTIVE_LOCALLY",
  "DURABLE_AGENT_RECOVER_ALREADY_IN_PROGRESS",
]);
const NOTHING_STORED = new Set([
  "DURABLE_AGENT_RECOVER_SNAPSHOT_NOT_FOUND",
  "DURABLE_AGENT_RECOVER_CHECKPOINT_NOT_AVAILABLE",
  "DURABLE_AGENT_RECOVER_RUN_NOT_ACTIVE",
]);
const SUSPENDED = "DURABLE_AGENT_RECOVER_RUN_SUSPENDED";

export interface TurnInput {
  instructions: string;
  model: MastraModelConfig;
  /** Built over `turnContext`. */
  tools: Record<string, any>;
  /** The array the tools add to. */
  assets: AssetRef[];
  message: unknown;
  maxSteps: number;
  /** A model step has ended, with what it used. */
  onStepUsage(usage: unknown): Promise<void>;
  /** Text the model writes as it writes it. */
  onText?(delta: string): Promise<void>;
}

export interface TurnEnd {
  text: string;
  /** The turn's last message: `text` holds what the model said between its tool calls too. */
  closing: string;
  assets: AssetRef[];
}

/**
 * Runs a turn or goes on with it, until it ends or stops for a person (`TurnAsks`). `ctx` is the
 * step's own, not `turnContext`: only its signal tells a stop from a cancel.
 */
export async function durableTurn(
  turn: RunTurn,
  ctx: StepContext,
  input: TurnInput,
): Promise<TurnEnd> {
  const ended = () => ({
    text: turn.end?.text ?? "",
    closing: turn.end?.closing ?? "",
    assets: turn.assets ?? [],
  });
  // It ended before and the process died before `drive` kept the result: nothing runs again.
  if (turn.end) {
    return ended();
  }
  const id = turn.id;
  const save = ctx.saveState;
  const own = new AbortController();
  let stoppedBy: StepError | null = null;
  const mine: Held = {
    instructions: input.instructions,
    model: input.model,
    tools: turnTools(input.tools, turn, input.assets, save, (why) => {
      stoppedBy = why;
      own.abort(why);
    }),
  };
  held.set(id, mine);
  const context = new RequestContext();
  context.set(TURN, id);

  let asked = false;
  const callbacks = {
    closeOnSuspend: true,
    abortSignal: AbortSignal.any([turnSignal(ctx.signal), own.signal]),
    onSuspended: () => {
      asked = true;
    },
    onStepFinish: (step: any) => input.onStepUsage(step?.usage ?? step?.output?.usage),
    // The turn's end is kept before Mastra drops the snapshot: a process that dies before `drive`
    // saved the result would otherwise start the whole turn over, with new call ids.
    onFinish: async (data: { text?: string; steps?: { text?: string }[] }) => {
      turn.end = { text: data.text ?? "", closing: data.steps?.at(-1)?.text ?? "" };
      await save();
    },
  };

  const agent = await tenantAgent();

  /** Goes on where the turn is, or starts it. Mastra's snapshot says which. */
  const open = async (): Promise<any> => {
    const until = Date.now() + LEASE_WAIT_MS;
    let force = false;
    for (;;) {
      try {
        const result = await agent.recover(id, { ...callbacks, force });
        await ctx.emit("info", { code: "turnWentOn" });
        return result;
      } catch (err) {
        const code = (err as { id?: string }).id ?? "";
        if (code === SUSPENDED && turn.answer !== undefined) {
          return agent.resume(
            id,
            { answer: turn.answer },
            { ...callbacks, requestContext: context },
          );
        }
        if (code === SUSPENDED && turn.question) {
          // Stopped before the run could say it waits: it says so now.
          throw new TurnAsks(turn.question);
        }
        if (NOTHING_STORED.has(code)) {
          return agent.stream(input.message, {
            ...callbacks,
            runId: id,
            requestContext: context,
            maxSteps: input.maxSteps,
          });
        }
        if (!STILL_HELD.has(code)) {
          throw err;
        }
        if (Date.now() < until) {
          await new Promise((r) => setTimeout(r, LEASE_LOOK_MS));
          continue;
        }
        // The line gave this process the run, and the lease should have lapsed by now: an owner
        // that still holds it has lost its claim and doesn't know. Mastra stops it for this.
        if (force) {
          throw err;
        }
        force = true;
      }
    }
  };

  /** Reads what the turn says until it has ended or stopped. */
  const read = async (result: any) => {
    for await (const chunk of result.fullStream as AsyncIterable<any>) {
      const payload = chunk.payload ?? chunk;
      if (chunk.type === "text-delta") {
        await input.onText?.(payload.text ?? payload.delta ?? "");
      } else if (chunk.type === "error") {
        throw payload.error ?? new Error("The step's stream failed.");
      }
    }
  };

  /** Drive's signal: a stop ends the wait here too, and the turn stays where it is for the next runner. */
  const gone = new Promise<never>((_, reject) => {
    const off = () => reject(new Error("The turn was stopped."));
    if (ctx.signal.aborted) {
      off();
    } else {
      ctx.signal.addEventListener("abort", off, { once: true });
    }
  });
  gone.catch(() => undefined);

  const whileRunning = async () => {
    let result = await open();
    await read(result);
    // Recovery can park a turn at the question it was already answered: it goes on with the answer.
    if (asked && turn.answer !== undefined) {
      asked = false;
      result = await agent.resume(
        id,
        { answer: turn.answer },
        { ...callbacks, requestContext: context },
      );
      await read(result);
    }
    if (stoppedBy) {
      throw stoppedBy;
    }
    if (!asked && !turn.end) {
      // The end could not be kept (`save` refused or failed): it still counts for this process.
      const text = String((await result.output?.text) ?? "");
      const steps: { text?: string }[] = (await result.output?.steps) ?? [];
      turn.end = { text, closing: steps.at(-1)?.text ?? "" };
    }
  };

  const running = whileRunning();
  // A process that stops keeps the tools until the turn has let go of them: without them, a turn
  // still at work there would fail, and a failed turn drops the snapshot the next runner needs.
  const done = running.finally(() => {
    if (held.get(id) === mine) {
      held.delete(id);
    }
  });
  done.catch(() => undefined);
  await Promise.race([done, gone]);
  if (asked && turn.question && turn.answer === undefined) {
    throw new TurnAsks(turn.question);
  }
  return ended();
}

/** Mastra's tables that hold a turn by its id, with the column it is in. */
const TURN_TABLES = [
  ["mastra_workflow_snapshot", "run_id"],
  ["mastra_workflow_run_owners", '"runId"'],
] as const;

/**
 * What a run left in Mastra's store: a turn is dropped when it ends, but a run deleted, gone back
 * from or failed in the middle of one leaves its row. Only a turn's rows carry a run's id and a dot.
 */
export async function sweepTurnSnapshots(): Promise<void> {
  const client = await tenantClient(currentTenant());
  for (const [table, column] of TURN_TABLES) {
    const there = await client.execute({
      sql: "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
      args: [table],
    });
    if (there.rows.length) {
      await client.execute(
        `DELETE FROM ${table}
          WHERE instr(${column}, '.') > 0
            AND substr(${column}, 1, instr(${column}, '.') - 1) NOT IN (SELECT id FROM run)`,
      );
    }
  }
}

/** The turn on a run's state, when it belongs to this step. */
export function turnOf(state: RunState, stepId: string): RunTurn | undefined {
  return state.turn?.stepId === stepId ? state.turn : undefined;
}
