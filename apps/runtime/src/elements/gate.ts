import { summarizeInput, writeLog } from "../broker/log.js";
import { decide, ENFORCED, forbidden, type Perm, type Resource } from "../broker/rwx.js";
import { attempt } from "../tools/shared.js";
import type { ElementCaller } from "./caller.js";

/**
 * The broker's gate for an element call (docs/plans/modular.md, rule 3): the space's rules decide
 * it, and it is one line of the broker's log, allowed or not (I6). Knowledge has no resource of
 * its own: each page, table and document is decided where it is read (A0), so its calls are only
 * logged here.
 */

/** What a call is about: the element's resource and the permission it needs. */
export interface ElementCall {
  /** The tool, as the log's action names it. */
  action: string;
  /** Left out: the reader decides each item it hands out (Knowledge). */
  resource?: Resource;
  /**
   * The space whose rules decide the resource, where it is not the caller's: a client space's
   * parent for the wizards it runs (docs/plans/client-portal.md).
   */
  rulesIn?: string;
  /** What the log files a call without one resource under: `knowledge` when left out, `skills`, `wizards`, `sandbox`. */
  about?: string;
  perm: Perm;
  input: unknown;
}

const KIND: Record<Perm, string> = { r: "read", w: "write", x: "run" };

/** The log's name for what was called: `knowledge`, `skill:<name>`, `wizard:<id>`, `setup`. */
const subjectOf = (call: ElementCall) =>
  call.resource ? `${call.resource.kind}:${call.resource.id}` : (call.about ?? "knowledge");

const sizeOf = (result: unknown) => {
  try {
    return JSON.stringify(result ?? null).length;
  } catch {
    return null;
  }
};

async function logCall(
  caller: ElementCaller,
  call: ElementCall,
  outcome: "allow" | "deny",
  result: string,
  started: number,
  extra: { rule?: string | null; reason?: string; resultSize?: number | null } = {},
): Promise<void> {
  await writeLog({
    at: new Date(started),
    durationMs: Date.now() - started,
    whoKind: caller.who.kind,
    whoId: caller.who.id ?? null,
    runId: caller.where.runId ?? null,
    stepId: caller.where.stepId ?? null,
    chatId: caller.where.chatId ?? null,
    wizardId: caller.where.wizardId ?? null,
    spaceId: caller.space.id,
    client: caller.client ?? null,
    connectionId: subjectOf(call),
    actionId: call.action,
    kind: KIND[call.perm],
    inputSummary: summarizeInput(call.input),
    outcome,
    rule: extra.rule ?? null,
    reason: extra.reason ?? null,
    result,
    resultSize: extra.resultSize ?? null,
  });
}

/** Whether the caller may do `perm` on the resource, without running anything or logging. */
export async function mayDo(
  caller: ElementCaller,
  resource: Resource,
  perm: Perm,
): Promise<boolean> {
  return (await decide(caller.space.id, caller.subjects, resource, perm)).ok;
}

/**
 * Runs `run` once the rules allow the call, and logs it either way. A refusal throws the
 * broker's 403 (`forbidden`), which a tool hands the model as its error.
 */
export async function elementCall<T>(
  caller: ElementCaller,
  call: ElementCall,
  run: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  if (call.resource && ENFORCED.includes(call.resource.kind)) {
    const decision = await decide(
      call.rulesIn ?? caller.space.id,
      caller.subjects,
      call.resource,
      call.perm,
    );
    if (!decision.ok) {
      await logCall(caller, call, "deny", "forbidden", started, {
        rule: decision.rule,
        reason: decision.reason,
      });
      throw forbidden(decision.of, call.perm);
    }
  }
  try {
    const result = await run();
    await logCall(caller, call, "allow", "ok", started, { resultSize: sizeOf(result) });
    return result;
  } catch (err) {
    const name = (err as { code?: string })?.code ?? (err as Error)?.name ?? "error";
    await logCall(caller, call, "allow", String(name).slice(0, 40), started);
    throw err;
  }
}

/**
 * A tool whose every call goes through the gate: `callOf` says, from the model's input, what the
 * call is about. A refusal comes back to the model as the tool's error.
 */
export function brokered<T extends object>(
  tool: T,
  caller: ElementCaller,
  callOf: (input: unknown) => ElementCall,
): T {
  const execute = (tool as { execute?: (input: unknown, ...rest: unknown[]) => unknown }).execute;
  if (!execute) {
    return tool;
  }
  return Object.assign(Object.create(Object.getPrototypeOf(tool)), tool, {
    execute: (input: unknown, ...rest: unknown[]) =>
      attempt(() =>
        elementCall(caller, callOf(input), async () => execute.call(tool, input, ...rest)),
      ),
  });
}
