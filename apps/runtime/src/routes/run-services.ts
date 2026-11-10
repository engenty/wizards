import { StepError } from "@engenty/wizards-engine/types";
import {
  ASSET_REF_HEADER,
  type DecideRequest,
  dataStatementRequestSchema,
  decideRequestSchema,
  embedRequestSchema,
  emptyRequestSchema,
  fileRefRequestSchema,
  fileSaveRequestSchema,
  forStepRequestSchema,
  isServiceStep,
  listRowsRequestSchema,
  noticeSchema,
  ServiceError,
  type ServiceErrorBody,
  stepRequestSchema,
  stepRunRequestSchema,
  type TurnPart,
  toolCallRequestSchema,
  turnRequestSchema,
  workspaceRequestSchema,
} from "@engenty/wizards-shared/run-services";
import type { FlowFailure } from "@engenty/wizards-shared/transition";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { z } from "zod";
import { whereOf } from "../broker/call.js";
import { withCaller } from "../broker/caller.js";
import { readRunToken } from "../broker/token.js";
import { withTenant } from "../db/client.js";
import { classifyFailure } from "../engine/failures.js";
import { contextAt, failureContext, loadRun } from "../engine/runner.js";
import type { RunRow } from "../engine/types.js";
import { SignInNeeded } from "../engine/types.js";
import { NotedError } from "../model-errors.js";
import type { InProcessServices } from "../run-services/index.js";
import { runServicesOn } from "../tools/acted.js";
import { holderWho } from "../tools/plugin.js";
import { notFoundAnswer } from "./lang.js";

/*
 * The run's services over HTTP (docs/plans/runs-on-their-own.md, "The run's services"), for a
 * run that works outside this process: `POST /api/run-services/v1/<service>/<call>` with the
 * run's token as `Authorization: Bearer`. The token names the tenant and the run, nothing in the
 * path or the body does; the call runs as the runner would run it at the step it names, with the
 * run's in-process services (run-services/index.ts) and the caller set as for the run's person.
 *
 * Every call takes JSON. `models/turn` answers NDJSON, one `TurnPart` per line as the model
 * writes it; a failure after the first part is a last line `{"error":{failure,message}}`.
 * `files/read` and `files/workspace` answer the bytes (`files/read` with the file's `AssetRef` in
 * `x-asset-ref`), every other call JSON. A failure answers a `ServiceErrorBody`.
 *
 * Not here yet: the engine's calls beyond `RunServices` (`StepServices` in packages/engine:
 * `models.agentModel`, `tools.forStep`, `tools.ofAgent`) are served by a later package (3.5b).
 */

/** A file saved as base64 in JSON must fit: a page, an image, a short clip. */
export const RUN_SERVICES_BODY_LIMIT = 50 * 1024 * 1024;

/** What a call does with its checked request, inside the run's tenant and as its caller. */
interface Call<S extends z.ZodType = z.ZodType> {
  request: S;
  answer(
    input: z.infer<S>,
    services: InProcessServices,
    signal: AbortSignal,
    run: RunRow,
  ): Promise<Response>;
}

const call = <S extends z.ZodType>(request: S, answer: Call<S>["answer"]): Call =>
  ({ request, answer }) as Call;

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value ?? null), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const done = () => new Response(null, { status: 204 });

const bytes = (data: Uint8Array, headers: Record<string, string> = {}) =>
  new Response(data as Uint8Array<ArrayBuffer>, {
    headers: { "content-type": "application/octet-stream", ...headers },
  });

/** A failure as it crosses HTTP, with a status for its class. */
function failed(failure: FlowFailure, message: string, status?: number): Response {
  const body: ServiceErrorBody = { error: { failure, message } };
  return json(body, status ?? STATUS[failure.class]);
}

const STATUS: Record<FlowFailure["class"], number> = {
  retry: 503,
  credits: 402,
  sign_in: 403,
  final: 422,
};

const refused = (message: string, status: number) => failed({ class: "final" }, message, status);

/**
 * What an error says over HTTP. A `ServiceError` keeps its class; what the runtime says itself
 * (a step's, a sign-in that is needed) is sorted as the runner sorts it; anything else is short
 * trouble here, tried again.
 */
function failureOf(err: unknown): { failure: FlowFailure; message: string; status: number } {
  const message = String((err as Error)?.message ?? err).slice(0, 400);
  if (err instanceof ServiceError) {
    return { failure: err.failure, message, status: STATUS[err.failure.class] };
  }
  if (err instanceof StepError || err instanceof NotedError) {
    const sorted = classifyFailure(err, failureContext());
    const failure: FlowFailure =
      sorted.class === "retry"
        ? { class: "retry", retryAfterMs: sorted.retryAfterMs }
        : sorted.class === "sign_in"
          ? { class: "sign_in", service: err instanceof SignInNeeded ? err.service : "" }
          : { class: sorted.class };
    return { failure, message, status: STATUS[failure.class] };
  }
  console.error("[run-services]", err);
  return { failure: { class: "retry", retryAfterMs: null }, message, status: 500 };
}

/** A turn's parts, one JSON line each, sent as they come. The first part is waited for, so a call that fails at once answers with its status. */
async function streamed(parts: AsyncIterable<TurnPart>): Promise<Response> {
  const it = parts[Symbol.asyncIterator]();
  const first = await it.next();
  const encoder = new TextEncoder();
  const line = (value: unknown) => encoder.encode(`${JSON.stringify(value)}\n`);
  const body = new ReadableStream<Uint8Array>({
    // Called at once, inside the call's tenant and caller: the parts after the first are read there too.
    start(controller) {
      /** False once the caller went away: nothing more is read. */
      const send = (value: unknown) => {
        try {
          controller.enqueue(line(value));
          return true;
        } catch {
          return false;
        }
      };
      void (async () => {
        try {
          for (let next = first; !next.done; next = await it.next()) {
            if (!send(next.value)) {
              await it.return?.();
              return;
            }
          }
        } catch (err) {
          const { failure, message } = failureOf(err);
          send({ error: { failure, message } } satisfies ServiceErrorBody);
        }
        try {
          controller.close();
        } catch {
          // The caller went away.
        }
      })();
    },
    cancel() {
      void it.return?.();
    },
  });
  return new Response(body, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
}

/** JSON in a header: every character past ASCII escaped, which JSON reads back the same. */
const asciiJson = (value: unknown) =>
  JSON.stringify(value).replace(
    /[^\x20-\x7e]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

const CALLS: Record<string, Record<string, Call>> = {
  models: {
    turn: call(turnRequestSchema, (request, s, signal) => streamed(s.models.turn(request, signal))),
    decide: call(decideRequestSchema, async (request, s, signal) =>
      json(await s.models.decide(request as DecideRequest, signal)),
    ),
    embed: call(embedRequestSchema, async ({ values }, s, signal) =>
      json(await s.models.embed(values, signal)),
    ),
  },
  tools: {
    list: call(stepRequestSchema, async ({ stepId }, s) => json(await s.tools.list(stepId))),
    call: call(toolCallRequestSchema, async (request, s, signal) =>
      json(await s.tools.call(request, signal)),
    ),
  },
  context: {
    forStep: call(forStepRequestSchema, async ({ stepId, options }, s) =>
      json(await s.context.forStep(stepId, options)),
    ),
    prepareInputs: call(stepRequestSchema, async ({ stepId }, s) => {
      await s.context.prepareInputs(stepId);
      return done();
    }),
  },
  files: {
    read: call(fileRefRequestSchema, async ({ ref }, s) => {
      const found = await s.files.read(ref);
      if (!found) {
        return refused("No such file.", 404);
      }
      return bytes(found.data, { [ASSET_REF_HEADER]: asciiJson(found.ref) });
    }),
    save: call(fileSaveRequestSchema, async (file, s) =>
      json(
        await s.files.save(
          "base64" in file
            ? {
                stepId: file.stepId,
                kind: file.kind,
                name: file.name,
                mime: file.mime,
                data: new Uint8Array(Buffer.from(file.base64, "base64")),
                ...(file.ai ? { ai: file.ai } : {}),
                effect: file.effect,
              }
            : file,
        ),
      ),
    ),
    link: call(fileRefRequestSchema, async ({ ref }, s) => json(await s.files.link(ref))),
    uploads: call(emptyRequestSchema, async (_, s) => json(await s.files.uploads())),
    workspace: call(workspaceRequestSchema, async ({ path }, s) => {
      const data = await s.files.workspace(path);
      return data ? bytes(data) : refused("No such file in the run's workspace.", 404);
    }),
  },
  data: {
    query: call(dataStatementRequestSchema, async (request, s) =>
      json(await s.data.query(request)),
    ),
    exec: call(dataStatementRequestSchema, async (request, s) => json(await s.data.exec(request))),
    rows: call(listRowsRequestSchema, async ({ listId }, s) => json(await s.data.rows(listId))),
    counts: call(emptyRequestSchema, async (_, s) => json(await s.data.counts())),
  },
  steps: {
    // The step is the run's own, by its id: a host does not send what a step is.
    run: call(stepRunRequestSchema, async ({ stepId, effect }, s, signal, run) => {
      const step = run.definition.steps.find((x) => x.id === stepId);
      if (!(step && isServiceStep(step))) {
        return refused(`Step ${stepId} is not one a service does whole.`, 400);
      }
      return json(await s.steps.run(step, signal, effect));
    }),
  },
  people: {
    tell: call(noticeSchema, async (notice, s) => {
      await s.people.tell(notice);
      return done();
    }),
  },
};

/** The run's token from `Authorization: Bearer`. */
const tokenOf = (c: Context) =>
  c.req.header("authorization")?.match(/^Bearer\s+(\S+)\s*$/i)?.[1] ?? null;

/** The step a request names, if it names one (`stepId`, a notice's, a save's). */
const stepIdOf = (input: unknown): string | null => {
  const stepId = (input as { stepId?: unknown } | null)?.stepId;
  return typeof stepId === "string" ? stepId : null;
};

/**
 * Off: nothing answers here, as for any path this runtime does not serve. The switch is the
 * organization's, read in the token's tenant once the token opened it; before that (no such call,
 * no token, a token that opens nothing) the runtime's own switches count.
 */
const off = (c: Context) => c.json(notFoundAnswer(c), 404);

export const runServiceRoutes = new Hono()
  .use(
    "*",
    bodyLimit({
      maxSize: RUN_SERVICES_BODY_LIMIT,
      onError: () => refused("The request is too large.", 413),
    }),
  )
  .post("/:service/:call", async (c) => {
    const handler = CALLS[c.req.param("service")]?.[c.req.param("call")];
    const token = tokenOf(c);
    const read = handler && token ? await readRunToken(token) : null;
    if (!(handler && read && "claims" in read)) {
      if (!(await runServicesOn())) {
        return off(c);
      }
      if (!handler) {
        return refused("No such call.", 404);
      }
      return read && "refused" in read
        ? refused(`The run's token opens nothing (${read.refused}).`, 401)
        : refused("The run's token is missing.", 401);
    }
    const { claims } = read;
    const signal = c.req.raw.signal;
    return withTenant(claims.tenant, async () => {
      if (!(await runServicesOn())) {
        return off(c);
      }
      const raw = await c.req.json().catch(() => undefined);
      const parsed = handler.request.safeParse(raw ?? {});
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return refused(
          `The request is not valid: ${issue?.path.join(".") || "body"}: ${issue?.message ?? ""}`,
          400,
        );
      }
      const run = await loadRun(claims.run);
      if (!run) {
        return refused("The run's token opens nothing (no_run).", 401);
      }
      const stepId = stepIdOf(parsed.data);
      if (stepId !== null && !run.definition.steps.some((s) => s.id === stepId)) {
        return refused(`The wizard has no step ${stepId}.`, 400);
      }
      try {
        const ctx = await contextAt(run, stepId, signal);
        // As the runner's AI step calls: for the person the run is held for.
        const caller = { who: holderWho(ctx), where: whereOf(ctx) };
        return await withCaller(caller, () =>
          handler.answer(parsed.data, ctx.services, signal, run),
        );
      } catch (err) {
        const { failure, message, status } = failureOf(err);
        return failed(failure, message, status);
      }
    });
  });
