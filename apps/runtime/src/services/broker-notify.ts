import type { Lang } from "@engenty/wizards-shared/definition";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { linkedAccount } from "../auth/account.js";
import { brokerCall, type LoggedRow } from "../broker/index.js";
import {
  MAIL_SENDERS,
  type MailToSend,
  sendAsAccount,
  sendFromServer,
  serverSender,
} from "../connectors/smtp.js";
import { connectorOfRow } from "../connectors/space-connections.js";
import { db, schema } from "../db/client.js";
import { env } from "../env.js";
import { managed, tenantMembers } from "../manage.js";
import { currentTenant } from "../tenants/tenant.js";
import { type ServerKey, serverText } from "../texts.js";
import { isAdminRole } from "./access.js";
import { criticalOfSpace } from "./broker-bell.js";
import { anySeenSince } from "./seen.js";

/**
 * The hourly mail to a space's admins (docs/plans/broker.md, "Notifications"): the broker's
 * critical lines since the last mail, sent only where none of the admins was in the app
 * meanwhile – they saw the bell then. Through the space's own mail connection where one signs in
 * as the space, else from the server's address; where there is neither, nothing goes out. The
 * space's `notify.mail` turns it off.
 */

const HOUR_MS = 3600_000;
/** How many lines one mail carries at most. */
const LINES = 50;

/** An admin of the tenant who gets the mail. */
interface Admin {
  userId: string;
  email: string;
}

/** The tenant's owners and admins: what the Manage-App says; on a computer, the linked account. */
async function adminsOf(): Promise<Admin[]> {
  if (managed) {
    const people = await tenantMembers(currentTenant());
    return people.members
      .filter((m) => isAdminRole(m.role) && m.email)
      .map((m) => ({ userId: m.userId, email: m.email }));
  }
  const account = await linkedAccount();
  return account?.email ? [{ userId: account.userId, email: account.email }] : [];
}

/** One line of the mail: when, who, what, which rule. */
function lineOf(row: LoggedRow, lang: Lang): string {
  const at = row.at.toISOString().slice(11, 16);
  const who = row.whoId ? `${row.whoKind} ${row.whoId}` : row.whoKind;
  const kind = serverText(lang, `criticalKind.${row.criticalKind ?? "refused_write"}` as ServerKey);
  const what = `${row.connectionId} · ${row.actionId}`;
  return `${at}  ${kind}: ${who} → ${what}${row.reason ? ` – ${row.reason}` : ""}`;
}

/** The mail for a space's lines. */
export function criticalMail(
  space: { id: string; name: string },
  rows: LoggedRow[],
  to: string[],
  lang: Lang,
): MailToSend {
  const shown = rows.slice(0, LINES);
  const lines = shown.map((r) => `- ${lineOf(r, lang)}`).join("\n");
  const more =
    rows.length > shown.length
      ? `\n${serverText(lang, "criticalMailMore", { count: rows.length - shown.length })}`
      : "";
  return {
    to,
    subject: serverText(lang, "criticalMailSubject", { space: space.name, count: rows.length }),
    text: `${serverText(lang, "criticalMailIntro", { space: space.name })}\n\n${lines}${more}\n\n${serverText(lang, "criticalMailOutro", { url: `${env.publicUrl}/work/waiting` })}`,
  };
}

/** The space's mail connection the mail goes through: signs in as the space, signed in, a mail sender. */
async function mailConnectionOf(spaceId: string) {
  return db.query.spaceConnection.findFirst({
    where: and(
      eq(schema.spaceConnection.spaceId, spaceId),
      eq(schema.spaceConnection.signIn, "space"),
      inArray(schema.spaceConnection.connectorId, [...MAIL_SENDERS]),
      isNotNull(schema.spaceConnection.secret),
    ),
  });
}

/** Sends through the space's mail connection, as the admins; else from the server's address. */
async function deliver(
  spaceId: string,
  message: MailToSend,
): Promise<"connection" | "server" | "nobody"> {
  const row = await mailConnectionOf(spaceId);
  if (row) {
    const sent = await brokerCall({
      who: { kind: "admin" },
      where: { spaceId },
      connection: { kind: "space_connection", row, connector: await connectorOfRow(row) },
      action: { id: "send_message", kind: "send" },
      input: { to: message.to, subject: message.subject },
      ctx: { approved: true, confirmed: true },
      handler: (held) => sendAsAccount(held.connector, held.ctx, message),
    }).catch((err: Error) => {
      console.warn(`[broker] the mail through ${row.name} failed:`, err.message);
      return null;
    });
    if (sent?.ok) {
      return "connection";
    }
  }
  if (serverSender()) {
    await sendFromServer(message);
    return "server";
  }
  return "nobody";
}

export interface MailRound {
  sent: string[];
  skipped: string[];
}

/**
 * One round for the current tenant: each space with the mail on, its lines since the last round,
 * the mail where no admin was here since. A round sets the space's mark whether it mailed or
 * skipped, so the next one starts there.
 */
export async function sendCriticalMails(now = new Date()): Promise<MailRound> {
  const round: MailRound = { sent: [], skipped: [] };
  const spaces = await db.query.space.findMany({
    where: eq(schema.space.tenantId, currentTenant()),
    columns: { id: true, name: true, notify: true, criticalMailedAt: true, page: true },
  });
  let admins: Admin[] | null = null;
  for (const space of spaces) {
    if (space.notify.mail !== "hourly") {
      continue;
    }
    const since = space.criticalMailedAt ?? new Date(now.getTime() - HOUR_MS);
    const rows = (await criticalOfSpace(space.id, since)).filter((r) => r.at <= now);
    if (!rows.length) {
      continue;
    }
    admins ??= await adminsOf().catch(() => []);
    const mark = () =>
      db.update(schema.space).set({ criticalMailedAt: now }).where(eq(schema.space.id, space.id));
    if (
      !admins.length ||
      (await anySeenSince(
        admins.map((a) => a.userId),
        since,
      ))
    ) {
      await mark();
      round.skipped.push(space.id);
      continue;
    }
    const lang: Lang = space.page?.lang === "de" ? "de" : "en";
    const message = criticalMail(
      space,
      rows,
      admins.map((a) => a.email),
      lang,
    );
    const via = await deliver(space.id, message).catch((err: Error) => {
      console.warn(`[broker] the hourly mail for ${space.name} was not sent:`, err.message);
      return "nobody" as const;
    });
    await mark();
    (via === "nobody" ? round.skipped : round.sent).push(space.id);
  }
  return round;
}
