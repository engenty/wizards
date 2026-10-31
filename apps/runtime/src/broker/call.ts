import type { AskInput } from "@engenty/wizards-shared/run";
import type { ConnectionDef } from "@engenty/wizards-shared/store";
import type { PluginConnectionRow } from "../connectors/plugin-connections.js";
import type {
  ConnectorAction,
  ConnectorActionGroup,
  ConnectorDefinition,
} from "../engenty/connections-sdk/types.js";
import type { AskResult } from "../engine/asks.js";
import type { StepContext } from "../engine/types.js";
import type { StoreScope } from "../store/index.js";
import { type Account, keptSecret, pluginAccount, wizardAccount } from "./account.js";
import { summarizeInput, writeLog } from "./log.js";

/*
 * The broker (docs/plans/broker.md): the one path every connector call takes. It knows who calls
 * and where, reads the account's secret (the only reader), decides allow / ask / deny by the rules
 * the code has today, runs the action and writes one line of the log. Phase A2 of
 * docs/plans/capabilities.md: rules as data, grants, audiences and „Mit Freigabe“ come after.
 */

/** Who calls: a guest at the wizard's link, a signed-in person, Goose for a person, a plugin's own job, a fixed step. */
export type WhoKind = "guest" | "person" | "admin" | "goose" | "plugin" | "step";

export interface Who {
  kind: WhoKind;
  /** The visitor, the person, the plugin or the step; left out where there is none. */
  id?: string;
}

/** The run or chat a call is made in. */
export interface Where {
  runId?: string;
  chatId?: string;
  wizardId?: string;
  spaceId?: string;
  mode?: "test" | "live";
  /** A guest's run: live, and nobody signed in. */
  guest?: boolean;
}

/** What an action does, as the rules see it. */
export type ActionKind = "read" | "write" | "destructive" | "send";

/** Which connection: one a wizard holds for the person running it, or one a plugin connected for the space. */
export type BrokerConnection =
  | { kind: "store_secret"; def: ConnectionDef; scope: StoreScope; spaceId: string }
  | { kind: "plugin_connection"; row: PluginConnectionRow; connector: ConnectorDefinition };

export interface BrokerAction {
  id: string;
  /** Left out: the connector's action of that id says. */
  kind?: ActionKind;
}

/** How a caller can be asked, and what it already allowed. */
export interface BrokerContext {
  /** Asks the person running; absent: nobody can be asked, so an ask is refused. */
  ask?: (ask: AskInput) => Promise<AskResult | null>;
  /** Actions the person allowed for the rest of the run, as "<connection>:<action>". */
  allowed?: Set<string>;
  /** The person asked for exactly this themselves (a share job's form): a write runs without a further ask. */
  confirmed?: boolean;
}

export interface BrokerCallInput<T = unknown> {
  who: Who;
  where: Where;
  connection: BrokerConnection;
  action: BrokerAction;
  input: unknown;
  ctx?: BrokerContext;
  /** What runs with the account; left out: the connector's action of that id, with `input`. */
  handler?: (account: Account) => Promise<T>;
}

export type Refusal = "not_connected" | "no_action" | "denied" | "declined" | "nobody";

export type BrokerResult<T> =
  | { ok: true; result: T; account: { connector: ConnectorDefinition; label: string } }
  | { ok: false; refused: Refusal; reason: string };

export interface Decision {
  outcome: "allow" | "ask" | "deny";
  reason: string;
}

/** A wizard's step calls as the person running it: the store's holder says who that is. */
export function whoOf(holder: string): Who {
  if (holder.startsWith("u:")) {
    return { kind: "person", id: holder.slice(2) };
  }
  if (holder.startsWith("v:")) {
    return { kind: "guest", id: holder.slice(2) };
  }
  // `r:<run>`: a run nobody signed in for and no visitor cookie names.
  return { kind: "guest", id: holder.replace(/^r:/, "") };
}

/** Where a step's call is made. */
export function whereOf(ctx: StepContext): Where {
  return whereOfRun(
    { id: ctx.runId, wizardId: ctx.store.wizardId, mode: ctx.test ? "test" : "live" },
    ctx.store.holder,
    ctx.space.id,
  );
}

/** Where a call about a run is made (a share job, a step). */
export function whereOfRun(
  run: { id: string; wizardId: string; mode: string },
  holder: string,
  spaceId: string,
): Where {
  const mode = run.mode === "test" ? "test" : "live";
  return {
    runId: run.id,
    wizardId: run.wizardId,
    spaceId,
    mode,
    guest: mode === "live" && !holder.startsWith("u:"),
  };
}

/** The rules' view of a connector action's group. */
export function kindOf(group: ConnectorActionGroup): ActionKind {
  return group === "destructive" ? "destructive" : group === "write" ? "write" : "read";
}

/**
 * The decision, with no side effect: the same function „Was darf …?“ will show. The rules are the
 * code's of today. A wizard's connection: reads run, writes and sends ask the person running,
 * deleting always asks; the wizard's author may settle an action's ask per `connection.policy`.
 * A plugin's connection: a plugin's own call runs; from a guest's run only reads do.
 */
export function decide(call: {
  who: Who;
  where: Where;
  connection: BrokerConnection;
  actionId: string;
  kind: ActionKind;
}): Decision {
  const { connection, kind } = call;
  if (connection.kind === "plugin_connection") {
    if (call.where.guest && kind !== "read") {
      return {
        outcome: "deny",
        reason: "A guest's run only reads through a plugin's connection.",
      };
    }
    return {
      outcome: "allow",
      reason: kind === "read" ? "Reading is allowed." : "The plugin's own connection.",
    };
  }
  if (kind === "destructive") {
    return { outcome: "ask", reason: "Deleting always asks the person." };
  }
  const policy = connection.def.policy?.[call.actionId] ?? (kind === "read" ? "allow" : "ask");
  if (policy === "ask") {
    return { outcome: "ask", reason: "A change asks the person running the wizard." };
  }
  return {
    outcome: "allow",
    reason: kind === "read" ? "Reading is allowed." : "The wizard allows this action.",
  };
}

/** The log's id of a connection: a plugin's row, a wizard's connection id. */
function connectionIdOf(connection: BrokerConnection): string {
  return connection.kind === "plugin_connection" ? connection.row.id : connection.def.id;
}

async function accountOf(connection: BrokerConnection): Promise<Account | null> {
  return connection.kind === "plugin_connection"
    ? pluginAccount(connection.row, connection.connector)
    : wizardAccount(connection.scope, connection.def, connection.spaceId);
}

/** The account a connection holds, without its secret: whether and as whom it is connected. */
export async function brokerConnected(
  connection: BrokerConnection,
): Promise<{ connector: ConnectorDefinition; label: string } | null> {
  const account = await accountOf(connection);
  return account ? { connector: account.connector, label: account.label } : null;
}

/** The widest the person sees of an input they are asked about. */
const ASK_INPUT = 4000;

/**
 * One call through the broker: who, where, which connection and action, with what. Reads the
 * account, decides, asks where the rules say so, runs the action (the connector's, or `handler`)
 * and logs the call, whatever came of it. An error the action throws is logged and thrown on.
 */
export async function brokerCall<T = unknown>(call: BrokerCallInput<T>): Promise<BrokerResult<T>> {
  const started = Date.now();
  const { who, where, connection, ctx = {} } = call;
  const connectionId = connectionIdOf(connection);
  const line = (
    kind: ActionKind,
    outcome: Decision["outcome"],
    reason: string,
    result: string,
    size: number | null = null,
  ) =>
    writeLog({
      at: new Date(started),
      durationMs: Date.now() - started,
      whoKind: who.kind,
      whoId: who.id ?? null,
      runId: where.runId ?? null,
      chatId: where.chatId ?? null,
      wizardId: where.wizardId ?? null,
      spaceId: where.spaceId ?? null,
      connectionId,
      actionId: call.action.id,
      kind,
      inputSummary: summarizeInput(call.input),
      outcome,
      reason,
      result,
      resultSize: size,
      critical: outcome === "deny" && kind !== "read",
    });

  const account = await accountOf(connection);
  const found = account?.connector.actions.find((a) => a.id === call.action.id);
  const kind = call.action.kind ?? (found ? kindOf(found.group) : "write");
  if (!account) {
    await line(kind, "deny", "Nothing is connected.", "not_connected");
    return { ok: false, refused: "not_connected", reason: "Nothing is connected." };
  }
  if (!(found || call.handler)) {
    const reason = `${account.connector.name} has no action "${call.action.id}".`;
    await line(kind, "deny", reason, "no_action");
    return { ok: false, refused: "no_action", reason };
  }

  const decision = decide({ who, where, connection, actionId: call.action.id, kind });
  if (decision.outcome === "deny") {
    await line(kind, "deny", decision.reason, "denied");
    return { ok: false, refused: "denied", reason: decision.reason };
  }
  if (decision.outcome === "ask") {
    const key = `${connectionId}:${call.action.id}`;
    if (ctx.allowed?.has(key)) {
      decision.reason = "The person allowed it for the rest of the run.";
    } else if (ctx.confirmed && kind !== "destructive") {
      decision.reason = "The person asked for it themselves.";
    } else if (!ctx.ask) {
      await line(kind, "ask", decision.reason, "nobody");
      return { ok: false, refused: "nobody", reason: "Nobody is there to ask." };
    } else {
      const answer = await ctx.ask({
        kind: "confirm",
        reason: found?.summary || call.action.id,
        service: account.label,
        action: {
          id: call.action.id,
          summary: found?.summary ?? call.action.id,
          destructive: kind === "destructive",
        },
        input: JSON.stringify(call.input ?? {}, null, 2).slice(0, ASK_INPUT),
      });
      if (!answer) {
        await line(kind, "ask", decision.reason, "nobody");
        return { ok: false, refused: "nobody", reason: "Nobody is there to ask." };
      }
      if (answer.type !== "done") {
        await line(kind, "ask", decision.reason, "declined");
        return { ok: false, refused: "declined", reason: "The person did not allow it." };
      }
      if (answer.remember) {
        ctx.allowed?.add(key);
      }
    }
  }

  try {
    const result = call.handler
      ? await call.handler(account)
      : ((await (found as ConnectorAction).handler(call.input ?? {}, account.ctx)) as T);
    await line(kind, decision.outcome, decision.reason, "ok", sizeOf(result));
    return { ok: true, result, account: { connector: account.connector, label: account.label } };
  } catch (err) {
    const name = err instanceof Error ? err.constructor.name || "Error" : "Error";
    await line(kind, decision.outcome, decision.reason, name);
    throw err;
  }
}

/**
 * A secret of a run's store that is no connection (the browser's kept sign-ins), read through
 * the broker as a `read`: the handler alone sees it, and the call is logged like any other.
 */
export async function brokerSecret<S, T>(call: {
  who: Who;
  where: Where;
  scope: StoreScope;
  slot: string;
  handler: (secret: S | null) => Promise<T>;
}): Promise<T> {
  const started = Date.now();
  const kept = await keptSecret<S>(call.scope, call.slot);
  const line = (result: string) =>
    writeLog({
      at: new Date(started),
      durationMs: Date.now() - started,
      whoKind: call.who.kind,
      whoId: call.who.id ?? null,
      runId: call.where.runId ?? null,
      chatId: call.where.chatId ?? null,
      wizardId: call.where.wizardId ?? null,
      spaceId: call.where.spaceId ?? null,
      connectionId: call.slot,
      actionId: "read_secret",
      kind: "read",
      inputSummary: summarizeInput({}),
      outcome: "allow",
      reason: "Reading is allowed.",
      result,
      resultSize: null,
      critical: false,
    });
  try {
    const result = await call.handler(kept?.data ?? null);
    await line(kept ? "ok" : "not_connected");
    return result;
  } catch (err) {
    await line(err instanceof Error ? err.constructor.name || "Error" : "Error");
    throw err;
  }
}

function sizeOf(result: unknown): number | null {
  if (result === undefined || result === null) {
    return 0;
  }
  if (typeof result === "string") {
    return result.length;
  }
  if (typeof result !== "object") {
    return null;
  }
  try {
    return JSON.stringify(result)?.length ?? null;
  } catch {
    return null;
  }
}
