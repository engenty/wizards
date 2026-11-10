/**
 * The run's services over HTTP (docs/plans/runs-on-their-own.md, "The run's services"): the
 * client of the runtime's `POST <url>/api/run-services/v1/<service>/<call>` (apps/runtime/src/
 * routes/run-services.ts), for an engine that runs a run outside the runtime's process. The run's
 * token names the tenant and the run; every call is a JSON POST with it as `Authorization: Bearer`.
 *
 * What comes back as the runtime sends it: `models/turn` as NDJSON, one `TurnPart` per line, read
 * as it streams; `files/read` as the bytes with the file's `AssetRef` in `x-asset-ref`;
 * `files/workspace` as the bytes; a 204 for `context/prepareInputs` and `people/tell`; JSON for
 * the rest, `Pending` answers among them as they are. A failure is a `ServiceError` with the class
 * the runtime gave it; a network failure, or a 5xx that is not one of its answers, is `retry`.
 *
 * Only `fetch`, `TextDecoder` and `btoa`: no Node built-in, so the engine bundles for any host.
 *
 * Not here yet: the engine's calls beyond `RunServices` (`StepServices` in ./types.ts:
 * `models.agentModel`, `tools.forStep`, `tools.ofAgent`). Package 3.5b serves them and adds them
 * here, beside `models` and `tools` in `httpServices`.
 */
import type { AssetRef } from "@engenty/wizards-shared/run";
import {
  ASSET_REF_HEADER,
  assetRefSchema,
  type FileSave,
  RUN_SERVICES_PATH,
  type RunServices,
  ServiceError,
  serviceErrorSchema,
  type TurnPart,
} from "@engenty/wizards-shared/run-services";
import type { FlowFailure } from "@engenty/wizards-shared/transition";

export interface HttpServicesOptions {
  /** The runtime that serves the run's services: its origin, `https://wizards.example`. */
  url: string;
  /** The run's token. */
  token: string;
  /** Left out: `globalThis.fetch`. */
  fetch?: typeof fetch;
}

const RETRY: FlowFailure = { class: "retry", retryAfterMs: null };

export function httpServices(options: HttpServicesOptions): RunServices {
  const base = `${options.url.replace(/\/+$/, "")}${RUN_SERVICES_PATH}`;
  const fetchOf = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  /**
   * One call. An answer that is not 2xx throws its failure; with `missing`, the runtime's 404 is
   * null, for a caller that reads it as no such file.
   */
  async function post(
    path: string,
    body: unknown,
    signal?: AbortSignal,
    missing = false,
  ): Promise<Response | null> {
    let res: Response;
    try {
      res = await fetchOf(`${base}/${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      throw (
        aborted(err, signal) ??
        new ServiceError(RETRY, `The run's services did not answer: ${messageOf(err)}`)
      );
    }
    if (res.ok) {
      return res;
    }
    const failure = await failureOf(res);
    if (missing && res.status === 404 && failure.said) {
      return null;
    }
    throw failure.error;
  }

  /** A JSON answer; a 204 is nothing. */
  async function call<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const res = (await post(path, body, signal)) as Response;
    if (res.status === 204) {
      return undefined as T;
    }
    const text = await read(res, signal, () => res.text());
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ServiceError(RETRY, `The run's services answered ${path} with no JSON.`);
    }
  }

  /** A call that answers 204. */
  const done = async (path: string, body: unknown) => {
    await call<void>(path, body);
  };

  /** The bytes of an answer; null: no such file. */
  async function bytes(
    path: string,
    body: unknown,
  ): Promise<{ res: Response; data: Uint8Array } | null> {
    const res = await post(path, body, undefined, true);
    if (!res) {
      return null;
    }
    return { res, data: new Uint8Array(await read(res, undefined, () => res.arrayBuffer())) };
  }

  return {
    models: {
      async *turn(request, signal) {
        const res = (await post("models/turn", request, signal)) as Response;
        let finished = false;
        for await (const line of lines(res, signal)) {
          const value = parseLine(line);
          const error = serviceErrorSchema.safeParse(value);
          if (error.success) {
            throw new ServiceError(error.data.error.failure, error.data.error.message);
          }
          const part = value as TurnPart;
          finished ||= part.type === "finish";
          yield part;
        }
        if (!finished) {
          throw new ServiceError(RETRY, "The model's turn broke off before it finished.");
        }
      },
      decide: (request, signal) => call("models/decide", request, signal),
      embed: (values, signal) => call("models/embed", { values }, signal),
    },
    tools: {
      list: (stepId) => call("tools/list", { stepId }),
      call: (request, signal) => call("tools/call", request, signal),
    },
    context: {
      forStep: (stepId, stepOptions) =>
        call("context/forStep", stepOptions ? { stepId, options: stepOptions } : { stepId }),
      prepareInputs: (stepId) => done("context/prepareInputs", { stepId }),
    },
    files: {
      async read(ref) {
        const found = await bytes("files/read", { ref });
        if (!found) {
          return null;
        }
        return { ref: assetRefOf(found.res), data: found.data };
      },
      save: (file) => call<AssetRef>("files/save", saveBody(file)),
      link: (ref) => call("files/link", { ref }),
      uploads: () => call("files/uploads", {}),
      async workspace(path) {
        return (await bytes("files/workspace", { path }))?.data ?? null;
      },
    },
    data: {
      query: (request) => call("data/query", request),
      exec: (request) => call("data/exec", request),
      rows: (listId) => call("data/rows", { listId }),
      counts: () => call("data/counts", {}),
    },
    steps: {
      // The runtime reads the step from the run's definition: only its id goes, and its visit.
      run: (step, signal, effect) =>
        call("steps/run", { stepId: step.id, ...(effect ? { effect } : {}) }, signal),
    },
    people: {
      tell: (notice) => done("people/tell", notice),
    },
  };
}

/** The failure a refused answer says: the runtime's `ServiceErrorBody`, else one by its status. */
async function failureOf(res: Response): Promise<{ error: ServiceError; said: boolean }> {
  const text = await res.text().catch(() => "");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  const said = serviceErrorSchema.safeParse(body);
  if (said.success) {
    return {
      error: new ServiceError(said.data.error.failure, said.data.error.message),
      said: true,
    };
  }
  const message = `The run's services answered ${res.status}.`;
  // Not the runtime's own answer: a proxy, a runtime that went away, too many calls.
  if (res.status >= 500 || res.status === 429) {
    return { error: new ServiceError(RETRY, message), said: false };
  }
  return { error: new ServiceError({ class: "final" }, message), said: false };
}

/** A body read; a connection that breaks while it is read is `retry`. */
async function read<T>(
  res: Response,
  signal: AbortSignal | undefined,
  body: () => Promise<T>,
): Promise<T> {
  try {
    return await body();
  } catch (err) {
    throw (
      aborted(err, signal) ??
      new ServiceError(
        RETRY,
        `The answer of ${res.url || "the run's services"} broke off: ${messageOf(err)}`,
      )
    );
  }
}

/** The lines of an NDJSON body, each as it arrives; reading stops when the caller stops. */
async function* lines(res: Response, signal: AbortSignal | undefined): AsyncIterable<string> {
  if (!res.body) {
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let rest = "";
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (err) {
        throw (
          aborted(err, signal) ??
          new ServiceError(RETRY, `The model's turn broke off: ${messageOf(err)}`)
        );
      }
      rest += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      let at = rest.indexOf("\n");
      while (at >= 0) {
        const line = rest.slice(0, at).trim();
        rest = rest.slice(at + 1);
        if (line) {
          yield line;
        }
        at = rest.indexOf("\n");
      }
      if (chunk.done) {
        break;
      }
    }
    if (rest.trim()) {
      yield rest.trim();
    }
  } finally {
    // The caller stopped early, or the stream failed: let the runtime know nobody reads on.
    reader.cancel().catch(() => undefined);
  }
}

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    throw new ServiceError(RETRY, "The model's turn sent a line that is not JSON.");
  }
}

function assetRefOf(res: Response): AssetRef {
  const header = res.headers.get(ASSET_REF_HEADER);
  const parsed = header ? assetRefSchema.safeParse(safeJson(header)) : null;
  if (!parsed?.success) {
    throw new ServiceError(
      RETRY,
      `The run's services sent a file without its ${ASSET_REF_HEADER}.`,
    );
  }
  return parsed.data;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** A save as it crosses HTTP: an address as it is, bytes as base64. */
function saveBody(file: FileSave): Record<string, unknown> {
  if ("url" in file) {
    return file;
  }
  const { data, ...rest } = file;
  return {
    ...rest,
    base64: base64Of(typeof data === "string" ? new TextEncoder().encode(data) : data),
  };
}

/** Base64 of bytes with `btoa`, a slice at a time so a large file fits the call stack. */
export function base64Of(data: Uint8Array): string {
  const SLICE = 0x8000;
  let binary = "";
  for (let i = 0; i < data.length; i += SLICE) {
    binary += String.fromCharCode(...data.subarray(i, i + SLICE));
  }
  return btoa(binary);
}

/** The caller's own abort, given back as it is: it is not the services' failure. */
function aborted(err: unknown, signal: AbortSignal | undefined): unknown {
  return signal?.aborted ? (signal.reason ?? err) : null;
}

const messageOf = (err: unknown) => String((err as Error)?.message ?? err);
