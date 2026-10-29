import { Agent } from "@mastra/core/agent";
import { agentModel, attachTools, type ResolvedModel } from "../models.js";

/**
 * The agent that acts in a space: the studio assistant (Goose) today, Work's chats next
 * (docs/plans/work-chats.md). Made the same way for both, so that each request starts with the
 * one before and the provider's prompt cache holds: the tools sorted by name, the instructions
 * marked, and the end of what the chat already said marked.
 */

const EPHEMERAL = { anthropic: { cacheControl: { type: "ephemeral" } } } as const;

type PromptMessage = { role: string; providerOptions?: Record<string, unknown> };

/** The tools by name, in that order: a request's tool block doesn't change with the order they were added in. */
export function sortedTools<T>(tools: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(tools).sort(([a], [b]) => a.localeCompare(b)));
}

const marked = <M extends PromptMessage>(message: M): M => ({
  ...message,
  providerOptions: {
    ...message.providerOptions,
    anthropic: {
      ...(message.providerOptions?.anthropic as Record<string, unknown> | undefined),
      ...EPHEMERAL.anthropic,
    },
  },
});

/**
 * Where a request's prompt gets Anthropic's cache marks besides the instructions: on the last
 * message before the newest message of the person (what the chat already said, the same next
 * turn), and on the newest message once tool steps follow it within the turn. The person's
 * message itself carries what changes each turn (the page, the time), so it is never marked:
 * the next turn sends it without that, and a mark there would only be paid for.
 */
export function cacheMarks<M extends PromptMessage>(prompt: M[]): M[] {
  const lastUser = prompt.findLastIndex((m) => m.role === "user");
  return prompt.map((message, at) => {
    const historyEnd = at === lastUser - 1 && message.role !== "system";
    const stepEnd = at === prompt.length - 1 && at > lastUser && lastUser >= 0;
    return historyEnd || stepEnd ? marked(message) : message;
  });
}

/** The input processor that sets those marks on each request. */
export const cacheMarksProcessor = {
  id: "cache-marks",
  processLLMRequest: ({ prompt }: { prompt: PromptMessage[] }) => ({ prompt: cacheMarks(prompt) }),
};

/** Instructions as a system message with Anthropic's cache mark. */
export const markedInstructions = (content: string) => ({
  role: "system" as const,
  content,
  providerOptions: EPHEMERAL,
});

/** The agent for a request: its model, instructions and tools. */
export function spaceAgent(options: {
  id: string;
  name: string;
  instructions: string;
  resolved: ResolvedModel<unknown>;
  tools: Record<string, unknown>;
}): Agent {
  const tools = sortedTools(options.tools);
  attachTools(options.resolved, tools);
  return new Agent({
    id: options.id,
    name: options.name,
    instructions: markedInstructions(options.instructions),
    model: agentModel(options.resolved),
    tools: tools as never,
    inputProcessors: [cacheMarksProcessor as never],
  });
}
