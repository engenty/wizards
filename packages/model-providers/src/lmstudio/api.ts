import {
  getJson,
  type InstalledModel,
  jsonBody,
  refusal,
  type ServerOptions,
  type ServerState,
} from "../servers/server.js";

/**
 * LM Studio on a computer, through its own REST API (`/api/v1/…`, LM Studio 0.4.0 and newer): the
 * models it holds, downloads, and a model loaded with the context length a caller needs. Where
 * its server wants a token, LM_API_TOKEN is it.
 */

/** Where LM Studio answers when nothing names another address. */
export const LMSTUDIO_DEFAULT = "http://127.0.0.1:1234";

const NAME = "LM Studio";

/** LM Studio's root address, from its root or the OpenAI-compatible `…/v1`. */
export function lmStudioRoot(url: string): string {
  return url.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
}

/** Where LM Studio answers for this process: LMSTUDIO_URL (a root or `…/v1`), else its default. */
export function lmStudioAddress(env: NodeJS.ProcessEnv = process.env): string {
  return lmStudioRoot(env.LMSTUDIO_URL || LMSTUDIO_DEFAULT);
}

/** A request's headers: the token, where there is one. */
export function lmStudioHeaders(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const token = env.LM_API_TOKEN?.trim();
  return token ? { authorization: `Bearer ${token}` } : {};
}

/** A model as `GET /api/v1/models` lists it. */
export interface ListedModel {
  type: "llm" | "embedding" | "decision";
  key: string;
  quantization?: { name?: string | null } | null;
  size_bytes: number;
  loaded_instances?: { id: string; config?: { context_length?: number } }[];
  max_context_length?: number | null;
  format?: "gguf" | "mlx" | null;
  capabilities?: {
    vision?: boolean;
    trained_for_tool_use?: boolean;
    reasoning?: { allowed_options?: string[] };
  };
  decision_type?: string;
}

const JOB = { llm: "completion", embedding: "embedding", decision: "decision" } as const;

/** The models as LM Studio lists them; null where it does not answer. */
export async function listedModels(
  url: string,
  { fetch: doFetch = fetch }: ServerOptions = {},
): Promise<ListedModel[] | null> {
  const list = await getJson<{ models?: ListedModel[] }>(
    doFetch,
    `${lmStudioRoot(url)}/api/v1/models`,
    { headers: lmStudioHeaders() },
    5000,
  );
  return list ? (list.models ?? []) : null;
}

export async function lmStudioState(
  url: string,
  { fetch: doFetch = fetch }: ServerOptions = {},
): Promise<ServerState> {
  const state: ServerState = { running: false, version: null, models: [], trouble: null };
  try {
    const res = await doFetch(`${lmStudioRoot(url)}/api/v1/models`, {
      headers: lmStudioHeaders(),
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) {
      const { models } = (await res.json()) as { models?: ListedModel[] };
      return { ...state, running: true, models: (models ?? []).map((m) => m.key) };
    }
    const trouble = res.status === 401 || res.status === 403 ? "locked" : "old";
    return { ...state, running: true, trouble };
  } catch {
    return state;
  }
}

/** The models of the LM Studio at `url`; empty where it does not answer. */
export async function lmStudioModels(
  url: string,
  options: ServerOptions = {},
): Promise<InstalledModel[]> {
  return ((await listedModels(url, options)) ?? []).map((m) => {
    const tools = Boolean(m.capabilities?.trained_for_tool_use);
    const vision = Boolean(m.capabilities?.vision);
    const thinking = Boolean(m.capabilities?.reasoning?.allowed_options?.some((o) => o !== "off"));
    return {
      name: m.key,
      size: m.size_bytes,
      digest: m.key,
      capabilities: [
        JOB[m.type],
        ...(tools ? ["tools"] : []),
        ...(vision ? ["vision"] : []),
        ...(thinking ? ["thinking"] : []),
      ],
      completion: m.type === "llm",
      tools,
      vision,
      thinking,
      runner: m.format === "mlx" ? "mlx" : m.format === "gguf" ? "llamacpp" : null,
      quantization: m.quantization?.name || null,
      running: Boolean(m.loaded_instances?.length),
    };
  });
}

interface DownloadStatus {
  job_id?: string;
  status: "downloading" | "paused" | "completed" | "failed" | "already_downloaded";
  total_size_bytes?: number;
  downloaded_bytes?: number;
}

/** Downloads a model of LM Studio's catalog, or by its Hugging Face address; asked again each second. */
export async function lmStudioDownload(
  url: string,
  model: string,
  onProgress: (done: number, total: number) => void,
  {
    fetch: doFetch = fetch,
    signal,
    every = 1000,
  }: ServerOptions & { signal?: AbortSignal; every?: number } = {},
): Promise<void> {
  const root = lmStudioRoot(url);
  const ask = async (path: string, init: RequestInit = {}) => {
    const res = await doFetch(`${root}${path}`, {
      ...init,
      headers: { ...init.headers, ...lmStudioHeaders() },
      signal,
    });
    if (!res.ok) {
      throw await refusal(res, NAME);
    }
    return (await res.json()) as DownloadStatus;
  };
  let status = await ask("/api/v1/models/download", { method: "POST", ...jsonBody({ model }) });
  const job = status.job_id;
  while (status.status === "downloading" && job) {
    onProgress(status.downloaded_bytes ?? 0, status.total_size_bytes ?? 0);
    await new Promise((resolve) => setTimeout(resolve, every));
    signal?.throwIfAborted();
    status = await ask(`/api/v1/models/download/status/${encodeURIComponent(job)}`);
  }
  if (status.status === "paused") {
    throw new Error("The download is paused in LM Studio.");
  }
  if (status.status === "failed") {
    throw new Error("The download failed. LM Studio says why.");
  }
}
