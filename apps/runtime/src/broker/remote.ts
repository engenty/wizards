import type { BrokerRefusal } from "@engenty/wizards-shared/connectors";
import type { AskInput } from "@engenty/wizards-shared/run";
import type { ConnectionDef } from "@engenty/wizards-shared/store";
import type { ConnectorDefinition } from "../engenty/connections-sdk/types.js";
import type { AskResult } from "../engine/asks.js";
import { env } from "../env.js";
import { type BrokerPurpose, brokerTicket } from "../secrets/signing.js";
import type { StoreScope } from "../store/index.js";
import type {
  BrokerAction,
  BrokerCallInput,
  BrokerConnection,
  BrokerResult,
  Where,
  Who,
} from "./call.js";
import type { EffectCall } from "./effect.js";

/*
 * The broker as a process of its own (docs/plans/kernel.md, item 24). A runner of one tenant
 * (`RUNNER_TENANT`) runs that tenant's step code as ordinary code, so it holds no key to an
 * account: every connector call it makes goes over the peer routes to the process in the role
 * `broker`, which reads the account, decides, runs the action and logs it there
 * (`routes/broker-peer.ts`). The runner sends who calls, where, which connection by its id and
 * the input; it gets back the result or the refusal, never a secret. Where the rules ask a
 * person, the broker answers with the question, the runner asks it as it would have, and sends
 * the call again with the answer. A shared runner and a runtime that runs alone call in their
 * own process.
 *
 * The ticket the runner signs is good for its tenant alone (`brokerKeyOf`): the broker opens
 * no other tenant's database for it.
 */

/** Whether this process's connector calls go to the broker's own process. */
export function brokerRemote(): boolean {
  return Boolean(env.runner.tenant) && !env.serves.broker;
}

/** A connection as the call names it: the broker reads its row and its connector itself. */
export type ConnectionRef =
  | { kind: "store_secret"; def: ConnectionDef; scope: StoreScope; spaceId: string }
  | {
      kind: "space_connection";
      id: string;
      spaceId: string;
      need?: ConnectionDef;
      chosenForUnwatched?: true;
    };

export interface RemoteCall {
  who: Who;
  where: Where;
  connection: ConnectionRef;
  action: BrokerAction;
  input: unknown;
  ctx: {
    allowed: string[];
    confirmed?: boolean;
    effect?: EffectCall;
    /** Whether the runner can ask anyone; not: an ask is refused as nobody's. */
    canAsk: boolean;
    /** The call again, with the answer to the question the broker sent. */
    answered?: boolean;
    answer?: AskResult | null;
  };
}

type Done =
  | { ok: true; result: unknown; account: { connectorId: string; label: string } }
  | { ok: false; refused: BrokerRefusal; reason: string };

export type RemoteAnswer =
  | { done: Done; allowed: string[] }
  | { ask: AskInput }
  | { threw: string };

export function refOf(connection: BrokerConnection): ConnectionRef {
  if (connection.kind === "store_secret") {
    return connection;
  }
  return {
    kind: "space_connection",
    id: connection.row.id,
    spaceId: connection.row.spaceId,
    ...(connection.need ? { need: connection.need } : {}),
    ...(connection.chosenForUnwatched ? { chosenForUnwatched: true as const } : {}),
  };
}

/** The longest a connector's action may take behind the broker. */
const CALL_MS = 5 * 60_000;

/** The tenant a runner of one tenant works for: its own, whatever else is asked. */
function ownTenant(): string {
  return env.runner.tenant;
}

async function post(path: string, purpose: BrokerPurpose, payload: unknown): Promise<unknown> {
  if (!(env.broker.url && env.broker.key)) {
    throw new Error(
      "This runner serves one tenant and holds no keys to accounts, and no broker is set (BROKER_URL, BROKER_KEY).",
    );
  }
  const tenant = ownTenant();
  const body = JSON.stringify(payload);
  const res = await fetch(`${env.broker.url}/api/peer/broker/${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${brokerTicket(purpose, tenant, body)}`,
      "content-type": "application/json",
      "x-wizards-tenant": tenant,
    },
    body,
    signal: AbortSignal.timeout(CALL_MS),
  });
  if (!res.ok) {
    throw new Error(`The broker answered ${res.status}.`);
  }
  return res.json();
}

/** The connector a connection is of, as this runner knows it: for the result's account. */
async function connectorOf(
  connection: BrokerConnection,
  id: string,
  spaceId: string,
): Promise<ConnectorDefinition> {
  if (connection.kind === "space_connection" && connection.connector.id === id) {
    return connection.connector;
  }
  const { resolveConnector } = await import("../connectors/external.js");
  const found = await resolveConnector(spaceId, id);
  if (!found) {
    throw new Error(`The connector "${id}" is not known here.`);
  }
  return found.connector;
}

function spaceOf(connection: BrokerConnection): string {
  return connection.kind === "store_secret" ? connection.spaceId : connection.row.spaceId;
}

/**
 * `brokerCall` from a runner of one tenant: the call goes to the broker's process. `prepare`
 * runs before it is sent, `started` and `after` once the action ran. A call that brings its own
 * `handler` needs the account in this process and is refused.
 */
export async function remoteBrokerCall<T>(call: BrokerCallInput<T>): Promise<BrokerResult<T>> {
  if (call.handler) {
    return {
      ok: false,
      refused: "denied",
      reason: "This call needs the account, and this runner holds none: only the broker does.",
    };
  }
  const ctx = call.ctx ?? {};
  const input = call.prepare ? await call.prepare(call.input ?? {}) : (call.input ?? {});
  const wire: RemoteCall = {
    who: call.who,
    where: call.where,
    connection: refOf(call.connection),
    action: call.action,
    input,
    ctx: {
      allowed: [...(ctx.allowed ?? [])],
      ...(ctx.confirmed ? { confirmed: true } : {}),
      ...(ctx.effect ? { effect: ctx.effect } : {}),
      canAsk: Boolean(ctx.ask),
    },
  };
  let answered: { answer: AskResult | null } | null = null;
  for (;;) {
    const out = (await post(
      "call",
      "call",
      answered ? { ...wire, ctx: { ...wire.ctx, answered: true, answer: answered.answer } } : wire,
    )) as RemoteAnswer;
    if ("ask" in out) {
      if (answered || !ctx.ask) {
        throw new Error("The broker asked again for a call that was answered.");
      }
      // Asked here, as in the runner's own process: a step without the person throws its own.
      answered = { answer: await ctx.ask(out.ask) };
      continue;
    }
    if ("threw" in out) {
      throw new Error(out.threw);
    }
    for (const key of out.allowed) {
      ctx.allowed?.add(key);
    }
    if (!out.done.ok) {
      return out.done;
    }
    await call.started?.();
    const result = call.after ? await call.after(out.done.result) : (out.done.result as T);
    const connector = await connectorOf(
      call.connection,
      out.done.account.connectorId,
      spaceOf(call.connection),
    );
    return { ok: true, result, account: { connector, label: out.done.account.label } };
  }
}

/** `brokerConnected` from a runner of one tenant: whether and as whom, from the broker. */
export async function remoteConnected(
  connection: BrokerConnection,
  who: Who,
): Promise<{ connector: ConnectorDefinition; label: string } | null> {
  const out = (await post("connected", "connected", { who, connection: refOf(connection) })) as {
    connected: { connectorId: string; label: string } | null;
  };
  if (!out.connected) {
    return null;
  }
  return {
    connector: await connectorOf(connection, out.connected.connectorId, spaceOf(connection)),
    label: out.connected.label,
  };
}

/**
 * The model gateway as a runner of one tenant reaches it: through the broker, which adds the
 * runtime's key and books on this tenant (`routes/broker-peer.ts`).
 */
export function gatewayViaBroker(): { baseUrl: string; token: string; tenant: string } {
  if (!(env.broker.url && env.broker.key)) {
    throw new Error(
      "This runner serves one tenant and holds no key to the model gateway, and no broker is set (BROKER_URL, BROKER_KEY).",
    );
  }
  const tenant = ownTenant();
  return {
    baseUrl: `${env.broker.url}/api/peer/gateway`,
    token: brokerTicket("gateway", tenant, null),
    tenant,
  };
}

// --- the broker's side --------------------------------------------------------------------

/** The connection a call names, read in the broker's process; null where the space has none. */
async function connectionOf(ref: ConnectionRef): Promise<BrokerConnection | null> {
  if (ref.kind === "store_secret") {
    return ref;
  }
  const { spaceConnectionOf } = await import("../connectors/space-connections.js");
  const { resolveConnector } = await import("../connectors/external.js");
  const row = await spaceConnectionOf(ref.spaceId, ref.id);
  const resolved = row ? await resolveConnector(ref.spaceId, row.connectorId) : null;
  if (!(row && resolved)) {
    return null;
  }
  return {
    kind: "space_connection",
    row,
    connector: resolved.connector,
    ...(ref.need ? { need: ref.need } : {}),
    ...(ref.chosenForUnwatched ? { chosenForUnwatched: true as const } : {}),
  };
}

/** Thrown inside the call where it would ask: the question goes back to the runner. */
class Asked extends Error {
  constructor(readonly ask: AskInput) {
    super("asked");
  }
}

/** A runner's call, made here, in the tenant it signed for. */
export async function answerCall(call: RemoteCall): Promise<RemoteAnswer> {
  const { brokerCallHere } = await import("./call.js");
  const connection = await connectionOf(call.connection);
  if (!connection) {
    return {
      done: { ok: false, refused: "not_connected", reason: "The connection was removed." },
      allowed: call.ctx.allowed,
    };
  }
  const allowed = new Set(call.ctx.allowed);
  const ask = call.ctx.canAsk
    ? async (asked: AskInput) => {
        if (call.ctx.answered) {
          return call.ctx.answer ?? null;
        }
        throw new Asked(asked);
      }
    : undefined;
  try {
    const out = await brokerCallHere({
      who: call.who,
      where: call.where,
      connection,
      action: call.action,
      input: call.input,
      ctx: {
        ...(ask ? { ask } : {}),
        allowed,
        ...(call.ctx.confirmed ? { confirmed: true } : {}),
        ...(call.ctx.effect ? { effect: call.ctx.effect } : {}),
      },
    });
    return {
      done: out.ok
        ? {
            ok: true,
            result: out.result,
            account: { connectorId: out.account.connector.id, label: out.account.label },
          }
        : out,
      allowed: [...allowed],
    };
  } catch (err) {
    if (err instanceof Asked) {
      return { ask: err.ask };
    }
    return { threw: (err instanceof Error ? err.message : String(err)).slice(0, 500) };
  }
}

/** Whether a connection holds an account for `who`, read here. */
export async function answerConnected(payload: {
  who: Who;
  connection: ConnectionRef;
}): Promise<{ connected: { connectorId: string; label: string } | null }> {
  const { brokerConnectedHere } = await import("./call.js");
  const connection = await connectionOf(payload.connection);
  const found = connection ? await brokerConnectedHere(connection, payload.who) : null;
  return {
    connected: found ? { connectorId: found.connector.id, label: found.label } : null,
  };
}
