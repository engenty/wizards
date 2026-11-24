/**
 * Ollama on a computer, through its own API (`/api/…`): whether it runs, the models it holds and
 * what each can do, which of them fits the computer's memory, and downloads.
 */

/** Where Ollama answers when nothing names another address. */
export const OLLAMA_DEFAULT = "http://127.0.0.1:11434";

/** Ollama's own port, for an address given without one. */
const OLLAMA_PORT = "11434";

/**
 * Ollama's root address, from either way it is given: a root as OLLAMA_HOST names it
 * (`http://127.0.0.1:11434`, also `127.0.0.1:11434` or `localhost`), or the OpenAI-compatible
 * address as OLLAMA_URL names it (`http://127.0.0.1:11434/v1`). An address without a scheme is
 * http, and without a port too it is on Ollama's port.
 */
export function ollamaRoot(url: string): string {
  const root = url.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
  if (!root || /^[a-z][a-z0-9+.-]*:\/\//i.test(root)) {
    return root;
  }
  try {
    const parsed = new URL(`http://${root}`);
    if (!parsed.port) {
      parsed.port = OLLAMA_PORT;
    }
    return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "");
  } catch {
    return `http://${root}`;
  }
}

/** Where Ollama answers for this process: OLLAMA_URL (a root or `…/v1`), else Ollama's default. */
export function ollamaAddress(env: NodeJS.ProcessEnv = process.env): string {
  return ollamaRoot(env.OLLAMA_URL || OLLAMA_DEFAULT);
}

export interface OllamaRequestOptions {
  /** Another fetch, such as a test's. */
  fetch?: typeof fetch;
}

async function getJson<T>(
  doFetch: typeof fetch,
  url: string,
  init?: RequestInit,
  timeoutMs = 2000,
): Promise<T | null> {
  try {
    const res = await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

export interface OllamaState {
  /** The version of the Ollama that answers; null where none does. */
  version: string | null;
  /** The names of the models it holds; empty where it does not answer. */
  models: string[];
}

/** Whether Ollama answers at `url`, and the models it holds. */
export async function ollamaState(
  url: string,
  options: OllamaRequestOptions = {},
): Promise<OllamaState> {
  const doFetch = options.fetch ?? fetch;
  const root = ollamaRoot(url);
  const version =
    (await getJson<{ version?: string }>(doFetch, `${root}/api/version`))?.version ?? null;
  const tags = version
    ? await getJson<{ models?: { name: string }[] }>(doFetch, `${root}/api/tags`)
    : null;
  return { version, models: (tags?.models ?? []).map((m) => m.name) };
}

/** A model Ollama holds, as Ollama describes it. */
export interface InstalledModel {
  name: string;
  /** On disk, in bytes: about the memory it takes while it answers, too. */
  size: number;
  digest: string;
  /** As Ollama says: `completion`, `tools`, `vision`, `thinking`, `audio`, `embedding`, … */
  capabilities: string[];
  /** It writes text. */
  completion: boolean;
  /** It takes tools. */
  tools: boolean;
  /** It takes pictures. */
  vision: boolean;
  /** It can think before it answers. */
  thinking: boolean;
  /** `mlx` or `llamacpp`; null where Ollama does not say. */
  runner: string | null;
  quantization: string | null;
  /** In memory right now. */
  running: boolean;
}

interface ShowAnswer {
  capabilities?: string[];
  details?: { runner?: string; quantization_level?: string };
}

/** What `/api/show` said about a model, by its digest: it does not change while the digest stays. */
const shown = new Map<string, ShowAnswer>();

/**
 * The models of the Ollama at `url`, each with what it can do and whether it is in memory.
 * Ollama describes them all at once; a model it does not describe in time has no capabilities.
 * Empty where Ollama does not answer.
 */
export async function installedModels(
  url: string,
  options: OllamaRequestOptions = {},
): Promise<InstalledModel[]> {
  const doFetch = options.fetch ?? fetch;
  const root = ollamaRoot(url);
  const [tags, ps] = await Promise.all([
    getJson<{ models?: { name: string; size: number; digest: string }[] }>(
      doFetch,
      `${root}/api/tags`,
    ),
    getJson<{ models?: { name: string }[] }>(doFetch, `${root}/api/ps`),
  ]);
  const running = new Set((ps?.models ?? []).map((m) => m.name));
  return Promise.all(
    (tags?.models ?? []).map(async (m) => {
      let show = shown.get(m.digest);
      if (!show) {
        const answer = await getJson<ShowAnswer>(
          doFetch,
          `${root}/api/show`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: m.name }),
          },
          5000,
        );
        show = answer ?? {};
        if (answer) {
          shown.set(m.digest, answer);
        }
      }
      const capabilities = show.capabilities ?? [];
      return {
        name: m.name,
        size: m.size,
        digest: m.digest,
        capabilities,
        completion: capabilities.includes("completion"),
        tools: capabilities.includes("tools"),
        vision: capabilities.includes("vision"),
        thinking: capabilities.includes("thinking"),
        runner: show.details?.runner || null,
        quantization: show.details?.quantization_level || null,
        running: running.has(m.name),
      };
    }),
  );
}

/**
 * Whether a model fits a computer: it takes at most `share` of the memory, and leaves the rest to
 * everything else that runs there. Size and memory in the same unit; the model's size on disk
 * is about what it takes while it answers.
 */
export function fits(model: number | { size: number }, memory: number, share: number): boolean {
  const size = typeof model === "number" ? model : model.size;
  return size <= memory * share;
}

/**
 * Pulls a model into the Ollama at `url`; `onProgress` hears the bytes so far and in all as they
 * come, summed over the model's parts. Rejects with Ollama's own reason.
 */
export async function pullModel(
  url: string,
  model: string,
  onProgress: (done: number, total: number) => void,
  options: OllamaRequestOptions & { signal?: AbortSignal } = {},
): Promise<void> {
  const doFetch = options.fetch ?? fetch;
  const res = await doFetch(`${ollamaRoot(url)}/api/pull`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, stream: true }),
    signal: options.signal,
  });
  if (!(res.ok && res.body)) {
    throw new Error(`Ollama answered ${res.status}. ${await res.text().catch(() => "")}`.trim());
  }
  // Each part of the model reports on its own; the sum is the download.
  const parts = new Map<string, { total: number; completed: number }>();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let finished = false;
  const read = (line: string) => {
    if (!line.trim()) {
      return;
    }
    const event = JSON.parse(line) as {
      status?: string;
      digest?: string;
      total?: number;
      completed?: number;
      error?: string;
    };
    if (event.error) {
      throw new Error(event.error);
    }
    if (event.digest && event.total) {
      parts.set(event.digest, { total: event.total, completed: event.completed ?? 0 });
      let sum = 0;
      let all = 0;
      for (const part of parts.values()) {
        sum += part.completed;
        all += part.total;
      }
      onProgress(sum, all);
    }
    finished ||= event.status === "success";
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    pending += decoder.decode(value, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      read(line);
    }
  }
  read(pending);
  if (!finished) {
    throw new Error("The download broke off.");
  }
}
