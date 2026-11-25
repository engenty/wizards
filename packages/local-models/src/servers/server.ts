/** The servers on a computer that run open models. */
export const SERVER_IDS = ["ollama", "lmstudio"] as const;
export type ServerId = (typeof SERVER_IDS)[number];

/** A model a server holds, as the server describes it. */
export interface InstalledModel {
  name: string;
  /** On disk, in bytes: about the memory it takes while it answers, too. */
  size: number;
  digest: string;
  /** `completion`, `tools`, `vision`, `thinking`, `audio`, `embedding`, `decision`, … */
  capabilities: string[];
  /** It writes text. */
  completion: boolean;
  /** It takes tools. */
  tools: boolean;
  /** It takes pictures. */
  vision: boolean;
  /** It can think before it answers. */
  thinking: boolean;
  /** `mlx` or `llamacpp`; null where the server does not say. */
  runner: string | null;
  quantization: string | null;
  /** In memory right now. */
  running: boolean;
}

/**
 * Why a server that is there gives nothing away: it wants a token (`locked`), or it is older than
 * the API this package speaks (`old`).
 */
export type ServerTrouble = "locked" | "old";

export interface ServerState {
  /** It answers at the address. */
  running: boolean;
  /** Null where the server does not say. */
  version: string | null;
  /** The names of the models it holds. */
  models: string[];
  trouble: ServerTrouble | null;
}

export interface ServerOptions {
  /** Another fetch, such as a test's. */
  fetch?: typeof fetch;
}

/**
 * A server on a computer that runs open models, through its own API. Nothing but `ask` loads a
 * model.
 */
export interface LocalServer {
  id: ServerId;
  /** The product name, as the person knows it. */
  name: string;
  /** Where it answers for this process, when nothing names another address. */
  address(env?: NodeJS.ProcessEnv): string;
  state(url: string, options?: ServerOptions): Promise<ServerState>;
  /** The models it holds; empty where it does not answer. */
  models(url: string, options?: ServerOptions): Promise<InstalledModel[]>;
  /** Downloads a model; `onProgress` hears the bytes so far and in all. Rejects with the server's reason. */
  download(
    url: string,
    model: string,
    onProgress: (done: number, total: number) => void,
    options?: ServerOptions & { signal?: AbortSignal },
  ): Promise<void>;
  /** Removes a model; absent where the server's API does not. Rejects with the server's reason. */
  remove?(url: string, model: string, options?: ServerOptions): Promise<void>;
  /** One short answer of a model, which loads it. Rejects with the server's reason. */
  ask(
    url: string,
    model: InstalledModel,
    prompt: string,
    options?: ServerOptions & { signal?: AbortSignal },
  ): Promise<string>;
}

/** The JSON of a request; null where nothing answers, or not with 200. */
export async function getJson<T>(
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

/** A JSON request's parts. */
export function jsonBody(body: unknown): { headers: Record<string, string>; body: string } {
  return { headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

/** What a server said as it refused: its `error`, in any of the spellings, else the text. */
export async function refusal(res: Response, name: string): Promise<Error> {
  const text = (await res.text().catch(() => "")).trim();
  let said = text;
  try {
    const { error } = JSON.parse(text) as { error?: string | { message?: string } };
    said = (typeof error === "string" ? error : error?.message) ?? text;
  } catch {
    // the text as it came
  }
  return new Error(said.slice(0, 400) || `${name} answered ${res.status}.`);
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
