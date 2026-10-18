import {
  MAIL_SENDERS,
  MailTooLarge,
  sendAsAccount,
  sendFromServer,
  serverSender,
} from "../../connectors/smtp.js";
import { megabytes } from "../files.js";
import { line, ShareError, type ShareTarget } from "../types.js";

/** What mail providers take in one message, with room for the encoding. */
const ATTACH_LIMIT = 18_000_000;
/** From the server's own address, people without an account send this much per run. */
const VISITOR_MAILS = 3;
const VISITOR_RECIPIENTS = 3;
const RECIPIENTS = 20;

const ADDRESS = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

/** "a@b.at, c@d.at; e@f.at" → the addresses; throws on one that is none. */
export function parseRecipients(raw: string): string[] {
  const list = raw
    .split(/[\s,;]+/)
    .map((a) => a.trim())
    .filter(Boolean);
  const bad = list.find((a) => !ADDRESS.test(a));
  if (bad) {
    throw new ShareError(line("shareNotAnAddress", { address: bad }));
  }
  return [...new Set(list)];
}

/**
 * The result by e-mail: the picked files as attachments. Sent from the mailbox the person
 * connects (Gmail, Outlook, or any mailbox over SMTP) — or, where the server has an address of
 * its own, without any account.
 */
export const emailTarget: ShareTarget = {
  id: "email",
  name: line("shareEmailName"),
  description: line("shareEmailDescription"),
  icon: "mail",
  takes: "files",
  connection: () =>
    serverSender()
      ? null
      : {
          id: "share:email",
          target: { connectors: [...MAIL_SENDERS] },
          actions: ["send_message"],
          title: "E-Mail",
        },
  fields: [
    {
      id: "to",
      kind: "emails",
      required: true,
      label: line("shareTo"),
      placeholder: line("shareToPlaceholder"),
    },
    { id: "subject", kind: "text", required: true, label: line("shareSubject") },
    { id: "message", kind: "textarea", label: line("shareMessage") },
  ],
  defaults: (scope) => ({ subject: scope.title, message: scope.message ?? "" }),
  async send({ values, files }, ctx) {
    const to = parseRecipients(values.to ?? "");
    if (!to.length) {
      throw new ShareError(line("shareNoAddress"));
    }
    if (to.length > RECIPIENTS) {
      throw new ShareError(line("shareTooManyAddresses", { max: RECIPIENTS }));
    }
    const size = files.reduce((n, f) => n + f.data.byteLength, 0);
    if (size > ATTACH_LIMIT) {
      throw new ShareError(line("shareAttachmentsTooLarge", { size: megabytes(size) }));
    }
    const message = {
      to,
      subject: (values.subject ?? "").trim() || ctx.title,
      text: (values.message ?? "").trim(),
      attachments: files.map((f) => ({ name: f.name, mime: f.mime, data: f.data })),
    };
    const account = await ctx.account();
    if (account) {
      await ctx.emit(line("shareSendingFrom", { account: account.label }));
      try {
        await sendAsAccount(account.connector, account.ctx, message);
      } catch (err) {
        if (err instanceof MailTooLarge) {
          throw new ShareError(line("shareMailboxLimit"));
        }
        throw err;
      }
    } else if (serverSender()) {
      // The server's address is everyone's to send from: a visitor gets a few mails per run.
      if (!ctx.member && (ctx.sentBefore >= VISITOR_MAILS || to.length > VISITOR_RECIPIENTS)) {
        throw new ShareError(
          line("shareVisitorMails", { mails: VISITOR_MAILS, recipients: VISITOR_RECIPIENTS }),
        );
      }
      await ctx.emit(line("shareSendingFrom", { account: serverSender() ?? "" }));
      await sendFromServer(message);
    } else {
      throw new ShareError(line("shareConnectMailbox"));
    }
    return { summary: line("shareSentTo", { to: to.join(", ") }) };
  },
};
