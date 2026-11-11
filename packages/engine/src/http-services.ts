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
 * It is the engine's `StepServices`: an agent step's calls beyond `RunServices` go over HTTP too.
 * A request names the step (its id, its turn, the foreach entry it runs for) and never carries
 * it; the runtime builds the step's tools again for each call. The step's model is a set of flags
 * here: `attach` notes the tools' names, and each turn (`models/agentTurn`) has the runtime
 * attach the step's tools by those names, so a model with its own loop runs them there. What
 * those tools did comes back as lines beside the turn's parts: the run notes that the turn
 * acted, and the step has the files they made.
 */
import type { AssetRef } from "@engenty/wizards-shared/run";
import {
  type AgentModelFlags,
  type AgentTurnRequest,
  ASSET_REF_HEADER,
  assetRefSchema,
  type FileSave,
  RUN_SERVICES_PATH,
  type RunReport,
  type RunReportAnswer,
  ServiceError,
  type StepToolsAnswer,
  type StepToolsAt,
  serviceErrorSchema,
  type ToolResult,
  type TurnPart,
  type TurnToolsLine,
  turnToolsLineSchema,
} from "@engenty/wizards-shared/run-services";
import type { FlowFailure } from "@engenty/wizards-shared/transition";
import { actedOn } from "./steps/agent-turn.js";
import type {
  AgentModel,
  StepContext,
  StepServices,
  StepToolDescriptor,
  StepToolSet,
} from "./types.js";

export interface HttpServicesOptions {
  /** The runtime that serves the run's services: its origin, `https://wizards.example`. */
  url: string;
  /** The run's token. */
  token: string;
  /** Left out: `globalThis.fetch`. */
  fetch?: typeof fetch;
}

const RETRY: FlowFailure = { class: "retry", retryAfterMs: null };

/** An agent step's model once its tools are built: where they work, the step, its tool set. */
interface Bound {
  at: StepToolsAt;
  ctx: StepContext;
  set: StepToolSet;
}

/**
 * The run's services, and what only a host calls: `run.report` posts a copy of the run's state to
 * its tenant as each step starts, at each person's step and at the end. Step code never sees it.
 */
export interface HttpServices extends StepServices {
  run: {
    report(report: RunReport, signal?: AbortSignal): Promise<RunReportAnswer>;
  };
}

export function httpServices(options: HttpServicesOptions): HttpServices {
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

  /**
   * A turn's parts as the runtime streams them. `tools`: what the tools of a model with its own
   * loop did, a line of its own beside the parts.
   */
  async function* turn(
    path: string,
    request: unknown,
    signal: AbortSignal | undefined,
    tools?: (line: TurnToolsLine) => Promise<void>,
  ): AsyncIterable<TurnPart> {
    const res = (await post(path, request, signal)) as Response;
    let finished = false;
    for await (const line of lines(res, signal)) {
      const value = parseLine(line);
      const error = serviceErrorSchema.safeParse(value);
      if (error.success) {
        throw new ServiceError(error.data.error.failure, error.data.error.message);
      }
      const told = tools ? turnToolsLineSchema.safeParse(value) : null;
      if (told?.success) {
        await tools?.(told.data);
        continue;
      }
      const part = value as TurnPart;
      finished ||= part.type === "finish";
      yield part;
    }
    if (!finished) {
      throw new ServiceError(RETRY, "The model's turn broke off before it finished.");
    }
  }

  /** The models this client made, each told where its step's tools work once they are built. */
  const bindings = new WeakMap<AgentModel, (bound: Bound) => void>();

  /** An agent step's model: its flags from the runtime, its turns made there. */
  async function agentModel(
    request: Parameters<StepServices["models"]["agentModel"]>[0],
  ): Promise<AgentModel> {
    const flags = await call<AgentModelFlags>("models/agentModel", request);
    let bound: Bound | null = null;
    let attached: { names: string[]; ignorable: boolean } | null = null;
    const model: AgentModel = {
      ownLoop: flags.ownLoop,
      takesTools: flags.takesTools,
      seesImages: flags.seesImages,
      // The tools stay with the runtime: it attaches the step's own by these names.
      attach(tools, ignorable) {
        attached = { names: Object.keys(tools), ignorable };
      },
      turn(turnRequest, signal) {
        const body: AgentTurnRequest =
          bound && attached
            ? { ...turnRequest, attached: { ...bound.at, ...attached } }
            : turnRequest;
        const at = bound;
        return turn("models/agentTurn", body, signal, async ({ tools }) => {
          if (!at) {
            return;
          }
          // As the engine's own loop notes it before such a call (steps/agent.ts).
          if (tools.acted) {
            await actedOn(at.ctx);
          }
          at.set.assets.push(...(tools.assets ?? []));
        });
      },
    };
    bindings.set(model, (b) => {
      bound = b;
    });
    return model;
  }

  /** An agent step's tools: built by the runtime, each call made there. */
  async function forStep(
    step: { id: string },
    ctx: StepContext,
    { model, turn: stepTurn }: { model: AgentModel; turn: string },
  ): Promise<StepToolSet> {
    const entry = ctx.scope.entry?.index;
    const at: StepToolsAt = {
      stepId: step.id,
      turn: stepTurn,
      ...(entry === undefined ? {} : { entry }),
    };
    const answer = await call<StepToolsAnswer>("tools/forStep", at, ctx.signal);
    // Without code: a model that runs its tools itself has them attached by the runtime.
    const tools: StepToolDescriptor[] = answer.tools.map((d) => ({
      ...d,
      mastra: { id: d.name, description: d.description, inputSchema: d.inputSchema },
    }));
    const assets: AssetRef[] = [...answer.assets];
    const set: StepToolSet = {
      list: () => tools,
      async call(request) {
        const result = await call<ToolResult>("tools/stepCall", { ...at, ...request }, ctx.signal);
        assets.push(...(result.assets ?? []));
        return result;
      },
      assets,
      ...(answer.instructions ? { instructions: answer.instructions } : {}),
      sandbox: answer.sandbox,
    };
    bindings.get(model)?.({ at, ctx, set });
    return set;
  }

  return {
    models: {
      turn: (request, signal) => turn("models/turn", request, signal),
      decide: (request, signal) => call("models/decide", request, signal),
      embed: (values, signal) => call("models/embed", { values }, signal),
      agentModel,
    },
    tools: {
      list: (stepId) => call("tools/list", { stepId }),
      call: (request, signal) => call("tools/call", request, signal),
      forStep,
      // The runtime reads the step and the agent's file: only the step's id goes.
      ofAgent: (step, ctx) => call("tools/ofAgent", { stepId: step.id }, ctx.signal),
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
    run: {
      report: (report, signal) => call<RunReportAnswer>("run/report", report, signal),
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
