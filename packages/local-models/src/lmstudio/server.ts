import { jsonBody, type LocalServer, refusal } from "../servers/server.js";
import {
  lmStudioAddress,
  lmStudioDownload,
  lmStudioModels,
  lmStudioRoot,
  lmStudioState,
} from "./api.js";
import { lmStudioFetch } from "./load.js";

/** LM Studio as one of the servers on a computer. Its API removes no model: the app does. */
export const lmStudio: LocalServer = {
  id: "lmstudio",
  name: "LM Studio",
  address: lmStudioAddress,
  state: lmStudioState,
  models: lmStudioModels,
  download: lmStudioDownload,
  async ask(url, model, prompt, { fetch: doFetch, signal } = {}) {
    const root = lmStudioRoot(url);
    const res = await lmStudioFetch(root, { fetch: doFetch })(`${root}/v1/chat/completions`, {
      method: "POST",
      ...jsonBody({
        model: model.name,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 64,
      }),
      signal,
    });
    if (!res.ok) {
      throw await refusal(res, "LM Studio");
    }
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return body.choices?.[0]?.message?.content?.trim() ?? "";
  },
};
