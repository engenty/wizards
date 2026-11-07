// The model behind Goose is a chat with tools. Goose depends on this interface only; the
// adapters (`@engenty/goose/anthropic`, `/openai`, `/sdk`, `/ai-sdk`) make one from an SDK.

/** A tool as the model sees it: its name, what it does and its input as JSON schema. */
export interface ToolSpec {
  description: string;
  /** A large input (a file's text): Anthropic streams it as it is written. */
  eager?: boolean;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
  name: string;
}

/** What the person's message holds. `cache`: the same in each step (Anthropic caches it). */
export type Part =
  | { type: "text"; text: string; cache?: boolean }
  | { type: "pdf"; data: string; title: string };

/** An earlier question or answer, as text. */
export interface Turn {
  role: "user" | "assistant";
  text: string;
}

export interface ToolCall {
  id: string;
  /** Undefined when the model wrote no valid JSON. */
  input: unknown;
  name: string;
}

export interface Step {
  calls: ToolCall[];
  stop: "end" | "tools" | "max_tokens" | "refusal";
  /** Token use, for the log. */
  usage: string;
}

/** A tool's result as the model reads it. */
export interface ToolAnswer {
  content: string;
  error?: boolean;
  id: string;
}

/** One conversation: a step asks the model, `answer` gives it the tools' results. */
export interface GooseConversation {
  answer(results: ToolAnswer[]): void;
  /** Streams the text through `onText` and returns the tool calls. */
  step(onText: (delta: string) => void): Promise<Step>;
}

export interface ChatStart {
  history: Turn[];
  /** Ends the request when the person goes away. */
  signal?: AbortSignal;
  system: string;
  tools: ToolSpec[];
  user: Part[];
}

export interface GooseChat {
  /** A failed call, for the person: `doing` says what Goose could not do. */
  describe?(err: unknown, doing: string): string;
  /** Provider and model, for the log. */
  label?: string;
  /** Whether a failed step may be asked again (not an API error). Without it, none is. */
  retryable?(err: unknown): boolean;
  start(o: ChatStart): GooseConversation;
}
