import type { BrokerRefusal, ConnectionActionKind } from "@engenty/wizards-shared/connectors";
import type { AskInput } from "@engenty/wizards-shared/run";
import type { ConnectionDef } from "@engenty/wizards-shared/store";
import type { SpaceConnectionRow } from "../connectors/space-connections.js";
import type {
  ConnectorAction,
  ConnectorActionGroup,
  ConnectorDefinition,
  InboundMessage,
  StreamPullResult,
} from "../engenty/connections-sdk/types.js";
import type { AskResult } from "../engine/asks.js";
import { effectUnsure } from "../engine/events.js";
import type { StepContext } from "../engine/types.js";
import type { Role } from "../manage.js";
import type { StoreScope } from "../store/index.js";
import {
  type Account,
  heldConnection,
  keptSecret,
  markUsed,
  spaceAccount,
  stateOf,
  wizardAccount,
} from "./account.js";
import {
  askAgain,
  type EffectCall,
  effectDone,
  effectIdOf,
  effectThrew,
  findEffect,
  startEffect,
} from "./effect.js";
import { type Grant, inGrant, runGrant } from "./grant.js";
import {
  CALLS_PER_DAY,
  CALLS_PER_RUN,
  closeLine,
  type LineContext,
  limitHeard,
  type OpenLine,
  SIGN_IN_FAILED,
  summarizeInput,
  takePlace,
  writeLog,
} from "./log.js";
import { runOver } from "./over.js";
import { channelOf, guestSendCheck, postsToChannel, recipientsOf } from "./send.js";

/*
 * The broker (docs/plans/broker.md): the one path every connector call takes. It knows who calls
 * and where, reads the account's secret (the only reader), decides allow / ask / deny, runs the
 * action and writes one line of the log. A connection of the space (A5 of
 * docs/plans/capabilities.md) decides by its audience and rules; a wizard's own sign-in by the
 * rules the code had before. „Mit Freigabe“ on a connection that signs in as the space is an
 * `ask` of the space's admins: the broker answers `needs_approval` and the caller holds the call
 * (a Work chat: `approval`, the bell); once an admin approved it, the same call runs with
 * `ctx.approved` (A7).
 *
 * Two things are asked before any of it, on every call (docs/plans/capabilities-next.md, 2a):
 * whether the call's run is over (`over.ts`: stopping a run is the revoke), and whether a
 * connection of the space pauses. Neither trusts what a step or a chat turn read when it started.
 *
 * A connection of the space may limit its calls per run and per day (2b), for every caller: a
 * call that would run takes its place first by writing its line (`log.ts`, `takePlace`), and the
 * one past a limit is refused. The limits are read with the pause, on every call.
 */

/**
 * Who calls: a guest at the wizard's link, a signed-in person, Goose for a person, a plugin's own
 * job, a fixed step, the runtime reading for nobody in particular (`brokerPullStream`).
 */
export type WhoKind = "guest" | "person" | "admin" | "goose" | "plugin" | "step" | "runtime";

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
  /**
   * A share job: the person sends a finished run's result on. The one call a run that is done
   * still makes (over.ts).
   */
  share?: boolean;
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
  /** Which call this is, so that an action that is no read happens once (broker/effect.ts). */
  effect?: EffectCall;
}

export interface BrokerCallInput<T = unknown> {
  who: Who;
  where: Where;
  connection: BrokerConnection;
  action: BrokerAction;
  input: unknown;
  ctx?: BrokerContext;
  /** A call that went well and answered this leaves no line in the log. */
  quietWhen?: (result: T) => boolean;
  /** What runs with the account; left out: the connector's action of that id, with `input`. */
  handler?: (account: Account) => Promise<T>;
}

/**
 * Why a call did not run, one of `BROKER_REFUSALS` (shared/connectors), so the Protokoll page has
 * words for each: `needs_approval` – the connection's rule says „Mit Freigabe“, the call waits for
 * an admin of the space and the caller holds it; `ai_step_writes` – an AI step wanted to write as
 * the space, which only a fixed `call` step does (A4); `not_allowed_recipient` – a guest's send to
 * an address that is neither the run's own nor in the space's domains; `channel_not_fixed` – a
 * guest's post to a channel its published step does not fix; `run_limit` – a guest's run has sent
 * its mails and posts; `day_limit` – the wizard's guests have sent today's; `calls_per_run` – the
 * run has made the calls the connection takes from one run; `calls_per_day` – the connection has
 * taken today's calls; `run_ended` – the call's run was stopped, is done or failed (over.ts);
 * `paused` – an admin paused the connection; `may_have_happened` – the action was interrupted
 * before, and no person allowed it again.
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
   * (a wizard's connection), `read`, `own_job`, `autonomous_mode`, `paused`. A run that is over is
   * logged as `run.<status>` (over.ts), before any decision here; a call past a connection's limit as
   * `limits.run` or `limits.day`, after it. The log also has `once` (broker/effect.ts).
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
    ...(ctx.share ? { share: true } : {}),
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

/**
 * The rules' view of a connector action's group. An imported connector's group is what an admin
 * said the action does, where one did, before the importer's guess (`groupIn`, importer/classify.ts).
 */
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
 * A connection of the space: a pause is asked first, for every caller and before a plugin's own
 * job: nobody reaches a connection an admin paused. Outside its audience nothing runs, nor an
 * action the connection is not for. Its rules say per kind of action Erlaubt, Mit Freigabe or Nie. On a connection that
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
  if (who.kind === "runtime") {
    return decideRuntime(connection, kind);
  }
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
    const paused = pausedDecision(row);
    if (paused) {
      return paused;
    }
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
        reason: `An AI step only reads as the space: ${VERB[kind]} goes in a tool step.`,
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

/** What the log and „Was darf …?“ say of a connection that pauses. */
export const CONNECTION_PAUSED =
  "The connection is paused: nobody reaches it until an admin resumes it.";

/** The decision for a connection of the space that pauses, whoever calls; null where it does not. */
function pausedDecision(row: Pick<SpaceConnectionRow, "pausedAt">): Decision | null {
  return row.pausedAt
    ? { outcome: "deny", rule: "paused", refused: "paused", reason: CONNECTION_PAUSED }
    : null;
}

/**
 * The runtime reads for nobody in particular: only as the space, only what an admin agreed to on
 * this connection, and only where its rule lets reading run without anyone asked.
 */
function decideRuntime(connection: BrokerConnection, kind: ActionKind): Decision {
  const row = connection.kind === "space_connection" ? connection.row : null;
  if (!row || row.signIn !== "space" || kind !== "read" || row.autonomousMode === "off") {
    return {
      outcome: "deny",
      rule: "autonomous_mode",
      reason: "No admin agreed that the runtime reads this on its own.",
    };
  }
  if (row.rules.read !== "allow") {
    return {
      outcome: "deny",
      rule: "rules.read",
      reason: "The connection's rule: reading does not run on its own.",
    };
  }
  return { outcome: "allow", rule: "autonomous_mode", reason: "An admin agreed to reading it." };
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
  const account = await accountOf(await heldConnection(connection), who);
  return account ? { connector: account.connector, label: account.label } : null;
}

/** The widest the person sees of an input they are asked about. */
const ASK_INPUT = 4000;

/** The rule that decides a call found in `run_effect`, as the log names it. */
const ONCE = "once";
const MAY_HAVE_HAPPENED = "It was interrupted before and may have happened already.";

/**
 * One call through the broker: who, where, which connection and action, with what. Reads the
 * account, decides, asks where the rules say so, runs the action (the connector's, or `handler`)
 * and logs the call, whatever came of it. An error the action throws is logged and thrown on.
 */
export async function brokerCall<T = unknown>(call: BrokerCallInput<T>): Promise<BrokerResult<T>> {
  const started = Date.now();
  const { who, where, ctx = {} } = call;
  // The run may use a connection of the space for a wizard's need: its rules count then.
  let connection = await heldConnection(call.connection);
  const connectionId = connectionIdOf(connection);
  /** What every line of this call says, whatever came of it. */
  const lineOf = (
    kind: ActionKind,
    outcome: Decision["outcome"],
    rule: string | null,
    reason: string,
  ) => ({
    at: new Date(started),
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
  });
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
        ...lineOf(kind, outcome, rule, reason),
        durationMs: Date.now() - started,
        result,
        resultSize: size,
      },
      context,
    );

  // Before anything else: a run that is over calls nothing more, whatever the connection.
  const over = await runOver(where);
  if (over) {
    await line(kindBefore(call), "deny", over.rule, over.reason, "run_ended");
    return { ok: false, refused: "run_ended", reason: over.reason };
  }
  // A connection of the space: whether it pauses, and its limits, are read now, not taken from the
  // row a step or a chat turn read when it started; one that was removed since is gone for them too.
  if (connection.kind === "space_connection") {
    const now = await stateOf(connection.row.id);
    if (!now) {
      const reason = "The connection was removed.";
      await line(kindBefore(call), "deny", null, reason, "not_connected");
      return { ok: false, refused: "not_connected", reason };
    }
    connection = { ...connection, row: { ...connection.row, ...now } };
    const paused = pausedDecision(connection.row);
    if (paused) {
      await line(kindBefore(call), "deny", paused.rule, paused.reason, "paused");
      return { ok: false, refused: "paused", reason: paused.reason };
    }
  }

  // A connection of the space used for the first time is heard of (log.ts, `first_use`).
  const firstUse = connection.kind === "space_connection" && !connection.row.lastUsedAt;

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
  const effectId = kind === "read" ? null : await effectIdOf(where, ctx.effect);
  const effect = effectId ? await findEffect(effectId) : null;
  // It happened: its answer, and no guest's limit, question or second action.
  if (effect?.state === "done") {
    await line(kind, "allow", ONCE, "It happened before.", "already_done", sizeOf(effect.output));
    return {
      ok: true,
      result: effect.output as T,
      account: { connector: account.connector, label: account.label },
    };
  }
  // A guest's send goes only to the run's own address or the space's domains, a post only to the
  // channel its fixed step is fixed to, a few per run and day.
  if (kind === "send" && where.guest) {
    const sent = await guestSendCheck(where, {
      recipients: recipientsOf(call.input, found?.recipientField),
      ...(postsToChannel(account.connector.id, call.action.id)
        ? {
            post: {
              who,
              connectionId,
              actionId: call.action.id,
              channel: channelOf(call.input),
            },
          }
        : {}),
    });
    if (!sent.ok) {
      await line(kind, "deny", "guest_send", sent.reason, sent.refused);
      return { ok: false, refused: sent.refused, reason: sent.reason };
    }
  }
  /** The run's log says it too: that is where a person reads what to check. */
  const sayUnsure = async () => {
    if (call.where.runId && call.where.stepId) {
      const to = (call.input as { to?: unknown } | null)?.to;
      await effectUnsure(call.where.runId, call.where.stepId, {
        tool: found?.summary ?? call.action.id,
        ...(kind === "send" && typeof to === "string" ? { to } : {}),
      });
    }
  };
  // It may have happened: never again without a person's yes, which answers the rule's ask as well.
  const again =
    effect?.state === "started"
      ? await askAgain(ctx.ask, {
          service: account.label,
          actionId: call.action.id,
          summary: found?.summary ?? call.action.id,
          destructive: kind === "destructive",
          input: JSON.stringify(call.input ?? {}, null, 2).slice(0, ASK_INPUT),
        })
      : null;
  if (again === "nobody" || again === "not_again") {
    await (again === "nobody"
      ? line(kind, "deny", ONCE, MAY_HAVE_HAPPENED, "may_have_happened")
      : line(kind, "ask", ONCE, MAY_HAVE_HAPPENED, "declined"));
    await sayUnsure();
    return { ok: false, refused: "may_have_happened", reason: MAY_HAVE_HAPPENED };
  }
  if (decision.outcome === "ask" && decision.admins) {
    // „Mit Freigabe“ as the space: the person's own yes is not enough; an admin's is.
    if (ctx.approved) {
      decision.reason = "An admin of the space approved it.";
    } else {
      await line(kind, "ask", rule, decision.reason, "needs_approval");
      return { ok: false, refused: "needs_approval", reason: decision.reason };
    }
  } else if (again) {
    decision.reason = "The person allowed it again.";
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

  // The call would run. Through a connection of the space with a limit it takes its place first:
  // its line is written now, if the limits leave room, and its end is filled in after.
  let open: OpenLine | null = null;
  if (connection.kind === "space_connection") {
    const { callsPerRun: perRun, callsPerDay: perDay } = connection.row;
    if (perRun !== null || perDay !== null) {
      const place = await takePlace(lineOf(kind, decision.outcome, rule, decision.reason), {
        perRun,
        perDay,
      });
      if ("full" in place) {
        const refused = place.full === "run" ? CALLS_PER_RUN : CALLS_PER_DAY;
        const reason =
          place.full === "run"
            ? `The connection takes ${perRun} calls from one run, and this run has made them.`
            : `The connection takes ${perDay} calls a day, and today's are made.`;
        await line(kind, "deny", `limits.${place.full}`, reason, refused, null, {
          limitHeard: await limitHeard(connectionId, place.full, where.runId ?? null),
        });
        return { ok: false, refused, reason };
      }
      open = place;
    }
  }
  /** The call's end: on the line that took its place, else as a line of its own. */
  const end = (result: string, size: number | null = null, context: LineContext = {}) =>
    open
      ? closeLine(open, { durationMs: Date.now() - started, result, resultSize: size }, context)
      : line(kind, decision.outcome, rule, decision.reason, result, size, context);

  // The row comes before the action, so a crash in between finds that it may have happened.
  if (effectId && !again) {
    const taken = await startEffect({
      id: effectId,
      runId: where.runId as string,
      stepId: where.stepId as string,
      tool: `${connectionId}:${call.action.id}`,
    });
    if (!taken) {
      await (open
        ? end("may_have_happened")
        : line(kind, "deny", ONCE, MAY_HAVE_HAPPENED, "may_have_happened"));
      await sayUnsure();
      return { ok: false, refused: "may_have_happened", reason: MAY_HAVE_HAPPENED };
    }
  }
  const acting = effectId
    ? { ...account, ctx: { ...account.ctx, idempotencyKey: effectId } }
    : account;
  try {
    const result = call.handler
      ? await call.handler(acting)
      : ((await (found as ConnectorAction).handler(call.input ?? {}, acting.ctx)) as T);
    if (effectId) {
      await effectDone(effectId, result);
    }
    // A line that took its place is always closed; else a pull that found nothing says nothing.
    if (open || !call.quietWhen?.(result)) {
      await end("ok", sizeOf(result), { firstUse });
    }
    if (connection.kind === "space_connection") {
      await markUsed(connection.row);
    }
    return { ok: true, result, account: { connector: account.connector, label: account.label } };
  } catch (err) {
    if (effectId) {
      await effectThrew(effectId, err);
    }
    // The service turned the sign-in down: heard of, like a sign-in that ran out.
    const result = signInRefused(err)
      ? SIGN_IN_FAILED
      : err instanceof Error
        ? err.constructor.name || "Error"
        : "Error";
    await end(result);
    throw err;
  }
}

/**
 * An action's kind before the account is read: what the caller says, else what the connector of
 * a connection of the space says; a wizard's own connection names its connector only once its
 * account is read, so an action of unknown kind counts as a write there.
 */
function kindBefore<T>(call: BrokerCallInput<T>): ActionKind {
  if (call.action.kind) {
    return call.action.kind;
  }
  const { connection } = call;
  const found =
    connection.kind === "space_connection"
      ? connection.connector.actions.find((a) => a.id === call.action.id)
      : undefined;
  return found ? kindOf(found.group) : "write";
}

/**
 * The next items of a connector's stream, from `cursor`: the one way to a mailbox's stream, logged
 * like any call. `since` is where a pull without a cursor starts. An error the connector throws,
 * like its expired cursor, is thrown on.
 */
export function brokerPullStream(input: {
  connection: Extract<BrokerConnection, { kind: "space_connection" }>;
  cursor: string | null;
  since: Date;
  limit: number;
}): Promise<BrokerResult<StreamPullResult>> {
  const { connection, cursor, since, limit } = input;
  return brokerCall({
    who: { kind: "runtime" },
    where: { spaceId: connection.row.spaceId },
    connection,
    action: { id: "pull_stream", kind: "read" },
    input: { since: since.toISOString(), limit },
    // A read every minute that found nothing says nothing. What it found and what failed stay.
    quietWhen: (result) => (result as StreamPullResult).items.length === 0,
    handler: ({ connector, ctx }) => {
      if (!connector.stream) {
        throw new Error(`${connector.name} has no stream.`);
      }
      return connector.stream.pull({ ...ctx, since: since.toISOString(), limit }, cursor);
    },
  });
}

/** One mail of a connector's stream by its id, for a run that comes to it later. Logged like a pull. */
export function brokerReadMessage(input: {
  connection: Extract<BrokerConnection, { kind: "space_connection" }>;
  message: string;
}): Promise<BrokerResult<InboundMessage | null>> {
  const { connection, message } = input;
  return brokerCall({
    who: { kind: "runtime" },
    where: { spaceId: connection.row.spaceId },
    connection,
    action: { id: "read_message", kind: "read" },
    input: { message },
    handler: ({ connector, ctx }) => {
      if (!connector.stream?.read) {
        throw new Error(`${connector.name} can't read one message.`);
      }
      return connector.stream.read({ ...ctx, since: new Date(0).toISOString(), limit: 1 }, message);
    },
  });
}

/** Whether the service answered a call with "who are you?": its 401, or an OAuth grant gone. */
export function signInRefused(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return /(^|\D)401(\D|$)|invalid_grant|unauthori[sz]ed|token (has )?expired/i.test(text);
}

export type SecretResult<T> =
  | { ok: true; result: T }
  | { ok: false; refused: "run_ended"; reason: string };

/**
 * A secret of a run's store that is no connection (the browser's kept sign-ins), read through
 * the broker as a `read`: the handler alone sees it, and the call is logged like any other. A run
 * that is over reads none.
 */
export async function brokerSecret<S, T>(call: {
  who: Who;
  where: Where;
  scope: StoreScope;
  slot: string;
  handler: (secret: S | null) => Promise<T>;
}): Promise<SecretResult<T>> {
  const started = Date.now();
  const line = (
    result: string,
    decided: { outcome: "allow" | "deny"; rule: string; reason: string } = {
      outcome: "allow",
      rule: "read",
      reason: "Reading is allowed.",
    },
  ) =>
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
      ...decided,
      result,
      resultSize: null,
    });
  // A run that is over reads no secret: the handler does not run.
  const over = await runOver(call.where);
  if (over) {
    await line("run_ended", { outcome: "deny", ...over });
    return { ok: false, refused: "run_ended", reason: over.reason };
  }
  const kept = await keptSecret<S>(call.scope, call.slot);
  try {
    const result = await call.handler(kept?.data ?? null);
    await line(kept ? "ok" : "not_connected");
    return { ok: true, result };
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
