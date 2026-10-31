import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { z } from "zod";
import type {
  ConnectorActionContext,
  ConnectorDefinition,
} from "../engenty/connections-sdk/types.js";
import { env } from "../env.js";
import { assertPublicUrl } from "../tools/net-guard.js";

/**
 * Sending mail: through any mailbox over SMTP (a connector the person connects with address and
 * app password), through the Gmail or Outlook account they signed in to, or — when the server
 * has an address of its own (`SMTP_URL`) — without any account.
 */

export interface MailToSend {
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
  attachments?: { name: string; mime: string; data: Uint8Array }[];
}

/** What the connect form collects; stored encrypted and handed to actions as `ctx.accessToken`. */
interface SmtpCredentials {
  email: string;
  password: string;
  host?: string;
  port?: string;
}

const KNOWN_HOSTS: Record<string, string> = {
  "gmail.com": "smtp.gmail.com",
  "googlemail.com": "smtp.gmail.com",
  "outlook.com": "smtp-mail.outlook.com",
  "hotmail.com": "smtp-mail.outlook.com",
  "live.com": "smtp-mail.outlook.com",
  "icloud.com": "smtp.mail.me.com",
  "me.com": "smtp.mail.me.com",
  "yahoo.com": "smtp.mail.yahoo.com",
  "gmx.at": "mail.gmx.net",
  "gmx.de": "mail.gmx.net",
  "gmx.net": "mail.gmx.net",
  "web.de": "smtp.web.de",
  "a1.net": "securemail.a1.net",
  "fastmail.com": "smtp.fastmail.com",
};

const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE_FETCH === "1";

async function transportOf(credentials: SmtpCredentials) {
  const email = credentials.email.trim();
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  const host = credentials.host?.trim() || KNOWN_HOSTS[domain] || `smtp.${domain}`;
  const port = Number(credentials.port) || 587;
  if (!ALLOW_PRIVATE && port !== 587 && port !== 465) {
    throw new Error("SMTP runs on port 587 (or 465).");
  }
  // The host is typed by the person: it must be a public mail server, never this server's network.
  if (!ALLOW_PRIVATE) {
    await assertPublicUrl(`https://${host}`);
  }
  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user: email, pass: credentials.password },
    connectionTimeout: 20_000,
    socketTimeout: 60_000,
    ...(ALLOW_PRIVATE ? { tls: { rejectUnauthorized: false } } : {}),
  });
}

/** A failed sign-in reads the same whichever mail library met it. */
function asConnectError(err: unknown): unknown {
  const e = err as { code?: string; responseCode?: number };
  if (e?.code === "EAUTH" || e?.responseCode === 535) {
    return Object.assign(new Error("authentication failed"), { authenticationFailed: true });
  }
  if (e?.code === "EDNS" || e?.code === "ESOCKET" || e?.code === "ECONNECTION") {
    return Object.assign(new Error("server not reachable"), { code: "ENOTFOUND" });
  }
  return err;
}

const address = (list: string[]) => list.map((a) => a.trim()).filter(Boolean);

function mailOptions(message: MailToSend, from?: string) {
  return {
    ...(from ? { from } : {}),
    to: address(message.to),
    cc: address(message.cc ?? []),
    subject: message.subject,
    text: message.text,
    attachments: (message.attachments ?? []).map((a) => ({
      filename: a.name,
      contentType: a.mime,
      content: Buffer.from(a.data),
    })),
  };
}

/** The message as RFC 822 bytes, for providers that take a finished mail (Gmail, Outlook). */
export function mimeOf(message: MailToSend): Promise<Buffer> {
  return new MailComposer(mailOptions(message)).compile().build();
}

async function sendSmtp(credentials: SmtpCredentials, message: MailToSend) {
  const transport = await transportOf(credentials);
  try {
    await transport.sendMail(mailOptions(message, credentials.email.trim()));
  } finally {
    transport.close();
  }
}

// --- the server's own address -------------------------------------------------

/** The address the server sends from when `SMTP_URL` is set, else null. */
export function serverSender(): string | null {
  return env.mail.smtpUrl ? env.mail.from || null : null;
}

/** Sends from the server's own address: nobody has to connect a mailbox. */
export async function sendFromServer(message: MailToSend) {
  const from = serverSender();
  if (!from) {
    throw new Error("This server has no address to send from.");
  }
  const transport = nodemailer.createTransport(env.mail.smtpUrl);
  try {
    await transport.sendMail(mailOptions(message, from));
  } finally {
    transport.close();
  }
}

// --- the person's own account --------------------------------------------------

/** Graph takes a finished mail only up to its request limit of 4 MB (base64 of the bytes). */
const OUTLOOK_MIME_LIMIT = 2_900_000;

/** The connectors a mail can be sent with, as the person's own account. */
export const MAIL_SENDERS = ["smtp", "google-gmail", "microsoft-outlook"] as const;

/** Sends as the connected account, whichever connector it was connected with. */
export async function sendAsAccount(
  connector: ConnectorDefinition,
  ctx: ConnectorActionContext,
  message: MailToSend,
) {
  if (connector.id === "smtp") {
    await sendSmtp(JSON.parse(ctx.accessToken) as SmtpCredentials, message);
    return;
  }
  const mime = await mimeOf(message);
  if (connector.id === "google-gmail") {
    const res = await ctx.fetchImpl(
      "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${ctx.accessToken}`, "Content-Type": "message/rfc822" },
        body: new Uint8Array(mime),
      },
    );
    if (!res.ok) {
      throw new Error(`Gmail (${res.status}): ${(await res.text()).slice(0, 200)}`);
    }
    return;
  }
  if (connector.id === "microsoft-outlook") {
    if (mime.byteLength > OUTLOOK_MIME_LIMIT) {
      throw new MailTooLarge();
    }
    const res = await ctx.fetchImpl("https://graph.microsoft.com/v1.0/me/sendMail", {
      method: "POST",
      headers: { Authorization: `Bearer ${ctx.accessToken}`, "Content-Type": "text/plain" },
      body: mime.toString("base64"),
    });
    if (!res.ok) {
      throw new Error(`Outlook (${res.status}): ${(await res.text()).slice(0, 200)}`);
    }
    return;
  }
  throw new Error(`${connector.name} cannot send mail.`);
}

/** The attachments are more than the account's provider takes in one mail. */
export class MailTooLarge extends Error {}

// --- the connector ----------------------------------------------------------------

const sendInput = z.object({
  to: z.array(z.string().min(3)).min(1).max(20).describe("Recipient addresses."),
  cc: z.array(z.string().min(3)).max(20).optional(),
  subject: z.string().describe("Subject line."),
  body_text: z.string().describe("Plain-text body."),
  attachment_base64: z
    .string()
    .optional()
    .describe("One attachment: `file:<path>` of a kept file or `upload:<id>`."),
  attachment_name: z.string().optional().describe("File name of the attachment."),
});

export const smtpConnector: ConnectorDefinition = {
  id: "smtp",
  moduleId: "wizards-mail",
  name: "E-Mail (SMTP)",
  description: "Send mail from any mailbox over SMTP (GMX, iCloud, your own domain …).",
  icon: "mail",
  toolPrefix: "smtp",
  auth: {
    kind: "api_key",
    apiKey: {
      fields: [
        { key: "email", label: "Email address", placeholder: "name@company.com" },
        { key: "password", label: "Password or app password", secret: true },
        {
          key: "host",
          label: "SMTP server",
          placeholder: "leave empty for Gmail, GMX, iCloud …",
          required: false,
        },
        { key: "port", label: "Port", placeholder: "587", required: false },
      ],
      verify: async (credentials) => {
        const transport = await transportOf(credentials as unknown as SmtpCredentials);
        try {
          await transport.verify();
        } catch (err) {
          throw asConnectError(err);
        } finally {
          transport.close();
        }
        return { label: credentials.email.trim(), externalId: credentials.email.trim() };
      },
    },
  },
  actions: [
    {
      id: "send_message",
      summary: "Send an e-mail",
      description:
        "Send an e-mail from the connected mailbox right away (plain text, one optional attachment). Irreversible.",
      group: "send",
      inputSchema: sendInput,
      handler: async (raw, ctx) => {
        const input = sendInput.parse(raw);
        await sendSmtp(JSON.parse(ctx.accessToken) as SmtpCredentials, {
          to: input.to,
          cc: input.cc,
          subject: input.subject,
          text: input.body_text,
          attachments: input.attachment_base64
            ? [
                {
                  name: input.attachment_name || "attachment",
                  mime: "application/octet-stream",
                  data: Buffer.from(input.attachment_base64, "base64"),
                },
              ]
            : [],
        });
        return { sent: true, to: input.to, subject: input.subject };
      },
    },
  ],
};
