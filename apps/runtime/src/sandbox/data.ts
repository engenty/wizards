import { AsyncResource } from "node:async_hooks";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { stepCaller } from "../elements/caller.js";
import type { StepContext } from "../engine/types.js";
import { env } from "../env.js";
import { ServiceError } from "../services/errors.js";
import type { DataResult } from "../store/data.js";
import { type DataCall, runData } from "../store/data-access.js";
import { StoreError } from "../store/errors.js";

/**
 * The wizard's database from inside the sandbox (docs/plans/wizard-data.md, step 5): a sandbox
 * tool, a skill's script or a command the model runs posts a statement to the runtime, never
 * opens a database file. Every statement goes through `runData` (store/data-access.ts) as the
 * model's: broker `r`/`w`, one line of the log, the limits, and the guest rule.
 *
 * A run whose wizard keeps data gets a token when a step opens its tools; each command in its
 * sandbox has it in its environment beside the address:
 *
 *   POST $WIZARD_DATA_URL/query   { sql, params?, scope? }  → { columns, rows, truncated }
 *   POST $WIZARD_DATA_URL/exec    { sql, params?, scope? }  → { changes, lastId }
 *   Authorization: Bearer $WIZARD_DATA_TOKEN
 *
 * The token lives in the runner that holds the run, until the run stops running. A process that
 * doesn't hold the run hands the request on to the one that does (engine/owner.ts).
 */

/** The runtime's address as a sandbox reaches it: `SANDBOX_DATA_URL`, else `PUBLIC_URL` on HTTPS. */
export function sandboxDataBase(): string | null {
  if (env.sandboxDataUrl) {
    return env.sandboxDataUrl;
  }
  try {
    return new URL(env.publicUrl).protocol === "https:" ? env.publicUrl : null;
  } catch {
    return null;
  }
}

/** The host a run's sandbox reaches for its data, beside its grant's; null when there is none. */
export function sandboxDataHost(): string | null {
  const base = sandboxDataBase();
  return base ? new URL(base).hostname : null;
}

interface Door {
  token: string;
  /** The statement, run as the step that opened the door, in its tenant. */
  run: (call: DataCall) => Promise<DataResult>;
}

/** The runs that may reach their wizard's database from the sandbox, by run. */
const doors = new Map<string, Door>();

/**
 * Opens the run's door for the step that builds its tools: the step's caller from now on. A
 * wizard without data, or a runtime the sandbox can't reach, opens none.
 */
export function openSandboxData(ctx: StepContext): void {
  if (!ctx.def.data || !sandboxDataBase()) {
    return;
  }
  const caller = stepCaller(ctx);
  const target = { def: ctx.def, files: ctx.files, store: ctx.store };
  doors.set(ctx.runId, {
    token: doors.get(ctx.runId)?.token ?? randomBytes(24).toString("base64url"),
    run: AsyncResource.bind((call: DataCall) => runData(caller, target, call)),
  });
}

/** What a command in the run's sandbox finds in its environment; empty when the door is shut. */
export function sandboxDataEnv(runId: string): Record<string, string> {
  const door = doors.get(runId);
  const base = sandboxDataBase();
  if (!door || !base) {
    return {};
  }
  return {
    WIZARD_DATA_URL: `${base}/api/sandbox/data/${encodeURIComponent(runId)}`,
    WIZARD_DATA_TOKEN: door.token,
  };
}

/** Shuts the run's door: it stopped running. */
export function closeSandboxData(runId: string): void {
  doors.delete(runId);
}

/** Whether this process holds the run's door. */
export const holdsSandboxData = (runId: string) => doors.has(runId);

const digest = (value: string) => createHash("sha256").update(value).digest();

const body = z.object({
  sql: z.string().min(1).max(20_000),
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  scope: z.enum(["person", "shared"]).default("person"),
});

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * Answers a statement from the run's sandbox, where this process holds the run; null where it
 * doesn't. `action` is `query` (a read) or `exec` (a write).
 */
export async function sandboxDataRequest(
  runId: string,
  action: string,
  request: Request,
): Promise<Response | null> {
  const door = doors.get(runId);
  if (!door) {
    return null;
  }
  const header = request.headers.get("authorization") ?? "";
  if (
    !(header.startsWith("Bearer ") && timingSafeEqual(digest(header.slice(7)), digest(door.token)))
  ) {
    return json({ error: "The token doesn't fit this run." }, 401);
  }
  if (action !== "query" && action !== "exec") {
    return json({ error: "POST to /query to read, to /exec to write." }, 404);
  }
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return json(
      { error: `${issue?.path.join(".") || "The body"}: ${issue?.message ?? "invalid"}` },
      400,
    );
  }
  const { sql, params, scope } = parsed.data;
  try {
    const result = await door.run({
      action: `sandbox:db.${action}`,
      by: "model",
      scope,
      sql,
      params,
      mode: action === "query" ? "read" : "write",
    });
    return json(
      action === "query"
        ? { columns: result.columns, rows: result.rows, truncated: result.truncated }
        : { changes: result.changes, lastId: result.lastId },
    );
  } catch (err) {
    const message = String((err as Error)?.message ?? err).slice(0, 400);
    const status =
      err instanceof ServiceError && err.code === "forbidden"
        ? 403
        : err instanceof StoreError
          ? 400
          : 500;
    return json({ error: message }, status);
  }
}
