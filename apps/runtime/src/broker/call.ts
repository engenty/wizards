import type { BrokerRefusal, ConnectionActionKind } from "@engenty/wizards-shared/connectors";
import type { AskInput } from "@engenty/wizards-shared/run";
import type { ConnectionDef } from "@engenty/wizards-shared/store";
import type { SpaceConnectionRow } from "../connectors/space-connections.js";
import type {
  ConnectorAction,
  ConnectorActionGroup,
  ConnectorDefinition,
} from "../engenty/connections-sdk/types.js";
import type { AskResult } from "../engine/asks.js";
import type { StepContext } from "../engine/types.js";
import type { Role } from "../manage.js";
import type { StoreScope } from "../store/index.js";
import { type Account, keptSecret, markUsed, spaceAccount, wizardAccount } from "./account.js";
import { type Grant, inGrant, runGrant } from "./grant.js";
import { type LineContext, SIGN_IN_FAILED, summarizeInput, writeLog } from "./log.js";
import { guestSendCheck, recipientsOf } from "./send.js";

/*
 * The broker (docs/plans/broker.md): the one path every connector call takes. It knows who calls
 * and where, reads the account's secret (the only reader), decides allow / ask / deny, runs the
 * action and writes one line of the log. A connection of the space (A5 of
 * docs/plans/capabilities.md) decides by its audience and rules; a wizard's own sign-in by the
 * rules the code had before. „Mit Freigabe“ on a connection that signs in as the space is an
 * `ask` of the space's admins: the broker answers `needs_approval` and the caller holds the call
 * (a Work chat: `chat_approval`, the bell); once an admin approved it, the same call runs with
 * `ctx.approved` (A7).
 */

/** Who calls: a guest at the wizard's link, a signed-in person, Goose for a person, a plugin's own job, a fixed step. */
export type WhoKind = "guest" | "person" | "admin" | "goose" | "plugin" | "step";

export interface Who {
  kind: WhoKind;
  /** The visitor, the person, the plugin or the step; left out where there is none. */
  id?: string;
  /** A fixed step: whom the run is held for, which says whether the step is in a connection's audience. */
  for?: Who;
  /** Goose for an admin: counts as one for a connection's audience. */
  admin?: boolean;
}

/** The run or chat a call is made in. */
export interface Where {
  runId?: string;
  /** The step of the run that calls; left out outside a step (a share job). */
  stepId?: string;
  chatId?: string;
  wizardId?: string;
  spaceId?: string;
  mode?: "test" | "live";
  /** A guest's run: live, and nobody signed in. */
  guest?: boolean;
  /** The outside client that calls (an MCP client, `x-wizards-client`), for the log. */
  client?: string;
}

/** What an action does, as the rules see it. */
export type ActionKind = ConnectionActionKind;

/** Which connection: one a wizard holds for the person running it, or one of the space. */
export type BrokerConnection =
  | { kind: "store_secret"; def: ConnectionDef; scope: StoreScope; spaceId: string }
  | { kind: "space_connection"; row: SpaceConnectionRow; connector: ConnectorDefinition };

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
  /** An admin of the space approved exactly this call (a held call, decided): „Mit Freigabe“ is met. */
  approved?: boolean;
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

/**
 * Why a call did not run, one of `BROKER_REFUSALS` (shared/connectors), so the Protokoll page has
 * words for each: `needs_approval` – the connection's rule says „Mit Freigabe“, the call waits for
 * an admin of the space and the caller holds it; `ai_step_writes` – an AI step wanted to write as
 * the space, which only a fixed `call` step does (A4); `not_allowed_recipient` – a guest's send to
 * an address that is neither the run's own nor in the space's domains; `run_limit` – a guest's
 * run has sent its mails; `day_limit` – the wizard's guests have sent today's mails.
 */
export type Refusal = BrokerRefusal;

export type BrokerResult<T> =
  | { ok: true; result: T; account: { connector: ConnectorDefinition; label: string } }
  | { ok: false; refused: Refusal; reason: string };

export interface Decision {
  outcome: "allow" | "ask" | "deny";
  /**
   * Which rule decided, as the log and „Was darf …?“ name it: `grant`, `audience`, `actions`,
   * `ai_step_writes`, `rules.<kind>` (a connection of the space), `destructive`, `policy.<action>`
   * (a wizard's connection), `read`, `own_job`.
   */
  rule: string;
  reason: string;
  /** A deny's refusal where it is more than "denied". */
  refused?: Refusal;
  /** An ask of the space's admins („Mit Freigabe“ as the space), not of the person calling. */
  admins?: boolean;
}

/**
 * A wizard's step calls as the person running it: the store's holder says who that is, their
 * role in the organization whether they count as an admin.
 */
export function whoOf(holder: string, role?: Role): Who {
  if (holder.startsWith("u:")) {
    const admin = role === "owner" || role === "admin";
    return { kind: admin ? "admin" : "person", id: holder.slice(2) };
  }
  if (holder.startsWith("v:")) {
    return { kind: "guest", id: holder.slice(2) };
  }
  // `r:<run>`: a run nobody signed in for and no visitor cookie names.
  return { kind: "guest", id: holder.replace(/^r:/, "") };
}

/** Where a step's call is made. */
export function whereOf(ctx: StepContext): Where {
  return {
    ...whereOfRun(
      { id: ctx.runId, wizardId: ctx.store.wizardId, mode: ctx.test ? "test" : "live" },
      ctx.store.holder,
      ctx.space.id,
    ),
    stepId: ctx.stepId,
  };
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
  return group === "destructive" || group === "write" || group === "send" ? group : "read";
}

/** Whether this caller is in a connection's audience: Admins, Mitglieder or alle. */
export function inAudience(audience: SpaceConnectionRow["audience"], who: Who): boolean {
  if (audience === "all") {
    return true;
  }
  // A fixed step is in the audience its run's holder is in; a plugin's job works for the space.
  const asked = who.kind === "step" && who.for ? who.for : who;
  if (audience === "members") {
    return asked.kind !== "guest";
  }
  return asked.kind === "admin" || (asked.kind === "goose" && asked.admin === true);
}

/**
 * The decision, with no side effect: the same function „Was darf …?“ will show. The run's grant
 * comes first: a wizard's connection outside it, or an action the grant does not name, is denied
 * whatever the rules say.
 *
 * A connection of the space: outside its audience nothing runs, nor an action the connection is
 * not for. Its rules say per kind of action Erlaubt, Mit Freigabe or Nie. On a connection that
 * signs in as the space an AI step only reads: a write there comes from a fixed `call` step (the
 * wizard's fields, no model) or a Work chat's confirmed action, and never asks the person running;
 * „Mit Freigabe“ there asks the space's admins (`admins`). Where each person signs in, „Mit
 * Freigabe“ asks that person. A plugin's own job on a connection it set up runs as before.
 *
 * A wizard's own connection: reads run, writes and sends ask the person running, deleting always
 * asks; the wizard's author may settle an action's ask per `connection.policy`.
 */
export function decide(call: {
  who: Who;
  where: Where;
  connection: BrokerConnection;
  actionId: string;
  kind: ActionKind;
  /** The run's grant, where the call is bound by one (`grantBinds`); left out: no grant applies. */
  grant?: Grant | null;
}): Decision {
  const { connection, kind, who } = call;
  if (call.grant && connection.kind === "store_secret") {
    if (!inGrant(call.grant, connection.def.id, call.actionId, kind)) {
      return {
        outcome: "deny",
        rule: "grant",
        reason: `The run's grant does not include "${call.actionId}" through ${connection.def.id}.`,
      };
    }
  }
  if (connection.kind === "space_connection") {
    const { row } = connection;
    const ownJob =
      who.kind === "plugin" && row.plugin === who.id && !call.where.runId && !call.where.chatId;
    if (ownJob) {
      return { outcome: "allow", rule: "own_job", reason: "The plugin's own connection." };
    }
    if (!inAudience(row.audience, who)) {
      return {
        outcome: "deny",
        rule: "audience",
        reason: `The connection is for ${AUDIENCE[row.audience]}.`,
      };
    }
    if (row.actions.length && !row.actions.includes(call.actionId)) {
      return {
        outcome: "deny",
        rule: "actions",
        reason: `The connection is not for "${call.actionId}".`,
      };
    }
    if (row.signIn === "space" && kind !== "read" && aiStep(who, call.where)) {
      return {
        outcome: "deny",
        rule: "ai_step_writes",
        refused: "ai_step_writes",
        reason: `An AI step only reads as the space: ${VERB[kind]} goes in a fixed step with "call".`,
      };
    }
    const rule = row.rules[kind] ?? "deny";
    const named = `rules.${kind}`;
    if (rule === "deny") {
      return {
        outcome: "deny",
        rule: named,
        reason: `The connection's rule: ${VERB[kind]} never.`,
      };
    }
    if (rule === "allow") {
      return {
        outcome: "allow",
        rule: named,
        reason: `The connection's rule: ${VERB[kind]} allowed.`,
      };
    }
    if (row.signIn === "person") {
      return {
        outcome: "ask",
        rule: named,
        reason: `The connection's rule: ${VERB[kind]} asks the person.`,
      };
    }
    return {
      outcome: "ask",
      rule: named,
      admins: true,
      reason: `The connection's rule: ${VERB[kind]} asks the space's admins.`,
    };
  }
  if (kind === "destructive") {
    return { outcome: "ask", rule: "destructive", reason: "Deleting always asks the person." };
  }
  const set = connection.def.policy?.[call.actionId];
  const policy = set ?? (kind === "read" ? "allow" : "ask");
  const named = set ? `policy.${call.actionId}` : kind === "read" ? "read" : "policy";
  if (policy === "ask") {
    return {
      outcome: "ask",
      rule: named,
      reason: "A change asks the person running the wizard.",
    };
  }
  return {
    outcome: "allow",
    rule: named,
    reason: kind === "read" ? "Reading is allowed." : "The wizard allows this action.",
  };
}

/**
 * Whether a call in a run comes from an AI step: a model's tool call, made as the person running
 * (a guest, a person, an admin), or a plugin tool it called. A fixed step calls as `step`; a
 * plugin's own job and a Work chat are no run.
 */
function aiStep(who: Who, where: Where): boolean {
  return !!where.runId && who.kind !== "step";
}

/**
 * Whether a run's grant binds this call: a wizard's own connection, called in a run. A plugin's
 * connection is the space's, under its own rules (A4, A5); a share target's connection
 * (`def.target`) is the person's own request after the run, never in the definition.
 */
export function grantBinds(where: Where, connection: BrokerConnection): boolean {
  return !!where.runId && connection.kind === "store_secret" && !connection.def.target;
}

const AUDIENCE: Record<SpaceConnectionRow["audience"], string> = {
  admins: "the space's admins",
  members: "the space's members",
  all: "everyone",
};
const VERB: Record<ActionKind, string> = {
  read: "reading",
  write: "writing",
  destructive: "deleting",
  send: "sending",
};

/** The log's id of a connection: a plugin's row, a wizard's connection id. */
function connectionIdOf(connection: BrokerConnection): string {
  return connection.kind === "space_connection" ? connection.row.id : connection.def.id;
}

async function accountOf(connection: BrokerConnection, who: Who): Promise<Account | null> {
  return connection.kind === "space_connection"
    ? spaceAccount(connection.row, connection.connector, who)
    : wizardAccount(connection.scope, connection.def, connection.spaceId);
}

/** Nobody in particular: for what a wizard's connection holds, which asks for no caller. */
const NOBODY: Who = { kind: "guest" };

/**
 * The account a connection holds, without its secret: whether and as whom it is connected. A
 * connection in which each person signs in needs the caller to say whose.
 */
export async function brokerConnected(
  connection: BrokerConnection,
  who: Who = NOBODY,
): Promise<{ connector: ConnectorDefinition; label: string } | null> {
  const account = await accountOf(connection, who);
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
  // A connection of the space used for the first time is heard of (log.ts, `first_use`).
  const firstUse = connection.kind === "space_connection" && !connection.row.lastUsedAt;
  const line = (
    kind: ActionKind,
    outcome: Decision["outcome"],
    rule: string | null,
    reason: string,
    result: string,
    size: number | null = null,
    context: LineContext = {},
  ) =>
    writeLog(
      {
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
        connectionId,
        actionId: call.action.id,
        kind,
        inputSummary: summarizeInput(call.input),
        outcome,
        rule,
        reason,
        result,
        resultSize: size,
      },
      context,
    );

  // The account says what kind the action is; its secret stays inside the broker. A sign-in
  // that ran out and cannot be renewed, or that the service refuses, is heard of.
  let account: Account | null;
  try {
    account = await accountOf(connection, who);
  } catch (err) {
    const reason = `The sign-in could not be renewed: ${err instanceof Error ? err.message : String(err)}`;
    await line(call.action.kind ?? "read", "deny", null, reason, SIGN_IN_FAILED);
    return { ok: false, refused: "not_connected", reason };
  }
  const found = account?.connector.actions.find((a) => a.id === call.action.id);
  const kind = call.action.kind ?? (found ? kindOf(found.group) : "write");

  // The grant first: what the run's definition gave it, fixed when it started.
  let grant: Grant | null | undefined;
  if (grantBinds(where, connection)) {
    grant = await runGrant(where.runId as string);
    if (!grant) {
      const reason = "The run is not known here.";
      await line(kind, "deny", "grant", reason, "not_in_grant");
      return { ok: false, refused: "not_in_grant", reason };
    }
    if (!inGrant(grant, connectionId, call.action.id, kind)) {
      const decision = decide({ who, where, connection, actionId: call.action.id, kind, grant });
      await line(kind, "deny", decision.rule, decision.reason, "not_in_grant");
      return { ok: false, refused: "not_in_grant", reason: decision.reason };
    }
  }
  if (!account) {
    const reason =
      connection.kind === "space_connection" && connection.row.signIn === "person"
        ? "You have not signed in to this connection."
        : "Nothing is connected.";
    await line(kind, "deny", null, reason, "not_connected");
    return { ok: false, refused: "not_connected", reason };
  }
  if (!(found || call.handler)) {
    const reason = `${account.connector.name} has no action "${call.action.id}".`;
    await line(kind, "deny", null, reason, "no_action");
    return { ok: false, refused: "no_action", reason };
  }

  const decision = decide({ who, where, connection, actionId: call.action.id, kind, grant });
  const { rule } = decision;
  if (decision.outcome === "deny") {
    const refused = decision.refused ?? "denied";
    await line(kind, "deny", rule, decision.reason, refused);
    return { ok: false, refused, reason: decision.reason };
  }
  // A guest's send goes only to the run's own address or the space's domains, a few per run and day.
  if (kind === "send" && where.guest) {
    const sent = await guestSendCheck(where, recipientsOf(call.input));
    if (!sent.ok) {
      await line(kind, "deny", "guest_send", sent.reason, sent.refused);
      return { ok: false, refused: sent.refused, reason: sent.reason };
    }
  }
  if (decision.outcome === "ask" && decision.admins) {
    // „Mit Freigabe“ as the space: the person's own yes is not enough; an admin's is.
    if (ctx.approved) {
      decision.reason = "An admin of the space approved it.";
    } else {
      await line(kind, "ask", rule, decision.reason, "needs_approval");
      return { ok: false, refused: "needs_approval", reason: decision.reason };
    }
  } else if (decision.outcome === "ask") {
    const key = `${connectionId}:${call.action.id}`;
    if (ctx.allowed?.has(key)) {
      decision.reason = "The person allowed it for the rest of the run.";
    } else if (ctx.confirmed && kind !== "destructive") {
      decision.reason = "The person asked for it themselves.";
    } else if (!ctx.ask) {
      await line(kind, "ask", rule, decision.reason, "nobody");
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
        await line(kind, "ask", rule, decision.reason, "nobody");
        return { ok: false, refused: "nobody", reason: "Nobody is there to ask." };
      }
      if (answer.type !== "done") {
        await line(kind, "ask", rule, decision.reason, "declined");
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
    await line(kind, decision.outcome, rule, decision.reason, "ok", sizeOf(result), { firstUse });
    if (connection.kind === "space_connection") {
      await markUsed(connection.row);
    }
    return { ok: true, result, account: { connector: account.connector, label: account.label } };
  } catch (err) {
    // The service turned the sign-in down: heard of, like a sign-in that ran out.
    const result = signInRefused(err)
      ? SIGN_IN_FAILED
      : err instanceof Error
        ? err.constructor.name || "Error"
        : "Error";
    await line(kind, decision.outcome, rule, decision.reason, result);
    throw err;
  }
}

/** Whether the service answered a call with "who are you?": its 401, or an OAuth grant gone. */
export function signInRefused(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return /(^|\D)401(\D|$)|invalid_grant|unauthori[sz]ed|token (has )?expired/i.test(text);
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
      stepId: call.where.stepId ?? null,
      client: call.where.client ?? null,
      chatId: call.where.chatId ?? null,
      wizardId: call.where.wizardId ?? null,
      spaceId: call.where.spaceId ?? null,
      connectionId: call.slot,
      actionId: "read_secret",
      kind: "read",
      inputSummary: summarizeInput({}),
      outcome: "allow",
      rule: "read",
      reason: "Reading is allowed.",
      result,
      resultSize: null,
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
