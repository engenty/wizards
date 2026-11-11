import { randomId } from "@engenty/wizards-engine/ids";
import { actedOn } from "@engenty/wizards-engine/steps/agent-turn";
import { agentEntries, entryContext, entryStep } from "@engenty/wizards-engine/steps/foreach";
import { StepError, type StepToolSet } from "@engenty/wizards-engine/types";
import {
  type AgentStep,
  classIdOf,
  decisionAsAgent,
  textClassOf,
} from "@engenty/wizards-shared/definition";
import {
  type AgentModelFlags,
  ASSET_REF_HEADER,
  agentModelRequestSchema,
  agentTurnRequestSchema,
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
  type RunReportAnswer,
  runReportSchema,
  ServiceError,
  type ServiceErrorBody,
  type StepToolsAnswer,
  type StepToolsAt,
  stepRequestSchema,
  stepRunRequestSchema,
  stepToolCallSchema,
  stepToolsAtSchema,
  type TurnPart,
  type TurnToolsLine,
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
import { contextAt, failureContext, keepReport, loadRun } from "../engine/runner.js";
import type { RunRow } from "../engine/types.js";
import { SignInNeeded } from "../engine/types.js";
import { NotedError } from "../model-errors.js";
import type { InProcessContext } from "../run-services/in-process.js";
import type { AgentModel, InProcessServices } from "../run-services/index.js";
import { runServicesOn } from "../tools/acted.js";
import { holderWho } from "../tools/plugin.js";
import { notFoundAnswer } from "./lang.js";
import { runHostsOn } from "./peer.js";

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
 * Beside the services, `run/report` takes a host's copy of the run it works on: as each step
 * starts, at each person's step and at the end, written to the run's record here.
 *
 * An agent step's calls (the engine's `StepServices` beyond `RunServices`) name the step, never
 * carry it: `tools/forStep`, `tools/stepCall` and `models/agentTurn` name the step, its turn and
 * the foreach entry it runs for, and the step is read from the run's definition (`toolsAt`): a
 * wizard's agent's as its file has it, an entry's with that entry's item. Its tools are built
 * again for each call. `models/agentTurn` attaches the ones the engine attached, by name, to the
 * step's model: one with its own loop (an installed client, the run's device) runs them here, and
 * what they did goes back as `TurnToolsLine`s beside the turn's parts.
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
    ctx: InProcessContext,
  ): Promise<Response>;
}

/** A request that names what the run doesn't have: a step, an entry, a turn. */
class BadRequest extends ServiceError {
  constructor(message: string) {
    super({ class: "final" }, message);
  }
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
  if (err instanceof BadRequest) {
    return { failure: err.failure, message, status: 400 };
  }
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
async function streamed(parts: AsyncIterable<TurnPart | TurnToolsLine>): Promise<Response> {
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

/** The agent step of the definition, as the engine runs it: a decision as an agent. */
function agentStepOf(run: RunRow, stepId: string): AgentStep {
  const found = run.definition.steps.find((s) => s.id === stepId);
  if (found?.type === "agent") {
    return found;
  }
  if (found?.type === "decision") {
    return decisionAsAgent(found);
  }
  throw new BadRequest(`Step ${stepId} is not an agent step.`);
}

/**
 * The tools of the agent step `at` names, built as the engine has them built: the step from the
 * run's definition, a wizard's agent's as its file has it (`ofAgent`), a foreach entry's with
 * that entry's item; `model`: the step's model, else its class's. Built again for each call.
 */
async function toolsAt(
  run: RunRow,
  ctx: InProcessContext,
  at: StepToolsAt,
  model?: AgentModel,
): Promise<{ set: StepToolSet; ctx: InProcessContext }> {
  if (!at.turn.startsWith(`${run.id}.`)) {
    throw new BadRequest(`The turn ${at.turn} is not one of this run's.`);
  }
  const s = ctx.services;
  let step = agentStepOf(run, at.stepId);
  if (step.agent) {
    step = (await s.tools.ofAgent({ ...step, agent: step.agent }, ctx)).step;
  }
  let own: InProcessContext = { ...ctx, turn: at.turn };
  if (step.foreach) {
    const entries = agentEntries(step, ctx);
    if (at.entry === undefined || at.entry >= entries.length) {
      throw new BadRequest(`Step ${at.stepId} has no entry ${at.entry ?? "named"}.`);
    }
    own = entryContext(own, entries, at.entry, at.turn);
    step = entryStep(step);
  } else if (at.entry !== undefined) {
    throw new BadRequest(`Step ${at.stepId} has no entries.`);
  }
  const stepModel =
    model ??
    (await s.models.agentModel({
      stepId: at.stepId,
      class: textClassOf(step.model ?? "standard"),
      effort: step.effort,
      maker: step.maker ? classIdOf(step, "standard") : undefined,
    }));
  const set = await s.tools.forStep(step, own, {
    model: stepModel,
    uploads: await s.files.uploads(),
    turn: at.turn,
  });
  return { set, ctx: own };
}

/**
 * The step's tools attached to its model, the ones the engine attached by name: a provider's own
 * tool as it is, any other one called here, as the engine's own loop calls it (steps/agent.ts).
 * `told`: the line of what the calls did since it was last asked, null for nothing.
 */
async function attachAt(
  run: RunRow,
  ctx: InProcessContext,
  model: AgentModel,
  attached: NonNullable<z.infer<typeof agentTurnRequestSchema>["attached"]>,
): Promise<() => TurnToolsLine | null> {
  const { names, ignorable, ...at } = attached;
  const { set, ctx: own } = await toolsAt(run, ctx, at, model);
  let acted = false;
  const tools: Record<string, unknown> = {};
  for (const tool of set.list().filter((t) => names.includes(t.name))) {
    tools[tool.name] = tool.provider
      ? tool.mastra
      : {
          ...tool.mastra,
          execute: async (input: unknown, context: unknown) => {
            // Noted on the run before it acts, here and in the engine's state (the line).
            if (!tool.onlyReads) {
              await actedOn(own);
              acted = true;
            }
            const callId =
              (context as { agent?: { toolCallId?: string } } | undefined)?.agent?.toolCallId ??
              randomId();
            const { output } = await set.call(
              { name: tool.name, input, effect: `${at.turn}:${callId}` },
              context,
            );
            return output;
          },
        };
  }
  model.attach(tools, ignorable);
  let kept = set.assets.length;
  return () => {
    const assets = set.assets.slice(kept);
    kept = set.assets.length;
    if (!(acted || assets.length)) {
      return null;
    }
    const line: TurnToolsLine = {
      tools: { ...(acted ? { acted: true as const } : {}), ...(assets.length ? { assets } : {}) },
    };
    acted = false;
    return line;
  };
}

/** A turn's parts with what its tools did, each line before the part that follows it. */
async function* toldWith(
  parts: AsyncIterable<TurnPart>,
  told: () => TurnToolsLine | null,
): AsyncIterable<TurnPart | TurnToolsLine> {
  try {
    for await (const part of parts) {
      const line = told();
      if (line) {
        yield line;
      }
      yield part;
    }
  } catch (err) {
    // What the tools did counts for the step even when the turn fails.
    const line = told();
    if (line) {
      yield line;
    }
    throw err;
  }
  const line = told();
  if (line) {
    yield line;
  }
}

const CALLS: Record<string, Record<string, Call>> = {
  models: {
    turn: call(turnRequestSchema, (request, s, signal) => streamed(s.models.turn(request, signal))),
    agentModel: call(agentModelRequestSchema, async (request, s) => {
      const model = await s.models.agentModel(request);
      return json({
        ownLoop: model.ownLoop,
        takesTools: model.takesTools,
        seesImages: model.seesImages,
      } satisfies AgentModelFlags);
    }),
    // A turn of the step's model: the class's model, with the step's tools attached by name. A
    // model without its own loop only needs a provider's own tools of them.
    agentTurn: call(
      agentTurnRequestSchema,
      async ({ attached, ...request }, s, signal, run, ctx) => {
        const model = await s.models.agentModel(request);
        const told =
          attached && (model.ownLoop || request.tools?.some((t) => t.provider))
            ? await attachAt(run, ctx, model, attached)
            : () => null;
        return streamed(toldWith(model.turn(request, signal), told));
      },
    ),
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
    forStep: call(stepToolsAtSchema, async (at, _s, _signal, run, ctx) => {
      const { set } = await toolsAt(run, ctx, at);
      return json({
        tools: set.list().map(({ mastra: _, ...d }) => d),
        assets: set.assets,
        ...(set.instructions ? { instructions: set.instructions } : {}),
        sandbox: set.sandbox,
      } satisfies StepToolsAnswer);
    }),
    stepCall: call(
      stepToolCallSchema,
      async ({ name, input, effect, ...at }, _s, _signal, run, ctx) => {
        const { set } = await toolsAt(run, ctx, at);
        const before = set.assets.length;
        const { output } = await set.call({ name, input, effect });
        const assets = set.assets.slice(before);
        return json(assets.length ? { output, assets } : { output });
      },
    ),
    // The step and the agent's file are the run's: only the step's id comes.
    ofAgent: call(stepRequestSchema, async ({ stepId }, s, _signal, run, ctx) => {
      const step = agentStepOf(run, stepId);
      if (!step.agent) {
        throw new BadRequest(`No agent of the wizard runs step ${stepId}.`);
      }
      return json(await s.tools.ofAgent({ ...step, agent: step.agent }, ctx));
    }),
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

/** What a refused token says. */
const tokenRefused = (read: { refused: string } | null) =>
  read
    ? refused(`The run's token opens nothing (${read.refused}).`, 401)
    : refused("The run's token is missing.", 401);

/** The request's body, checked: its data, or the 400 that says what is wrong. */
async function checked<S extends z.ZodType>(
  c: Context,
  schema: S,
): Promise<{ data: z.infer<S> } | { refusal: Response }> {
  const raw = await c.req.json().catch(() => undefined);
  const parsed = schema.safeParse(raw ?? {});
  if (parsed.success) {
    return { data: parsed.data };
  }
  const issue = parsed.error.issues[0];
  return {
    refusal: refused(
      `The request is not valid: ${issue?.path.join(".") || "body"}: ${issue?.message ?? ""}`,
      400,
    ),
  };
}

export const runServiceRoutes = new Hono()
  .use(
    "*",
    bodyLimit({
      maxSize: RUN_SERVICES_BODY_LIMIT,
      onError: () => refused("The request is too large.", 413),
    }),
  )
  /*
   * A host's copy of its run (`run/report`), written to the record at the run's tenant
   * (`keepReport`). No service of `CALLS`: it builds no context and names no step. The end report
   * makes the run over, and a run that is over opens nothing with its token; that report is taken
   * since the record is not over yet when it comes. One that comes again (the answer to the first
   * was lost) is read with `over` (`readRunToken`): the token is checked as ever, and the answer
   * says the run is over and that nothing was kept.
   */
  .post("/run/report", async (c) => {
    const token = tokenOf(c);
    const read = token ? await readRunToken(token, { over: true }) : null;
    if (!(read && "claims" in read)) {
      if (!(await runServicesOn())) {
        return off(c);
      }
      return tokenRefused(read);
    }
    const { claims } = read;
    return withTenant(claims.tenant, async () => {
      if (!((await runServicesOn()) && (await runHostsOn()))) {
        return off(c);
      }
      const body = await checked(c, runReportSchema);
      if ("refusal" in body) {
        return body.refusal;
      }
      try {
        const kept = await keepReport(claims.run, body.data);
        if (kept === "no_run") {
          return tokenRefused({ refused: kept });
        }
        if (kept === "here") {
          return refused("This runtime works on the run itself: it takes no copy of it.", 409);
        }
        return json(kept satisfies RunReportAnswer);
      } catch (err) {
        const { failure, message, status } = failureOf(err);
        return failed(failure, message, status);
      }
    });
  })
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
      return tokenRefused(read && "refused" in read ? read : null);
    }
    const { claims } = read;
    const signal = c.req.raw.signal;
    return withTenant(claims.tenant, async () => {
      if (!(await runServicesOn())) {
        return off(c);
      }
      const parsed = await checked(c, handler.request);
      if ("refusal" in parsed) {
        return parsed.refusal;
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
          handler.answer(parsed.data, ctx.services, signal, run, ctx),
        );
      } catch (err) {
        const { failure, message, status } = failureOf(err);
        return failed(failure, message, status);
      }
    });
  });
