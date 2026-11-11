/**
 * A run's host, reached from another process (docs/plans/runs-on-their-own.md, "Doors"): three
 * calls under `<url>/api/peer/runs/<run>/`, served by the runtime that holds the run
 * (apps/runtime/src/routes/peer.ts).
 *
 * - `GET state`: where the run stands, `{ run: { cursor, status, state, wakeAt, rev }, event }`.
 *   `event` is the newest line of the run's log at that read, so a stream can start right after it.
 * - `GET changes?since=<rev>&after=<event>`: NDJSON, held open. Each line is a change
 *   `{ rev, events }`: the run's revision now and the lines of its log written since the last
 *   change. The first line comes at once when the run is past `since` or has lines past `after`;
 *   without `after` the stream starts at the log's newest line. A blank line every few seconds
 *   keeps the connection open and says nothing.
 * - `POST events`: `{ event, by? }`, a `FlowEvent` and who sent it as the door established it. The
 *   host takes it the way its doors do and answers `{ rev }`, the run's revision after the write.
 *
 * Every call carries a peer ticket for the run and its tenant as `Authorization: Bearer` and the
 * tenant in `x-wizards-tenant`; the ticket signs both. A ticket is checked when a call opens, so a
 * stream outlives it.
 *
 * Only `fetch` and `TextDecoder`: no Node built-in, so the engine bundles for any host.
 */
import {
  RUN_EVENT_TYPES,
  type RunEvent,
  type RunNote,
  type RunState,
  type RunStatus,
  type StepOutput,
} from "@engenty/wizards-shared/run";
import { flowFailureSchema } from "@engenty/wizards-shared/run-services";
import type { FlowEvent, FlowRun } from "@engenty/wizards-shared/transition";
import { z } from "zod";

/** Where a runtime serves its runs' hosts: `<url><PEER_RUNS_PATH>/<run>/<call>`. */
export const PEER_RUNS_PATH = "/api/peer/runs";
/** The tenant the peer ticket was signed for. */
export const TENANT_HEADER = "x-wizards-tenant";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const RUN_STATUSES = [
  "waiting_input",
  "sleeping",
  "waiting_signal",
  "running",
  "done",
  "failed",
  "cancelled",
] as const satisfies readonly RunStatus[];

/** Shapes the host writes itself and the flow reads as they are: checked as objects, not field by field. */
const runStateSchema = z.custom<RunState>(isRecord, "A run's state is an object.");
const stepOutputSchema = z.custom<StepOutput>(isRecord, "A step's output is an object.");
const runNoteSchema = z.custom<RunNote>(isRecord, "A note is an object.");

/** The run as its host keeps it, with the revision a write holds on. */
export const hostRunSchema = z.object({
  cursor: z.string().nullable(),
  status: z.enum(RUN_STATUSES),
  state: runStateSchema,
  /** When the clock wakes the run, in ms; null: nothing due. */
  wakeAt: z.number().nullable(),
  rev: z.number().int(),
});
export type HostRun = FlowRun & { rev: number };

/** `GET state`. */
export const hostStateSchema = z.object({
  run: hostRunSchema,
  /** The newest line of the run's log at this read; 0 when it has none. */
  event: z.number().int().nonnegative(),
});
export interface HostState {
  run: HostRun;
  event: number;
}

export const runEventSchema: z.ZodType<RunEvent> = z.object({
  id: z.number().int(),
  at: z.string(),
  stepId: z.string().nullable(),
  type: z.enum(RUN_EVENT_TYPES),
  message: z.string(),
  note: runNoteSchema.nullable().optional(),
  asset: z.string().nullable().optional(),
});

/** One line of `GET changes`. */
export const hostChangeSchema = z.object({
  rev: z.number().int(),
  events: z.array(runEventSchema),
});
export interface HostChange {
  rev: number;
  events: RunEvent[];
}

const stepId = z.string().min(1).max(200);
const values = z.record(z.string(), z.unknown());

/** Every `FlowEvent` (packages/shared/src/transition.ts); which ones a host takes from outside is the host's. */
export const flowEventSchema: z.ZodType<FlowEvent> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("start") }),
  z.object({ kind: z.literal("stepDone"), stepId, output: stepOutputSchema }),
  z.object({
    kind: z.literal("stepFailed"),
    stepId,
    failure: flowFailureSchema,
    acted: z.boolean().optional(),
  }),
  z.object({ kind: z.literal("decided"), stepId, rule: z.number().int().nullable() }),
  z.object({ kind: z.literal("answered"), stepId, values }),
  z.object({
    kind: z.literal("reviewed"),
    stepId,
    approved: z.boolean(),
    note: z.string().max(2000).optional(),
    edited: z.record(z.string(), stepOutputSchema).optional(),
  }),
  z.object({
    kind: z.literal("regenerate"),
    stepId,
    target: z.string().min(1).max(200),
    note: z.string().max(2000),
    items: z.array(z.number().int().nonnegative()).optional(),
  }),
  z.object({ kind: z.literal("back") }),
  z.object({ kind: z.literal("signal"), stepId, id: z.string(), data: values.nullable() }),
  z.object({ kind: z.literal("woke") }),
  z.object({ kind: z.literal("resume") }),
  z.object({ kind: z.literal("cancel") }),
]);

/** Who sent an event, as the door that took it established. `name`: what the log says, for "Continue now". */
export const hostActorSchema = z.object({
  userId: z.string().max(200).nullable().optional(),
  visitorId: z.string().max(200).nullable().optional(),
  name: z.string().max(200).optional(),
});
export type HostActor = z.infer<typeof hostActorSchema>;

/** `POST events`. */
export const hostEventSchema = z.object({ event: flowEventSchema, by: hostActorSchema.optional() });
export interface HostEvent {
  event: FlowEvent;
  by?: HostActor;
}

/** What `POST events` answers. */
export const hostSentSchema = z.object({ rev: z.number().int() });

/** A refusal: `{ error, fields? }` as the host answered it, with its status. */
export class HostApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The page's fields that were not accepted, as the host wrote them (status 422). */
    readonly fields?: unknown,
  ) {
    super(message);
    this.name = "HostApiError";
  }
}

export interface HostApiOptions {
  /** The runtime that holds the run: its origin, `https://wizards.example`. */
  url: string;
  runId: string;
  tenant: string;
  /** A peer ticket for the run and the tenant, or how to get a fresh one for each call. */
  ticket: string | (() => string | Promise<string>);
  /** Left out: `globalThis.fetch`. */
  fetch?: typeof fetch;
}

export interface HostApi {
  state(signal?: AbortSignal): Promise<HostState>;
  /**
   * The run's changes past revision `since`, as they come, until `signal` aborts or the host
   * closes. `after`: the newest line of the log already read (`HostState.event`); without it the
   * stream starts at the log's newest line.
   */
  changes(since: number, signal?: AbortSignal, after?: number): AsyncIterable<HostChange>;
  send(event: FlowEvent, by?: HostActor): Promise<{ rev: number }>;
}

export function hostApi(options: HostApiOptions): HostApi {
  const base = `${options.url.replace(/\/+$/, "")}${PEER_RUNS_PATH}/${encodeURIComponent(options.runId)}`;
  const fetchOf = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  async function call(
    path: string,
    init: { method: "GET" | "POST"; body?: unknown },
    signal?: AbortSignal,
  ): Promise<Response> {
    const ticket = typeof options.ticket === "string" ? options.ticket : await options.ticket();
    let res: Response;
    try {
      res = await fetchOf(`${base}/${path}`, {
        method: init.method,
        headers: {
          authorization: `Bearer ${ticket}`,
          [TENANT_HEADER]: options.tenant,
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal,
      });
    } catch (err) {
      if (signal?.aborted) {
        throw signal.reason;
      }
      throw new HostApiError(0, `The run's host did not answer: ${messageOf(err)}`);
    }
    if (!res.ok) {
      throw await refusalOf(res);
    }
    return res;
  }

  return {
    async state(signal) {
      const res = await call("state", { method: "GET" }, signal);
      return hostStateSchema.parse(await res.json()) as HostState;
    },

    async *changes(since, signal, after) {
      const query = new URLSearchParams({ since: String(since) });
      if (after !== undefined) {
        query.set("after", String(after));
      }
      let res: Response;
      try {
        res = await call(`changes?${query}`, { method: "GET" }, signal);
      } catch (err) {
        if (signal?.aborted) {
          return;
        }
        throw err;
      }
      const reader = res.body?.getReader();
      if (!reader) {
        return;
      }
      const stop = () => void reader.cancel().catch(() => undefined);
      signal?.addEventListener("abort", stop, { once: true });
      const decoder = new TextDecoder();
      let buffered = "";
      try {
        while (true) {
          let chunk: ReadableStreamReadResult<Uint8Array>;
          try {
            chunk = await reader.read();
          } catch (err) {
            if (signal?.aborted) {
              return;
            }
            throw new HostApiError(0, `The run's changes broke off: ${messageOf(err)}`);
          }
          if (chunk.done) {
            return;
          }
          buffered += decoder.decode(chunk.value, { stream: true });
          let end = buffered.indexOf("\n");
          while (end >= 0) {
            const line = buffered.slice(0, end).trim();
            buffered = buffered.slice(end + 1);
            // A blank line only keeps the connection open.
            if (line) {
              yield hostChangeSchema.parse(JSON.parse(line)) as HostChange;
            }
            end = buffered.indexOf("\n");
          }
        }
      } finally {
        signal?.removeEventListener("abort", stop);
        stop();
      }
    },

    async send(event, by) {
      const res = await call("events", { method: "POST", body: { event, ...(by ? { by } : {}) } });
      return hostSentSchema.parse(await res.json());
    },
  };
}

async function refusalOf(res: Response): Promise<HostApiError> {
  const text = await res.text().catch(() => "");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  const error = isRecord(body) && typeof body.error === "string" ? body.error : null;
  return new HostApiError(
    res.status,
    error ?? `The run's host refused (${res.status}).`,
    isRecord(body) ? body.fields : undefined,
  );
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
