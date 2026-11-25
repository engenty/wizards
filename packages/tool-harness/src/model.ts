import { TOOL_CALL } from "./harness.js";

/** What of an AI SDK language model the harness reads. */
interface StreamPart {
  type: string;
  toolName?: string;
  input?: unknown;
}
interface CallOptions {
  tools?: { name: string }[];
}

const meant = (shown: Set<string>, name: string | undefined): name is string =>
  name !== undefined && shown.has(TOOL_CALL) && !shown.has(name);

/** A call of a tool that is not in the prompt, as the `tool_call` it means. */
function rewritten<T extends StreamPart>(shown: Set<string>, part: T): T {
  if (part.type === "tool-call" && meant(shown, part.toolName)) {
    let input: unknown = part.input ?? {};
    if (typeof input === "string") {
      try {
        input = JSON.parse(input || "{}");
      } catch {
        // It stays the text it is: the harness says what is missing.
      }
    }
    const call = JSON.stringify({ name: part.toolName, input });
    return { ...part, toolName: TOOL_CALL, input: call };
  }
  if (part.type === "tool-input-start" && meant(shown, part.toolName)) {
    return { ...part, toolName: TOOL_CALL };
  }
  return part;
}

/**
 * A model whose direct calls of tools outside the prompt go through the harness. A model that read
 * of a tool in the conversation calls it by its name; without this the call goes nowhere and the
 * answer is empty. The harness decides what runs: a name it does not know runs nothing.
 */
export function throughHarness<M extends object>(model: M): M {
  return new Proxy(model, {
    get(target, key) {
      const value = Reflect.get(target, key, target) as unknown;
      if (typeof value !== "function") {
        return value;
      }
      if (key !== "doStream" && key !== "doGenerate") {
        return value.bind(target);
      }
      return async (options: CallOptions) => {
        const shown = new Set((options.tools ?? []).map((tool) => tool.name));
        const result = (await value.call(target, options)) as {
          stream?: ReadableStream<StreamPart>;
          content?: StreamPart[];
        };
        if (!shown.has(TOOL_CALL)) {
          return result;
        }
        return {
          ...result,
          ...(result.content
            ? { content: result.content.map((part) => rewritten(shown, part)) }
            : {}),
          ...(result.stream
            ? {
                stream: result.stream.pipeThrough(
                  new TransformStream<StreamPart, StreamPart>({
                    transform: (part, controller) => controller.enqueue(rewritten(shown, part)),
                  }),
                ),
              }
            : {}),
        };
      };
    },
  });
}
