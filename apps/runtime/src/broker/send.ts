import { and, eq, gte, inArray, isNull, notLike, or } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import type { Refusal, Where, Who } from "./call.js";
import { channelInGrant, type Grant, grantOf } from "./grant.js";
import { summarizeInput, writeLog } from "./log.js";

/*
 * Sends from a guest's run (docs/plans/capabilities.md, A6; rule 7 of the connections plan): a
 * mail leaves only for an address the run itself collected — what the person typed into a page
 * field of kind `email` — or for an address in one of the space's own mail domains. A post to a
 * channel (Slack) leaves only from a fixed step, for the channel the published definition fixes
 * (the run's grant). A run sends a few, a wizard's guests a number per day the wizard sets, mails
 * and posts together. Everything beyond is refused and logged as critical. Members' runs are not
 * bound: they send as they always did.
 */

/** Mails and posts one guest's run sends, from any address. */
export const GUEST_MAILS_PER_RUN = 3;

export type SendRefusal = Extract<
  Refusal,
  "not_allowed_recipient" | "channel_not_fixed" | "run_limit" | "day_limit"
>;

export type SendCheck = { ok: true } | { ok: false; refused: SendRefusal; reason: string };

/**
 * The sends that go to a channel and name no address, by connector: the actions whose input
 * names the channel as `channel`. Slack's post is the one.
 */
const CHANNEL_POSTS: Record<string, readonly string[]> = { slack: ["post_message"] };

/** Whether this action of this connector posts to a channel. */
export function postsToChannel(connectorId: string, actionId: string): boolean {
  return CHANNEL_POSTS[connectorId]?.includes(actionId) ?? false;
}

/** The channel a post's input names; null where it names none. */
export function channelOf(input: unknown): string | null {
  const channel =
    input && typeof input === "object" ? (input as Record<string, unknown>).channel : null;
  return typeof channel === "string" && channel.trim() ? channel.trim() : null;
}

/** A guest's post, as the log and „Was darf …?“ say it. */
export const FIXED_CHANNEL_ONLY =
  "A guest's run posts only from a fixed step, to the channel its published step fixes.";

/**
 * Whether a guest's run may post to this channel, with no side effect: only its fixed step
 * posts, and only to the channel the grant fixes for that step. The grant comes from the
 * published definition, so nothing the guest typed decides it.
 */
export function guestPostCheck(post: {
  who: Who;
  where: Where;
  connectionId: string;
  actionId: string;
  channel: string | null;
  grant: Grant;
}): SendCheck {
  const { where, connectionId, actionId, channel } = post;
  const fixed =
    post.who.kind === "step" &&
    !!where.stepId &&
    !!channel &&
    channelInGrant(post.grant, where.stepId, { connectionId, actionId, channel });
  return fixed
    ? { ok: true }
    : { ok: false, refused: "channel_not_fixed", reason: FIXED_CHANNEL_ONLY };
}

const ADDRESS = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

/**
 * The addresses a send's input names: the field the connector's action names as the recipient's
 * (an imported connector: what an admin said, `body.to` for one inside an HTTP body), and `to`,
 * `cc`, `bcc`, `recipients`, as strings, lists or objects. The named field comes on top of the
 * guess, never in place of it: an address in `cc` is still one the send goes to.
 */
export function recipientsOf(input: unknown, field?: string): string[] {
  if (!input || typeof input !== "object") {
    return [];
  }
  const found = new Set<string>();
  const take = (value: unknown) => {
    if (typeof value === "string") {
      for (const part of value.split(/[\s,;]+/)) {
        const address = part
          .replace(/^.*<|>$/g, "")
          .trim()
          .toLowerCase();
        if (address) {
          found.add(address);
        }
      }
    } else if (Array.isArray(value)) {
      value.forEach(take);
    } else if (value && typeof value === "object") {
      const o = value as Record<string, unknown>;
      take(o.email ?? o.address ?? o.emailAddress);
    }
  };
  if (field) {
    let value: unknown = input;
    for (const part of field.split(".")) {
      value = value && typeof value === "object" ? (value as Record<string, unknown>)[part] : null;
    }
    take(value);
  }
  for (const key of ["to", "cc", "bcc", "recipients", "recipient"]) {
    take((input as Record<string, unknown>)[key]);
  }
  return [...found];
}

/** The domain of an address, lower case; null for what is no address. */
const domainOf = (address: string) =>
  ADDRESS.test(address) ? address.slice(address.lastIndexOf("@") + 1).toLowerCase() : null;

/**
 * The addresses a run collected: what its page fields of kind `email` hold. Nothing confirms an
 * address today, so the field's value counts as the run's own.
 */
export function runAddresses(run: {
  definition: { steps: { type: string; fields?: { id: string; kind: string }[] }[] };
  state: { values: Record<string, unknown> };
}): string[] {
  const own = new Set<string>();
  for (const step of run.definition.steps) {
    if (step.type !== "page") {
      continue;
    }
    for (const field of step.fields ?? []) {
      const value = run.state.values[field.id];
      if (field.kind === "email" && typeof value === "string" && ADDRESS.test(value.trim())) {
        own.add(value.trim().toLowerCase());
      }
    }
  }
  return [...own];
}

/** Whether an address is in one of the space's mail domains, or below one. */
export function inMailDomains(address: string, domains: string[]): boolean {
  const domain = domainOf(address);
  return (
    !!domain &&
    domains.some((d) => {
      const own = d.trim().toLowerCase();
      return own && (domain === own || domain.endsWith(`.${own}`));
    })
  );
}

/** Today's first moment, as the per-day count sees it. */
const startOfToday = () => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
};

/**
 * How often guests sent through this run, and through this wizard today: mails and posts, a
 * guest's own and those of the fixed steps of guests' runs.
 */
async function guestSends(where: Where): Promise<{ run: number; day: number }> {
  // A request to a host is a send too, counted nowhere here.
  const sent = and(
    eq(schema.brokerLog.kind, "send"),
    eq(schema.brokerLog.result, "ok"),
    notLike(schema.brokerLog.connectionId, "host:%"),
  );
  // A fixed step is logged as `step`: it counts where its run is a guest's.
  const guestRuns = (wizardId: string) =>
    db
      .select({ id: schema.run.id })
      .from(schema.run)
      .where(
        and(
          eq(schema.run.wizardId, wizardId),
          eq(schema.run.mode, "live"),
          isNull(schema.run.userId),
        ),
      );
  const [inRun, today] = await Promise.all([
    where.runId
      ? db.$count(
          schema.brokerLog,
          and(
            sent,
            eq(schema.brokerLog.runId, where.runId),
            inArray(schema.brokerLog.whoKind, ["guest", "step"]),
          ),
        )
      : 0,
    where.wizardId
      ? db.$count(
          schema.brokerLog,
          and(
            sent,
            eq(schema.brokerLog.wizardId, where.wizardId),
            gte(schema.brokerLog.at, startOfToday()),
            or(
              eq(schema.brokerLog.whoKind, "guest"),
              and(
                eq(schema.brokerLog.whoKind, "step"),
                inArray(schema.brokerLog.runId, guestRuns(where.wizardId)),
              ),
            ),
          ),
        )
      : 0,
  ]);
  return { run: inRun, day: today };
}

/** What a guest's send names: addresses, and for a post to a channel who posts through what. */
export interface GuestSend {
  /** The addresses the send names (`recipientsOf`). */
  recipients: string[];
  /** A post to a channel (`postsToChannel`): the caller, the connection and action, the channel. */
  post?: { who: Who; connectionId: string; actionId: string; channel: string | null };
}

/**
 * Whether a guest's run may send this now: each address the run's own or in the space's domains,
 * a post only to the channel its fixed step is fixed to, and the run and the wizard under their
 * caps. The run, the wizard and the space are read here; a run or wizard not known refuses.
 */
export async function guestSendCheck(where: Where, send: GuestSend): Promise<SendCheck> {
  const { recipients, post } = send;
  const refuse = (refused: SendRefusal, reason: string): SendCheck => ({
    ok: false,
    refused,
    reason,
  });
  if (!(recipients.length || post)) {
    return refuse("not_allowed_recipient", "The send names no recipient.");
  }
  const run = where.runId
    ? await db.query.run.findFirst({
        where: eq(schema.run.id, where.runId),
        columns: { definition: true, state: true, wizardId: true, grant: true },
      })
    : null;
  if (!run) {
    return refuse("not_allowed_recipient", "The run is not known here.");
  }
  if (post) {
    // A run from before grants were kept: the grant its definition gives (grant.ts, `runGrant`).
    const fixed = guestPostCheck({ ...post, where, grant: run.grant ?? grantOf(run.definition) });
    if (!fixed.ok) {
      return fixed;
    }
  }
  const wizard = await db.query.wizard.findFirst({
    where: eq(schema.wizard.id, run.wizardId),
    columns: { spaceId: true, dailyMailLimit: true },
  });
  if (recipients.length) {
    const space = wizard
      ? await db.query.space.findFirst({
          where: eq(schema.space.id, wizard.spaceId),
          columns: { mailDomains: true },
        })
      : null;
    const own = runAddresses(run);
    const domains = space?.mailDomains ?? [];
    const foreign = recipients.find(
      (address) => !(own.includes(address.toLowerCase()) || inMailDomains(address, domains)),
    );
    if (foreign) {
      return refuse(
        "not_allowed_recipient",
        `A guest's run sends only to its own address or the space's domains, not to ${foreign}.`,
      );
    }
  }
  const sent = await guestSends({ ...where, wizardId: where.wizardId ?? run.wizardId });
  if (sent.run >= GUEST_MAILS_PER_RUN) {
    return refuse("run_limit", `This run has sent its ${GUEST_MAILS_PER_RUN} mails and posts.`);
  }
  const perDay = wizard?.dailyMailLimit ?? 50;
  if (sent.day >= perDay) {
    return refuse("day_limit", `This wizard's guests have sent today's ${perDay} mails and posts.`);
  }
  return { ok: true };
}

export type SendResult<T> =
  | { ok: true; result: T }
  | { ok: false; refused: SendRefusal; reason: string };

/**
 * A mail from the server's own address, which no account holds: the one send that is not a
 * connector's action. A guest's run is bound by the rules above; the call is logged like any
 * other, under the connection `mail:server`.
 */
export async function brokerSend<T>(call: {
  who: Who;
  where: Where;
  recipients: string[];
  input: unknown;
  handler: () => Promise<T>;
}): Promise<SendResult<T>> {
  const started = Date.now();
  const { who, where } = call;
  const line = (outcome: "allow" | "deny", reason: string, result: string) =>
    writeLog({
      at: new Date(started),
      durationMs: Date.now() - started,
      whoKind: who.kind,
      whoId: who.id ?? null,
      runId: where.runId ?? null,
      stepId: where.stepId ?? null,
      chatId: where.chatId ?? null,
      wizardId: where.wizardId ?? null,
      spaceId: where.spaceId ?? null,
      connectionId: "mail:server",
      actionId: "send_message",
      kind: "send",
      inputSummary: summarizeInput(call.input),
      outcome,
      rule: "guest_send",
      reason,
      result,
      resultSize: null,
    });
  let reason = "The server's address sends for members.";
  if (where.guest) {
    const check = await guestSendCheck(where, { recipients: call.recipients });
    if (!check.ok) {
      await line("deny", check.reason, check.refused);
      return check;
    }
    reason = "The recipients are the run's own or the space's.";
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
