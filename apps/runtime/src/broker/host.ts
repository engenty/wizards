import type { AskInput } from "@engenty/wizards-shared/run";
import type { AskResult } from "../engine/asks.js";
import type { Where, Who } from "./call.js";
import {
  askAgain,
  type EffectCall,
  effectDone,
  effectIdOf,
  effectThrew,
  findEffect,
  startEffect,
} from "./effect.js";
import { hostInGrant, runGrant } from "./grant.js";
import { summarizeInput, writeLog } from "./log.js";
import { runOver } from "./over.js";
import { brokerOn } from "./rwx.js";

/*
 * A request to a host (docs/plans/capabilities.md, A6): `http_request` reaches outside like a
 * send through a connection, so it goes through here. The host is a resource of its own
 * (`host:<name>`), the kind is `send`. A guest's run reaches only the hosts its grant lists —
 * what the steps named in `hosts`; a member's run every public host, as before, until the
 * space's `broker` switch is on, then the same rule. A run that is over reaches no host at all
 * (over.ts), asked first. Every call is logged, a refusal as critical.
 *
 * A request that is no GET acts once, as an action of a connection does (effect.ts). `http_request`
 * only runs for a model, so that takes a durable turn. A GET counts as a read.
 */

export type HostResult<T> =
  | { ok: true; result: T }
  | { ok: false; refused: "not_in_grant" | "run_ended" | "may_have_happened"; reason: string };

const MAY_HAVE_HAPPENED = "It was interrupted before and may have arrived already.";

export async function brokerHost<T>(call: {
  who: Who;
  where: Where;
  url: URL;
  method: string;
  /** Which call this is (effect.ts); a person to ask where it may have happened already. */
  effect?: EffectCall;
  ask?: (ask: AskInput) => Promise<AskResult | null>;
  /** Gets the key a service may take against a repeat, where this request has one. */
  handler: (idempotencyKey?: string) => Promise<T>;
}): Promise<HostResult<T>> {
  const started = Date.now();
  const { who, where, url } = call;
  const host = url.hostname.toLowerCase();
  const line = (
    outcome: "allow" | "ask" | "deny",
    reason: string,
    result: string,
    rule = "grant",
  ) =>
    writeLog({
      at: new Date(started),
      durationMs: Date.now() - started,
      whoKind: who.kind,
      whoId: who.id ?? null,
      runId: where.runId ?? null,
      stepId: where.stepId ?? null,
      client: where.client ?? null,
      chatId: where.chatId ?? null,
      wizardId: where.wizardId ?? null,
      spaceId: where.spaceId ?? null,
      connectionId: `host:${host}`,
      actionId: "http_request",
      kind: "send",
      // The path without its query: a query may carry a key.
      inputSummary: summarizeInput({ method: call.method, host, path: url.pathname }),
      outcome,
      rule,
      reason,
      result,
      resultSize: null,
    });

  const over = await runOver(where);
  if (over) {
    await line("deny", over.reason, "run_ended", over.rule);
    return { ok: false, refused: "run_ended", reason: over.reason };
  }
  const bound = where.guest || (await brokerOn());
  let reason = "Members reach every public host.";
  if (bound) {
    const grant = where.runId ? await runGrant(where.runId) : null;
    if (!grant || !hostInGrant(grant, host)) {
      const why = grant
        ? `The run's grant does not include the host ${host}.`
        : "The run is not known here.";
      await line("deny", why, "not_in_grant");
      return { ok: false, refused: "not_in_grant", reason: why };
    }
    reason = "The host is in the run's grant.";
  }
  const effectId = call.method === "GET" ? null : await effectIdOf(where, call.effect);
  if (effectId) {
    const effect = await findEffect(effectId);
    if (effect?.state === "done") {
      await line("allow", "It happened before.", "already_done", "once");
      return { ok: true, result: effect.output as T };
    }
    const again =
      effect?.state === "started"
        ? await askAgain(call.ask, {
            service: host,
            actionId: "http_request",
            summary: `${call.method} ${host}${url.pathname}`,
            destructive: call.method === "DELETE",
            input: JSON.stringify({ method: call.method, host, path: url.pathname }, null, 2),
          })
        : null;
    const taken =
      again === "again" ||
      (!again &&
        (await startEffect({
          id: effectId,
          runId: where.runId as string,
          stepId: where.stepId as string,
          tool: `host:${host}`,
        })));
    if (!taken) {
      await (again === "not_again"
        ? line("ask", MAY_HAVE_HAPPENED, "declined", "once")
        : line("deny", MAY_HAVE_HAPPENED, "may_have_happened", "once"));
      return { ok: false, refused: "may_have_happened", reason: MAY_HAVE_HAPPENED };
    }
  }
  try {
    const result = await call.handler(effectId ?? undefined);
    if (effectId) {
      await effectDone(effectId, result);
    }
    await line("allow", reason, "ok");
    return { ok: true, result };
  } catch (err) {
    if (effectId) {
      await effectThrew(effectId, err);
    }
    await line("allow", reason, err instanceof Error ? err.constructor.name || "Error" : "Error");
    throw err;
  }
}
