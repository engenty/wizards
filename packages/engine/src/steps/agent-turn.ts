import { note as runNote } from "@engenty/wizards-shared/run";
import type {
  ToolDescriptor,
  TurnContentPart,
  TurnMessage,
  TurnRequest,
} from "@engenty/wizards-shared/run-services";
import { prompt } from "../prompts.js";
import {
  type AgentModel,
  type AgentTurn,
  type StepContext,
  StepError,
  type StepToolSet,
  TurnAsks,
  type TurnToolCall,
} from "../types.js";

/**
 * An agent step's loop (docs/plans/runs-on-their-own.md, package 2.4): one model call, the turn
 * saved, its tool calls run one by one with the effect ids `<turn>:<toolCallId>`, each result
 * saved, the next model call. A process that goes on with the step loads the turn and goes on
 * where it stopped: a tool call without a result is made again under its id, and what it did
 * already is found by that id (the runtime's broker/effect.ts).
 *
 * Asking the person is a tool call too: the run waits with the question (`TurnAsks`), and the
 * answer is that call's result when the step goes on.
 */

/** The tool a turn asks the person with. */
export const ASK_PERSON = "ask_person";

const askPerson: ToolDescriptor = {
  name: ASK_PERSON,
  description: prompt("tools", "tool.ask_person"),
  inputSchema: {
    type: "object",
    properties: { question: { type: "string", minLength: 1, maxLength: 2000 } },
    required: ["question"],
    additionalProperties: false,
  },
  onlyReads: true,
};

export interface TurnInput {
  model: AgentModel;
  request: Pick<TurnRequest, "class" | "effort" | "maker">;
  system: string;
  /** The step's request: the turn's first message. */
  message: TurnMessage;
  tools: StepToolSet;
  /** The model may ask the person: a durable step's own turn. */
  mayAsk: boolean;
  /** At most this many model calls. */
  maxSteps: number;
  /** Text the model writes as it writes it. */
  onText?(delta: string): Promise<void>;
}

export interface TurnEnd {
  /** What the model wrote across its calls. */
  text: string;
  /** Its last answer. */
  closing: string;
}

/** A turn that has not begun: the step's request is its first message. */
export function newTurn(id: string, stepId: string, message: TurnMessage): AgentTurn {
  return { id, stepId, messages: [message], pending: [], calls: 0, text: "", assets: [] };
}

/**
 * Runs the turn `id`, or goes on with it, until it ends or stops for the person (`TurnAsks`). A
 * step that fails starts its turn over (`newTurn`) on its next try.
 */
export async function agentTurn(id: string, ctx: StepContext, input: TurnInput): Promise<TurnEnd> {
  const turn = (await ctx.turns.load(id)) ?? newTurn(id, ctx.stepId, input.message);
  if (turn.end) {
    input.tools.assets.splice(0, input.tools.assets.length, ...turn.assets);
    return turn.end;
  }
  // Gone on after an interruption, not after the person's answer.
  if (turn.calls > 0 && ctx.state.turn?.answer === undefined) {
    await ctx.emit("info", { code: "turnWentOn" });
  }
  // The files the tools make are on the turn with the result that tells of them.
  const made = input.tools.assets;
  let kept = made.length;
  const save = async () => {
    turn.assets.push(...made.slice(kept));
    kept = made.length;
    await ctx.turns.save(turn);
  };
  /** The turn ended: kept, and the step has every file its tools made, in any process. */
  const end = async (how: TurnEnd): Promise<TurnEnd> => {
    turn.end = how;
    await save();
    made.splice(0, made.length, ...turn.assets);
    return how;
  };
  const tools = input.tools.list();
  const told: ToolDescriptor[] = [
    ...tools.map(({ mastra: _, ...d }) => d),
    ...(input.mayAsk ? [askPerson] : []),
  ];
  for (;;) {
    while (turn.pending.length) {
      ctx.signal.throwIfAborted();
      const call = turn.pending[0];
      const answered = call.name === ASK_PERSON && input.mayAsk;
      const output = answered
        ? await askedPerson(ctx, call)
        : await callTool(id, ctx, input.tools, call);
      turn.messages.push({
        role: "tool",
        content: [{ type: "tool-result", toolCallId: call.toolCallId, name: call.name, output }],
      });
      turn.pending.shift();
      await save();
      // The answer is in the conversation now: the run no longer holds it.
      if (answered && ctx.state.turn) {
        delete ctx.state.turn.question;
        delete ctx.state.turn.answer;
        await ctx.saveState();
      }
    }
    if (turn.calls >= input.maxSteps) {
      return end({ text: turn.text, closing: lastText(turn.messages) });
    }
    ctx.signal.throwIfAborted();
    const answer = await modelCall(ctx, input, turn.messages, told);
    turn.calls += 1;
    turn.text = [turn.text, answer.text].filter(Boolean).join("\n\n");
    turn.messages.push({
      role: "assistant",
      content: [
        ...(answer.text ? [{ type: "text" as const, text: answer.text }] : []),
        ...answer.calls.map((c) => ({ type: "tool-call" as const, ...c })),
      ],
    });
    if (!answer.calls.length) {
      return end({ text: turn.text, closing: answer.text });
    }
    // A call id the conversation has a result for would find that call's row and not act: a
    // server that counts its ids per model call would have its second write swallowed.
    const seen = resultIds(turn.messages);
    for (const c of answer.calls) {
      if (seen.has(c.toolCallId)) {
        throw new StepError(runNote("toolCallIdRepeated"));
      }
      seen.add(c.toolCallId);
    }
    turn.pending = answer.calls;
    await save();
  }
}

/** One model call: what it wrote and the tool calls it asked for. */
async function modelCall(
  ctx: StepContext,
  input: TurnInput,
  messages: TurnMessage[],
  tools: ToolDescriptor[],
): Promise<{ text: string; calls: TurnToolCall[] }> {
  let text = "";
  const calls: TurnToolCall[] = [];
  const parts = input.model.turn(
    {
      stepId: ctx.stepId,
      ...input.request,
      system: input.system,
      messages,
      // A model that runs its tools itself (an installed client, the device) has them attached
      // and runs the ones the call names; the others call back as tool calls.
      ...(tools.length ? { tools } : {}),
    },
    ctx.signal,
  );
  for await (const part of parts) {
    if (part.type === "text") {
      text += part.text;
      await input.onText?.(part.text);
    } else if (part.type === "tool-call") {
      calls.push({ toolCallId: part.toolCallId, name: part.name, input: part.input });
    }
  }
  return { text, calls };
}

/**
 * Runs one of the step's tools under its effect id. A tool's error is the model's to read, as
 * any result; a stop or a cancel ends the turn.
 */
async function callTool(
  id: string,
  ctx: StepContext,
  tools: StepToolSet,
  call: TurnToolCall,
): Promise<unknown> {
  const tool = tools.list().find((t) => t.name === call.name);
  if (!tool || tool.provider) {
    return { error: `There is no tool ${call.name} in this step.` };
  }
  // The run notes that a tool may have done something: a later try has nothing else to tell it by.
  if (!tool.onlyReads) {
    await actedOn(ctx);
  }
  try {
    const { output } = await tools.call({
      name: call.name,
      input: call.input,
      effect: `${id}:${call.toolCallId}`,
    });
    return output;
  } catch (err) {
    if (ctx.signal.aborted) {
      throw err;
    }
    return { error: (err as Error).message || String(err) };
  }
}

/** Notes on the run that the step's turn may have acted. */
export async function actedOn(ctx: StepContext): Promise<void> {
  if (ctx.state.turn && !ctx.state.turn.acted) {
    ctx.state.turn.acted = true;
    await ctx.saveState();
  }
}

/**
 * The person's answer to what the turn asks. Asked first, the question goes on the run and the
 * turn stops; the answer the run took is the call's result when it goes on.
 */
async function askedPerson(ctx: StepContext, call: TurnToolCall): Promise<unknown> {
  const question = (call.input as { question?: unknown } | null)?.question;
  if (typeof question !== "string" || !question.trim()) {
    return { error: "Give the question as { question }." };
  }
  const own = ctx.state.turn;
  if (!own) {
    return { error: "Nobody can be asked in this step." };
  }
  if (own.question === question && own.answer !== undefined) {
    return { answer: own.answer };
  }
  own.question = question;
  delete own.answer;
  await ctx.saveState();
  throw new TurnAsks(question);
}

function resultIds(messages: TurnMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const m of messages) {
    for (const p of partsOf(m)) {
      if (p.type === "tool-result") {
        ids.add(p.toolCallId);
      }
    }
  }
  return ids;
}

/** The model's last written answer. */
function lastText(messages: TurnMessage[]): string {
  const last = messages.findLast((m) => m.role === "assistant");
  return last
    ? partsOf(last)
        .map((p) => (p.type === "text" ? p.text : ""))
        .join("")
    : "";
}

function partsOf(m: TurnMessage): TurnContentPart[] {
  return typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
}
