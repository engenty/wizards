import { z } from "zod";
import type { GooseChat, Part, Step, ToolAnswer, Turn } from "./chat.js";
import type { Page, Person, Tool, ToolContext, ToolResult } from "./tool.js";

// Goose, the copilot: a chat beside the page. Each question runs as steps: the model writes and
// calls tools, Goose runs them and gives it the results, until it answers. Tools read and
// propose changes; the person applies them. The system prompt and the tools are the host's.

/** What Goose sends while it answers, as server-sent events. */
export type GooseEvent =
  | { event: "text"; data: { delta: string } }
  | {
      event: "step";
      data: { id: string; label: string; state: "running" | "done" | "failed" };
    }
  | {
      event: "action";
      data: {
        kind: "edit" | "new";
        path: string;
        before?: string;
        after: string;
        reason?: string;
      };
    }
  | { event: "error"; data: { text: string } }
  | { event: "done"; data: Record<string, never> };

/** A question to Goose. */
export interface TurnInput {
  /** Earlier questions and answers, as text. */
  history?: Turn[];
  message: string;
  page?: Page;
  /** More for the model to read with the message (a PDF). */
  parts?: Part[];
}

/** What Goose tells the person itself. */
export interface GooseTexts {
  failed: string;
  off: string;
  refusal: string;
  tooLong: string;
}

const TEXTS: GooseTexts = {
  off: "Goose is switched off or not set up.",
  refusal: "\n\nGoose can't help with this one.",
  tooLong: "\n\nThe answer got too long; ask for less at once.",
  failed: "Goose could not answer",
};

export interface GooseOptions {
  /** The model; a function when it follows settings that change (null: Goose is off). */
  chat: GooseChat | (() => GooseChat | null);
  /** What goes before the message: who asks and what they have open (`pageContext`). */
  context?: (o: { person: Person; page?: Page }) => string;
  /** Earlier questions and answers the model sees (20). */
  historyLimit?: number;
  /** Each step's token use. */
  log?: (line: string) => void;
  /** Tool calls one question may take before Goose has to answer (12). */
  maxSteps?: number;
  /** A failed question, after the person has been told. */
  onError?: (err: unknown) => void;
  system: string | ((o: { person: Person; page?: Page }) => string);
  texts?: Partial<GooseTexts>;
  tools: Tool[];
}

export interface Goose {
  /** The model now; null when Goose is off. */
  chat(): GooseChat | null;
  readonly texts: GooseTexts;
  readonly tools: readonly Tool[];
  /** Answers a question, sending what happens through `emit`. Never throws. */
  turn(
    input: TurnInput,
    o: {
      person: Person;
      emit: (e: GooseEvent) => void | Promise<void>;
      signal?: AbortSignal;
    },
  ): Promise<void>;
}

/** How much of the open file and the selection goes along. */
const MAX_OPEN = 16_000;
const MAX_SELECTION = 4000;

/** Who asks and what they have open, as the model reads it. */
export function pageContext({ person, page }: { person: Person; page?: Page }): string {
  return [
    `The person is ${person.name}${person.role === "viewer" ? " (can read, not edit)" : ""}.`,
    page?.path ? `They have ${page.path} open.` : "They are not looking at a file.",
    page?.selection
      ? `They selected this text:\n"""\n${page.selection.slice(0, MAX_SELECTION)}\n"""`
      : "",
    page?.path && page.text !== undefined
      ? `The open file, as they see it:\n"""\n${page.text.slice(0, MAX_OPEN)}\n"""`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

const labelOf = (tool: Tool | undefined, name: string, input: Record<string, unknown>) => {
  try {
    return tool?.label?.(input) ?? name;
  } catch {
    return name;
  }
};

export function createGoose(o: GooseOptions): Goose {
  const byName = new Map<string, Tool>();
  for (const tool of o.tools) {
    if (byName.has(tool.spec.name)) {
      throw new Error(`Two Goose tools are named ${tool.spec.name}.`);
    }
    byName.set(tool.spec.name, tool);
  }
  const specs = o.tools.map((t) => t.spec);
  const texts = { ...TEXTS, ...o.texts };
  const maxSteps = o.maxSteps ?? 12;
  const historyLimit = o.historyLimit ?? 20;
  const context = o.context ?? pageContext;
  const chatNow = () => (typeof o.chat === "function" ? o.chat() : o.chat);

  async function runCall(
    call: Step["calls"][number],
    ctx: ToolContext,
    emit: (e: GooseEvent) => void | Promise<void>,
  ): Promise<ToolAnswer> {
    const tool = byName.get(call.name);
    const raw = (call.input ?? {}) as Record<string, unknown>;
    const label = labelOf(tool, call.name, raw);
    const step = (state: "running" | "done" | "failed") =>
      emit({ event: "step", data: { id: call.id, label, state } });
    await step("running");
    if (!tool) {
      await step("failed");
      return {
        id: call.id,
        content: `Unknown tool ${call.name}.`,
        error: true,
      };
    }
    try {
      const out = await tool.run(tool.input.parse(call.input ?? {}), ctx);
      const result: ToolResult = typeof out === "string" ? { text: out } : out;
      if (result.suggestion) {
        const s = result.suggestion;
        await emit({
          event: "action",
          data: {
            kind: s.oldText === undefined ? "new" : "edit",
            path: s.path,
            before: s.oldText,
            after: s.newText,
            reason: s.reason,
          },
        });
      }
      await step("done");
      return { id: call.id, content: result.text };
    } catch (err) {
      await step("failed");
      const content =
        err instanceof z.ZodError
          ? `Invalid input: ${z.prettifyError(err)}`
          : String((err as Error)?.message ?? err);
      return { id: call.id, content, error: true };
    }
  }

  return {
    tools: o.tools,
    texts,
    chat: chatNow,
    async turn(input, { person, emit, signal = new AbortController().signal }) {
      const chat = chatNow();
      if (!chat) {
        await emit({ event: "error", data: { text: texts.off } });
        return;
      }
      const ctx: ToolContext = { person, page: input.page, signal };
      try {
        const system =
          typeof o.system === "function" ? o.system({ person, page: input.page }) : o.system;
        const before = context({ person, page: input.page });
        const conversation = chat.start({
          system,
          tools: specs,
          history: (input.history ?? []).slice(-historyLimit),
          user: [
            {
              type: "text",
              text: before ? `${before}\n\n${input.message}` : input.message,
            },
            ...(input.parts ?? []),
          ],
          signal,
        });
        for (let n = 0; n < maxSteps && !signal.aborted; n++) {
          let step: Step;
          try {
            step = await conversation.step(
              (delta) => void emit({ event: "text", data: { delta } }),
            );
          } catch (err) {
            // A tool input cut off mid-JSON ends the stream; the first step is asked again once.
            if (n > 0 || !chat.retryable?.(err)) {
              throw err;
            }
            continue;
          }
          o.log?.(
            `[goose] ${person.email ?? person.name} ${chat.label ?? "model"} step ${n}: ${step.usage}`,
          );
          if (step.stop === "refusal") {
            await emit({ event: "text", data: { delta: texts.refusal } });
            break;
          }
          if (step.stop === "max_tokens") {
            await emit({ event: "text", data: { delta: texts.tooLong } });
            break;
          }
          if (step.calls.length === 0) {
            break;
          }
          const results: ToolAnswer[] = [];
          for (const call of step.calls) {
            results.push(await runCall(call, ctx, emit));
          }
          conversation.answer(results);
        }
        await emit({ event: "done", data: {} });
      } catch (err) {
        const text =
          chat.describe?.(err, texts.failed) ??
          `${texts.failed}: ${(err as Error)?.message ?? err}`;
        await emit({ event: "error", data: { text } });
        o.onError?.(err);
      }
    },
  };
}
