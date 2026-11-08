import type { Where, Who } from "./call.js";
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
 * A run's sandbox goes through here as well: each connection it opens is one call (method
 * `CONNECT`), and the package registries are reached whatever the grant says.
 */

export type HostResult<T> =
  | { ok: true; result: T }
  | { ok: false; refused: "not_in_grant" | "run_ended"; reason: string };

export async function brokerHost<T>(call: {
  who: Who;
  where: Where;
  url: URL;
  method: string;
  handler: () => Promise<T>;
  /** Hosts reached whatever the grant says: the package registries, for a sandbox. */
  alwaysAllowed?: readonly string[];
}): Promise<HostResult<T>> {
  const started = Date.now();
  const { who, where, url } = call;
  const host = url.hostname.toLowerCase();
  const line = (outcome: "allow" | "deny", reason: string, result: string, rule = "grant") =>
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
  if (call.alwaysAllowed?.includes(host)) {
    reason = "The host is a package registry.";
  } else if (bound) {
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
  try {
    const result = await call.handler();
    await line("allow", reason, "ok");
    return { ok: true, result };
  } catch (err) {
    await line("allow", reason, err instanceof Error ? err.constructor.name || "Error" : "Error");
    throw err;
  }
}

/**
 * What a run's sandbox may reach besides the package registries: the hosts of its grant, and
 * whether it reaches every public host instead (a member's run while the `broker` switch is
 * off), by the same rule as `brokerHost`.
 */
export async function runHosts(
  where: Where,
): Promise<{ hosts: string[]; everyPublicHost: boolean }> {
  const grant = where.runId ? await runGrant(where.runId) : null;
  const bound = where.guest || (await brokerOn());
  return { hosts: grant?.hosts ?? [], everyPublicHost: !bound };
}
