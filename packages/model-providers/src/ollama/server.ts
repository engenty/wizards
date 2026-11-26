import { jsonBody, type LocalServer, refusal } from "../servers/server.js";
import { installedModels, ollamaAddress, ollamaRoot, ollamaState, pullModel } from "./api.js";

/** Ollama as one of the servers on a computer. */
export const ollama: LocalServer = {
  id: "ollama",
  name: "Ollama",
  address: ollamaAddress,
  async state(url, options) {
    const { version, models } = await ollamaState(url, options);
    return { running: version !== null, version, models, trouble: null };
  },
  models: installedModels,
  download: pullModel,
  async remove(url, model, { fetch: doFetch = fetch } = {}) {
    const res = await doFetch(`${ollamaRoot(url)}/api/delete`, {
      method: "DELETE",
      ...jsonBody({ model }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw await refusal(res, "Ollama");
    }
  },
  async ask(url, model, prompt, { fetch: doFetch = fetch, signal } = {}) {
    const res = await doFetch(`${ollamaRoot(url)}/api/chat`, {
      method: "POST",
      ...jsonBody({
        model: model.name,
        messages: [{ role: "user", content: prompt }],
        stream: false,
        ...(model.thinking ? { think: false } : {}),
        options: { num_predict: 16 },
      }),
      signal,
    });
    if (!res.ok) {
      throw await refusal(res, "Ollama");
    }
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      message?: { content?: string };
    };
    if (body.error) {
      throw new Error(body.error);
    }
    return body.message?.content?.trim() ?? "";
  },
};
