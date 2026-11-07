import { z } from "zod";
import type { ToolSpec } from "./chat.js";

/** Who asks Goose. Which role someone has is the host's to say. */
export interface Person {
  email?: string;
  name: string;
  role?: "owner" | "editor" | "viewer";
}

/** What the person has open: the file (with unpublished edits) and selected text. */
export interface Page {
  path?: string;
  selection?: string;
  text?: string;
}

export interface ToolContext {
  page?: Page;
  person: Person;
  signal: AbortSignal;
}

/**
 * A change Goose proposes; the person decides whether to apply it. `oldText` is the file as it
 * is (none for a new file), `newText` the file as it would be.
 */
export interface Suggestion {
  newText: string;
  oldText?: string;
  path: string;
  reason?: string;
}

export interface ToolResult {
  /** Shown to the person as an `action` event. */
  suggestion?: Suggestion;
  /** What the model reads. */
  text: string;
}

export interface Tool<I = unknown> {
  /** Checks the model's input before `run`. */
  input: z.ZodType<I>;
  /** What the person sees while it runs, e.g. "Read notes/plan.md"; the tool's name otherwise. */
  label?(input: Record<string, unknown>): string;
  run(input: I, ctx: ToolContext): Promise<ToolResult | string>;
  spec: ToolSpec;
}

/** A tool whose JSON schema is made from its zod input (`.describe()` gives the descriptions). */
export function defineTool<I>(o: {
  name: string;
  description: string;
  input: z.ZodType<I>;
  eager?: boolean;
  label?: Tool<I>["label"];
  run: Tool<I>["run"];
}): Tool<I> {
  const { $schema: _, ...schema } = z.toJSONSchema(o.input, {
    io: "input",
  }) as Record<string, unknown>;
  if (schema.type !== "object") {
    throw new Error(`The input of ${o.name} must be an object.`);
  }
  return {
    spec: {
      name: o.name,
      description: o.description,
      input_schema: {
        properties: {},
        ...schema,
        type: "object",
      },
      ...(o.eager ? { eager: true } : {}),
    },
    input: o.input,
    label: o.label,
    run: o.run,
  };
}
