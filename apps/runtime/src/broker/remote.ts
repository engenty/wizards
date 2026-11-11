import type { AskResult } from "@engenty/wizards-engine/types";
import type { AskInput } from "@engenty/wizards-shared/run";
import type { ConnectionDef } from "@engenty/wizards-shared/store";
import { eq } from "drizzle-orm";
import { connectorOfRow } from "../connectors/space-connections.js";
import { db, schema } from "../db/client.js";
import type { ConnectorDefinition } from "../engenty/connections-sdk/types.js";
import { env } from "../env.js";
import { brokerTicket } from "../secrets/signing.js";
import type { StoreScope } from "../store/index.js";
import { currentTenant } from "../tenants/tenant.js";
import {
  type BrokerAction,
  type BrokerCallInput,
  type BrokerConnection,
  type BrokerResult,
  brokerCall,
  brokerConnected,
  type Where,
  type Who,
} from "./call.js";
import type { EffectCall } from "./effect.js";
import type { NamedCall } from "./named.js";

/*
 * A connection call from a process that opens no connected account (docs/plans/runs-on-their-own.md,
 * 7.5): `brokerCall` there sends it to the broker at `BROKER_URL`, which makes it as it would its
 * own and answers what came of it. The call travels as data: who, where, which connection, the
 * action and its input, what the caller already allowed. A call that brings code to run with the
 * account (`handler`, `quietWhen`) can't travel and is refused.
 *
 * When the call has to ask the person, the broker answers the question instead of a result; the
 * caller asks in its own process (a card in Goose's chat, the run's page for a share) and sends
 * the call again with the answer. The broker asks before it acts or writes the call's line, so
 * the first round left nothing behind.
 */

export const BROKER_CALL_PATH = "/api/broker/v1/call";

/** Which connection, as the broker finds it again: a connection of the space by its id. */
export type RemoteConnection =
  | { kind: "space_connection"; id: string; actions?: string[] }
  | { kind: "store_secret"; def: ConnectionDef; scope: StoreScope; spaceId: string };

export interface RemoteCall {
  who: Who;
  where: Where;
  connection: RemoteConnection;
  action: BrokerAction;
  input: unknown;
  named?: NamedCall;
  /** Only whether an account is there, and whose (`brokerConnected`). */
  connected?: boolean;
  ctx: {
    /** Whether the caller can ask the person; no: the broker refuses what would ask. */
    canAsk: boolean;
    /** The person's answers so far, to the questions in the order the broker asked them. */
    answers?: (AskResult | null)[];
    allowed?: string[];
    confirmed?: boolean;
    approved?: boolean;
    effect?: EffectCall;
  };
}

export type RemoteAnswer =
  | {
      ok: true;
      result: unknown;
      account: { connector: string; name: string; label: string };
      allowed: string[];
    }
  | { ok: false; refused: string; reason: string; allowed: string[] }
  | { ask: AskInput }
  | { thrown: { message: string; name?: string; status?: number } }
  | { connected: { connector: string; name: string; label: string } | null };

/** Thrown by the broker's stand-in for `ask` when the person's answer isn't there yet. */
class AskFirst extends Error {
  constructor(readonly ask: AskInput) {
    super("The person is asked first.");
  }
}

function remoteConnectionOf(connection: BrokerConnection): RemoteConnection {
  return connection.kind === "space_connection"
    ? { kind: "space_connection", id: connection.row.id, actions: connection.row.actions }
    : connection;
}

/** The call, made by the broker at `BROKER_URL`: the one way a process without the key makes one. */
export async function remoteBrokerCall<T>(call: BrokerCallInput<T>): Promise<BrokerResult<T>> {
  if (call.handler || call.quietWhen) {
    throw new Error(
      `${call.action.id}: a call that runs code with the account can't go to the broker.`,
    );
  }
  const answers: (AskResult | null)[] = [];
  for (;;) {
    const out = await post({
      who: call.who,
      where: call.where,
      connection: remoteConnectionOf(call.connection),
      action: call.action,
      input: call.input,
      ...(call.named ? { named: call.named } : {}),
      ctx: {
        canAsk: Boolean(call.ctx?.ask),
        answers,
        allowed: call.ctx?.allowed ? [...call.ctx.allowed] : undefined,
        confirmed: call.ctx?.confirmed,
        approved: call.ctx?.approved,
        effect: call.ctx?.effect,
      },
    });
    if ("connected" in out) {
      throw new Error("The broker answered a call with whether it is connected.");
    }
    if ("ask" in out) {
      // Two questions at most: whether it may happen again, then the rule's.
      if (!call.ctx?.ask || answers.length >= 2) {
        throw new Error("The broker asked once more than it can.");
      }
      answers.push(await call.ctx.ask(out.ask));
      continue;
    }
    if ("thrown" in out) {
      throw Object.assign(new Error(out.thrown.message), {
        ...(out.thrown.name ? { name: out.thrown.name } : {}),
        ...(out.thrown.status ? { status: out.thrown.status } : {}),
      });
    }
    for (const key of out.allowed) {
      call.ctx?.allowed?.add(key);
    }
    if (!out.ok) {
      return { ok: false, refused: out.refused as never, reason: out.reason };
    }
    return {
      ok: true,
      result: out.result as T,
      // Who the call reached, by name: the connector's code stays with the broker.
      account: {
        connector: { id: out.account.connector, name: out.account.name } as ConnectorDefinition,
        label: out.account.label,
      },
    };
  }
}

/** One round to the broker at `BROKER_URL`, in this tenant. */
async function post(call: RemoteCall): Promise<RemoteAnswer> {
  if (!env.brokerUrl) {
    throw new Error("BROKER_URL is not set: this process opens no connected account.");
  }
  const tenant = currentTenant();
  const body = JSON.stringify(call);
  const res = await fetch(`${env.brokerUrl}${BROKER_CALL_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-wizards-tenant": tenant,
      "x-wizards-ticket": brokerTicket(tenant, body),
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`The broker answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return (await res.json()) as RemoteAnswer;
}

/** Whether an account is there for `who`, and whose, as the broker reads it. */
export async function remoteConnected(
  connection: BrokerConnection,
  who: Who,
): Promise<{ connector: ConnectorDefinition; label: string } | null> {
  const out = await post({
    who,
    where: {},
    connection: remoteConnectionOf(connection),
    action: { id: "connected", kind: "read" },
    input: null,
    connected: true,
    ctx: { canAsk: false },
  });
  if (!("connected" in out)) {
    throw new Error("The broker answered whether it is connected with something else.");
  }
  return out.connected
    ? {
        connector: { id: out.connected.connector, name: out.connected.name } as ConnectorDefinition,
        label: out.connected.label,
      }
    : null;
}

async function connectionOf(remote: RemoteConnection): Promise<BrokerConnection | null> {
  if (remote.kind === "store_secret") {
    return remote;
  }
  const row = await db.query.spaceConnection.findFirst({
    where: eq(schema.spaceConnection.id, remote.id),
  });
  if (!row) {
    return null;
  }
  return {
    kind: "space_connection",
    row: remote.actions ? { ...row, actions: remote.actions } : row,
    connector: await connectorOfRow(row),
  };
}

/** The broker's side: makes the call it was sent, in the tenant the route opened. */
export async function answerRemoteCall(call: RemoteCall): Promise<RemoteAnswer> {
  const connection = await connectionOf(call.connection);
  if (call.connected) {
    const found = connection ? await brokerConnected(connection, call.who) : null;
    return {
      connected: found
        ? { connector: found.connector.id, name: found.connector.name, label: found.label }
        : null,
    };
  }
  if (!connection) {
    return {
      ok: false,
      refused: "not_connected",
      reason: "The connection was removed.",
      allowed: [],
    };
  }
  const allowed = new Set(call.ctx.allowed ?? []);
  const before = new Set(allowed);
  const answers = [...(call.ctx.answers ?? [])];
  const ask = call.ctx.canAsk
    ? async (input: AskInput) => {
        if (answers.length) {
          return answers.shift() ?? null;
        }
        throw new AskFirst(input);
      }
    : undefined;
  try {
    const out = await brokerCall({
      who: call.who,
      where: call.where,
      connection,
      action: call.action,
      input: call.input,
      ...(call.named ? { named: call.named } : {}),
      ctx: {
        ...(ask ? { ask } : {}),
        allowed,
        confirmed: call.ctx.confirmed,
        approved: call.ctx.approved,
        effect: call.ctx.effect,
      },
    });
    const added = [...allowed].filter((key) => !before.has(key));
    return out.ok
      ? {
          ok: true,
          result: out.result,
          account: {
            connector: out.account.connector.id,
            name: out.account.connector.name,
            label: out.account.label,
          },
          allowed: added,
        }
      : { ok: false, refused: out.refused, reason: out.reason, allowed: added };
  } catch (err) {
    if (err instanceof AskFirst) {
      return { ask: err.ask };
    }
    const status = (err as { status?: unknown }).status;
    return {
      thrown: {
        message: err instanceof Error ? err.message : String(err),
        ...(err instanceof Error && err.name !== "Error" ? { name: err.name } : {}),
        ...(typeof status === "number" ? { status } : {}),
      },
    };
  }
}
