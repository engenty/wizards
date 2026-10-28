import { nanoid } from "nanoid";

/**
 * A client (Claude Code, Codex) as the model runs the space's tools itself over the bridge, and
 * Mastra's stream carries only its text (spike #268). The tools of such a turn are wrapped: each
 * call and its result is recorded here, so the chat shows it as a tool step like a call of an API
 * model, while it streams and once it is stored.
 */

export interface ClientStep {
  toolCallId: string;
  toolName: string;
  input: unknown;
  state: "running" | "done" | "failed";
  output?: unknown;
  errorText?: string;
}

export type ClientStepListener = (step: ClientStep) => void;

export class ClientSteps {
  readonly list: ClientStep[] = [];
  private readonly listeners = new Set<ClientStepListener>();

  on(listener: ClientStepListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private tell(step: ClientStep) {
    for (const listener of this.listeners) {
      listener(step);
    }
  }

  /** The tools with each call recorded; tools the provider runs itself stay as they are. */
  wrap(tools: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(tools).map(([name, tool]) => {
        const t = tool as { execute?: (input: unknown, context?: unknown) => Promise<unknown> };
        if (typeof t?.execute !== "function") {
          return [name, tool];
        }
        const execute = t.execute.bind(t);
        return [
          name,
          Object.assign(Object.create(Object.getPrototypeOf(t)), t, {
            execute: async (input: unknown, context?: unknown) => {
              const step: ClientStep = {
                toolCallId: `client-${nanoid(10)}`,
                toolName: name,
                input,
                state: "running",
              };
              this.list.push(step);
              this.tell(step);
              try {
                step.output = await execute(input, context);
                step.state = "done";
                return step.output;
              } catch (err) {
                step.state = "failed";
                step.errorText = err instanceof Error ? err.message : String(err);
                throw err;
              } finally {
                this.tell(step);
              }
            },
          }),
        ];
      }),
    );
  }
}

/** A step as a chunk of the AI SDK's UI message stream. */
export function stepChunk(step: ClientStep): Record<string, unknown> {
  if (step.state === "running") {
    return {
      type: "tool-input-available",
      toolCallId: step.toolCallId,
      toolName: step.toolName,
      input: step.input,
    };
  }
  return step.state === "done"
    ? { type: "tool-output-available", toolCallId: step.toolCallId, output: step.output }
    : { type: "tool-output-error", toolCallId: step.toolCallId, errorText: step.errorText ?? "" };
}

/** The steps as the parts of a stored message (Mastra's format, which the chat converts). */
export function stepParts(steps: ClientStep[]): Record<string, unknown>[] {
  return steps.map((step) => ({
    type: "tool-invocation",
    toolInvocation: {
      state: "result",
      toolCallId: step.toolCallId,
      toolName: step.toolName,
      args: step.input,
      result: step.state === "failed" ? { error: step.errorText ?? "" } : (step.output ?? null),
    },
  }));
}
