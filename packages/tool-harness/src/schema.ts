/** A tool's input as JSON schema, as far as the harness reads it. */
export interface InputSchema {
  type?: string;
  properties?: Record<string, { description?: string; [key: string]: unknown }>;
  required?: string[];
  [key: string]: unknown;
}

/** Not needed to call a tool. */
const NOISE = new Set(["$schema", "additionalProperties", "title", "examples", "pattern"]);

function slim(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(slim);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, part]) => !(NOISE.has(key) && typeof part !== "object") && key !== "$schema")
      .map(([key, part]) => [key, slim(part)]),
  );
}

/** The schema's properties as a model reads them. */
export const inputText = (input: InputSchema): string =>
  JSON.stringify({
    ...(slim(input.properties ?? {}) as object),
    ...(input.required?.length ? { required: input.required } : {}),
  });

/** Only the names: enough to know what a call is made of. */
export const inputNames = (input: InputSchema): string =>
  Object.keys(input.properties ?? {})
    .map((name) => (input.required?.includes(name) ? name : `${name}?`))
    .join(", ") || "none";

/** The names and what each is for, for the search: the schema's own words only blur it. */
export const inputWords = (input: InputSchema): string =>
  Object.entries(input.properties ?? {})
    .map(([name, property]) => `${name.replaceAll("_", " ")} ${property.description ?? ""}`.trim())
    .join("\n");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parsed(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  try {
    const read = JSON.parse(value) as unknown;
    return isRecord(read) ? read : null;
  } catch {
    return null;
  }
}

/**
 * What a model meant to call. Some models put the input into a JSON text, some beside the name
 * instead of under `input`: both are read as they were meant, nothing is guessed.
 */
export function callOf(raw: unknown): { name: string; input: Record<string, unknown> } {
  const record = parsed(raw) ?? {};
  const { name, input, arguments: args, ...beside } = record;
  const under = parsed(input) ?? parsed(args);
  return {
    name: typeof name === "string" ? name.trim() : "",
    input: under && Object.keys(under).length ? under : beside,
  };
}

/** The required properties a call leaves out. */
export const missing = (schema: InputSchema, input: Record<string, unknown>): string[] =>
  (schema.required ?? []).filter((name) => input[name] === undefined || input[name] === null);
