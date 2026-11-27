import { jsonBody, refusal, type ServerOptions } from "../servers/server.js";
import { listedModels, lmStudioHeaders, lmStudioRoot } from "./api.js";

/**
 * Loading: LM Studio loads a model by itself at the first call, with the context length of its
 * own settings, which a conversation with tools outgrows at once. So a model is loaded before the
 * call, with the length the caller needs, and unloaded once nobody asked it for a while: LM
 * Studio keeps a model loaded this way until it is told otherwise.
 */

/** Tokens a model reads at most, where the caller names no other number. */
const CONTEXT = 16_384;

/** How long a model this process loaded stays, unasked. */
const IDLE_MS = 30 * 60_000;

/** Loading takes as long as the model is large. */
const LOAD_TIMEOUT = 180_000;

/** The models this process loaded, by address and instance, each with the clock of its unloading. */
const loaded = new Map<string, ReturnType<typeof setTimeout>>();

/** Loads that run now: calls that come meanwhile wait for the same one. */
const loading = new Map<string, Promise<void>>();

async function unload(root: string, instance: string, doFetch: typeof fetch): Promise<void> {
  const clock = loaded.get(`${root} ${instance}`);
  clearTimeout(clock);
  loaded.delete(`${root} ${instance}`);
  await doFetch(`${root}/api/v1/models/unload`, {
    method: "POST",
    ...withToken(jsonBody({ instance_id: instance })),
    signal: AbortSignal.timeout(30_000),
  }).catch(() => undefined);
}

const withToken = (init: { headers: Record<string, string>; body: string }) => ({
  ...init,
  headers: { ...init.headers, ...lmStudioHeaders() },
});

/** A call was made on it: its clock starts again. Only for an instance this process loaded. */
function touch(root: string, instance: string, doFetch: typeof fetch): void {
  const id = `${root} ${instance}`;
  clearTimeout(loaded.get(id));
  const clock = setTimeout(() => void unload(root, instance, doFetch), IDLE_MS);
  clock.unref?.();
  loaded.set(id, clock);
}

async function load(
  root: string,
  model: string,
  context: number,
  doFetch: typeof fetch,
): Promise<void> {
  const held = (await listedModels(root, { fetch: doFetch }))?.find((m) => m.key === model);
  if (!held) {
    // Not one it lists: LM Studio itself says so at the call.
    return;
  }
  const wanted = Math.min(context, held.max_context_length ?? context);
  for (const { id, config } of held.loaded_instances ?? []) {
    if ((config?.context_length ?? 0) >= wanted) {
      if (loaded.has(`${root} ${id}`)) {
        touch(root, id, doFetch);
      }
      return;
    }
    // Loaded too short: it makes room for the same model at the length that is needed.
    await unload(root, id, doFetch);
  }
  const res = await doFetch(`${root}/api/v1/models/load`, {
    method: "POST",
    ...withToken(jsonBody({ model, context_length: wanted })),
    signal: AbortSignal.timeout(LOAD_TIMEOUT),
  });
  if (!res.ok) {
    throw await refusal(res, "LM Studio");
  }
  const { instance_id } = (await res.json()) as { instance_id?: string };
  touch(root, instance_id ?? model, doFetch);
}

/** Has a model in memory that reads at least `context` tokens, or all it can. */
export function lmStudioLoaded(
  url: string,
  model: string,
  { context = CONTEXT, fetch: doFetch = fetch }: ServerOptions & { context?: number } = {},
): Promise<void> {
  const root = lmStudioRoot(url);
  const key = `${root} ${model}`;
  const running = loading.get(key);
  if (running) {
    return running;
  }
  const run = load(root, model, context, doFetch).finally(() => loading.delete(key));
  loading.set(key, run);
  return run;
}

/**
 * A `fetch` for an OpenAI-compatible client of LM Studio: before each call the model it names is
 * loaded with the context length, and the token goes along where there is one.
 */
export function lmStudioFetch(
  url: string,
  options: ServerOptions & { context?: number } = {},
): typeof fetch {
  const doFetch = options.fetch ?? fetch;
  return async (input, init) => {
    if (typeof init?.body === "string") {
      const { model } = JSON.parse(init.body) as { model?: string };
      if (model) {
        await lmStudioLoaded(url, model, options);
      }
    }
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(lmStudioHeaders())) {
      headers.set(name, value);
    }
    return doFetch(input, { ...init, headers });
  };
}
