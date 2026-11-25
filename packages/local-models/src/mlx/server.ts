import { type ChatModel, ollamaModel } from "../ollama/model.js";
import type { LocalServer } from "../servers/server.js";
import { type HelperChunk, helper, mlxSupported, type Waiting } from "./helper.js";
import { downloadModel, mlxFolder, mlxModels, modelFolder, removeModel } from "./store.js";

/** Apple's MLX as one of the servers on a computer; its address is the folder of its models. */
export const mlx: LocalServer = {
  id: "mlx",
  name: "Apple MLX",
  address: mlxFolder,
  async state(folder) {
    const running = mlxSupported();
    const models = running ? (await mlxModels(folder)).map((m) => m.name) : [];
    return { running, version: null, models, trouble: null };
  },
  models: (folder) => (mlxSupported() ? mlxModels(folder, helper.model) : Promise.resolve([])),
  download: downloadModel,
  async remove(folder, model) {
    if (helper.model === modelFolder(folder, model)) {
      helper.stop();
    }
    await removeModel(folder, model);
  },
  async ask(folder, model, prompt, { signal } = {}) {
    const chat = mlxModel({
      folder,
      model: model.name,
      ...(model.thinking ? { thinking: false } : {}),
    });
    const { content } = await chat.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: prompt }] }],
      maxOutputTokens: 16,
      ...(signal ? { abortSignal: signal } : {}),
    });
    return content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("")
      .trim();
  },
};

/** A model of MLX as an AI SDK language model. It loads at its first call. */
export function mlxModel({
  folder,
  model,
  tools,
  thinking,
  warm,
  onWaiting,
}: {
  folder: string;
  model: string;
  tools?: boolean;
  thinking?: boolean;
  /**
   * Loads the model and reads the prompt up to its last message, and answers nothing: a call that
   * starts with the same then starts to answer at once.
   */
  warm?: boolean;
  /** What a call waits for before its first word; null once it begins to answer or calls a tool. */
  onWaiting?: (waiting: Waiting | null) => void;
}): ChatModel {
  const dir = modelFolder(folder, model);
  // The helper speaks the shape of Ollama's chat API.
  const answer = async (_url: unknown, init?: RequestInit) => {
    const { format, stream: _stream, model: _model, ...body } = JSON.parse(String(init?.body));
    const schema =
      format === undefined
        ? {}
        : { schema: JSON.stringify(format === "json" ? { type: "object" } : format) };
    const encoder = new TextEncoder();
    let waits: Waiting["state"] | undefined;
    const lines = helper
      .chat(
        { ...body, ...schema, ...(warm ? { warm } : {}), model: dir },
        init?.signal ?? undefined,
      )
      .pipeThrough(
        new TransformStream<HelperChunk, Uint8Array>({
          transform: (chunk, controller) => {
            if (chunk.wait) {
              waits = chunk.wait.state;
              onWaiting?.(chunk.wait);
              return;
            }
            if (chunk.message?.thinking) {
              if (waits !== "thinking") {
                waits = "thinking";
                onWaiting?.({ state: "thinking" });
              }
            } else if (waits) {
              waits = undefined;
              onWaiting?.(null);
            }
            controller.enqueue(encoder.encode(`${JSON.stringify(chunk)}\n`));
          },
        }),
      );
    return new Response(lines as unknown as BodyInit);
  };
  return ollamaModel({
    provider: "mlx",
    url: "http://mlx",
    model,
    ...(tools === undefined ? {} : { tools }),
    ...(thinking === undefined ? {} : { thinking }),
    fetch: answer as typeof fetch,
  });
}
