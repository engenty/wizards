import { resolveMx } from "node:dns/promises";
import { ImapFlow, type MessageStructureObject, type SearchObject } from "imapflow";
import type {
  ConnectorActionContext,
  ConnectorDefinition,
} from "../engenty/connections-sdk/types.js";
import { htmlToMarkdown } from "../render/convert.js";
import { assertPublicUrl } from "../tools/net-guard.js";
import {
  dayAfter,
  type MailAttachmentInfo,
  type MailBackend,
  type MailMessage,
  mailActions,
  snippetOf,
} from "./mail.js";

/** What the connect form collects; stored encrypted and handed to actions as `ctx.accessToken`. */
interface ImapCredentials {
  email: string;
  password: string;
  host?: string;
  port?: string;
}

const KNOWN_HOSTS: Record<string, string> = {
  "gmail.com": "imap.gmail.com",
  "googlemail.com": "imap.gmail.com",
  "outlook.com": "outlook.office365.com",
  "hotmail.com": "outlook.office365.com",
  "live.com": "outlook.office365.com",
  "icloud.com": "imap.mail.me.com",
  "me.com": "imap.mail.me.com",
  "yahoo.com": "imap.mail.yahoo.com",
  "gmx.at": "imap.gmx.net",
  "gmx.de": "imap.gmx.net",
  "gmx.net": "imap.gmx.net",
  "web.de": "imap.web.de",
  "a1.net": "securemail.a1.net",
  "fastmail.com": "imap.fastmail.com",
};

const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE_FETCH === "1";

/** A mail server that does not answer within this long is reported, not waited for. */
const CONNECT_TIMEOUT_MS = 15_000;

/** Google Workspace on a company domain: the domain's mail is handled by Google. */
async function usesGoogleMail(domain: string): Promise<boolean> {
  try {
    const records = await Promise.race([
      resolveMx(domain),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("mx")), 4000)),
    ]);
    return records.some((r) => /(^|\.)(google|googlemail)\.com\.?$/i.test(r.exchange));
  } catch {
    return false;
  }
}

async function hostFor(credentials: ImapCredentials, domain: string): Promise<string> {
  const typed = credentials.host?.trim();
  if (typed) {
    return typed;
  }
  if (KNOWN_HOSTS[domain]) {
    return KNOWN_HOSTS[domain];
  }
  return (await usesGoogleMail(domain)) ? "imap.gmail.com" : `imap.${domain}`;
}

async function open(credentials: ImapCredentials): Promise<ImapFlow> {
  const email = credentials.email.trim();
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  const host = await hostFor(credentials, domain);
  const port = Number(credentials.port) || 993;
  if (!ALLOW_PRIVATE && port !== 993 && port !== 143) {
    throw new Error("IMAP runs on port 993 (or 143).");
  }
  // The host is typed by the person: it must be a public mail server, never this server's network.
  await assertPublicUrl(`https://${host}`);
  const client = new ImapFlow({
    host,
    port,
    secure: port === 993,
    auth: { user: email, pass: credentials.password },
    logger: false,
    socketTimeout: 60_000,
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: CONNECT_TIMEOUT_MS,
  });
  // A dropped connection must not take the process down.
  client.on("error", () => undefined);
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      client.connect(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })),
          CONNECT_TIMEOUT_MS + 2000,
        );
      }),
    ]);
  } catch (err) {
    client.close();
    // The message names the server that was tried, so a wrong guess is visible.
    throw Object.assign(err instanceof Error ? err : new Error(String(err)), { imapHost: host });
  } finally {
    clearTimeout(timer);
  }
  return client;
}

/** Runs `use` on the mailbox that holds everything ("All Mail" where the server has one). */
async function withMailbox<T>(ctx: ConnectorActionContext, use: (client: ImapFlow) => Promise<T>) {
  const client = await open(JSON.parse(ctx.accessToken) as ImapCredentials);
  try {
    const boxes = await client.list();
    const all = boxes.find((b) => b.specialUse === "\\All");
    const lock = await client.getMailboxLock(all?.path ?? "INBOX", { readOnly: true });
    try {
      return await use(client);
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
}

interface Parts {
  attachments: MailAttachmentInfo[];
  plain: string | null;
  html: string | null;
}

function parts(node: MessageStructureObject | undefined, out: Parts): Parts {
  if (!node) {
    return out;
  }
  const name = node.dispositionParameters?.filename ?? node.parameters?.name;
  const part = node.part ?? "1";
  if (node.childNodes?.length) {
    for (const child of node.childNodes) {
      parts(child, out);
    }
  } else if (node.disposition === "attachment" || (name && !node.type.startsWith("text/"))) {
    out.attachments.push({
      id: part,
      name: name ?? `attachment-${part}`,
      mime: node.type,
      size: node.size ?? null,
    });
  } else if (node.type === "text/plain" && !out.plain) {
    out.plain = part;
  } else if (node.type === "text/html" && !out.html) {
    out.html = part;
  }
  return out;
}

const emptyParts = (): Parts => ({ attachments: [], plain: null, html: null });

function sender(from: { name?: string; address?: string }[] | undefined): string | null {
  const f = from?.[0];
  return f?.address ? (f.name ? `${f.name} <${f.address}>` : f.address) : null;
}

async function bytes(client: ImapFlow, uid: string, part: string): Promise<Buffer> {
  const { content } = await client.download(uid, part, { uid: true });
  if (!content) {
    throw new Error("The mail is no longer there.");
  }
  const chunks: Buffer[] = [];
  for await (const chunk of content) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

const backend: MailBackend = {
  search: (input, ctx) =>
    withMailbox(ctx, async (client) => {
      const query: SearchObject = {};
      if (input.since) {
        query.since = input.since;
      }
      if (input.until) {
        query.before = dayAfter(input.until);
      }
      if (input.from) {
        query.from = input.from;
      }
      const terms = input.terms ?? [];
      if (terms.length === 1) {
        query.text = terms[0];
      } else if (terms.length > 1) {
        query.or = terms.map((text) => ({ text }));
      }
      if (!Object.keys(query).length) {
        query.all = true;
      }
      const found = (await client.search(query, { uid: true })) || [];
      const limit = input.limit ?? 40;
      // Without the attachment filter the newest `limit` are enough; with it, look further back.
      const uids = found.slice(-(input.has_attachment ? limit * 4 : limit));
      if (!uids.length) {
        return [];
      }
      const messages = await client.fetchAll(
        uids,
        { envelope: true, bodyStructure: true, internalDate: true },
        { uid: true },
      );
      return messages
        .map((m) => ({
          id: String(m.uid),
          date: m.internalDate ? new Date(m.internalDate).toISOString() : null,
          from: sender(m.envelope?.from),
          subject: m.envelope?.subject ?? null,
          snippet: "",
          attachments: parts(m.bodyStructure, emptyParts()).attachments,
        }))
        .filter((m) => !input.has_attachment || m.attachments.length > 0)
        .reverse()
        .slice(0, limit);
    }),
  read: (id, ctx) =>
    withMailbox(ctx, async (client): Promise<MailMessage> => {
      const m = await client.fetchOne(
        id,
        { envelope: true, bodyStructure: true, internalDate: true },
        { uid: true },
      );
      if (!m) {
        throw new Error("The mail is no longer there.");
      }
      const found = parts(m.bodyStructure, emptyParts());
      const html = found.html ? (await bytes(client, id, found.html)).toString("utf8") : null;
      const text = found.plain
        ? (await bytes(client, id, found.plain)).toString("utf8")
        : html
          ? htmlToMarkdown(html)
          : "";
      return {
        id,
        date: m.internalDate ? new Date(m.internalDate).toISOString() : null,
        from: sender(m.envelope?.from),
        to: (m.envelope?.to ?? []).map((t) => t.address ?? "").filter(Boolean),
        subject: m.envelope?.subject ?? null,
        snippet: snippetOf(text),
        attachments: found.attachments,
        text,
        html,
      };
    }),
  attachment: (id, attachmentId, ctx) =>
    withMailbox(ctx, async (client) => {
      const m = await client.fetchOne(id, { bodyStructure: true }, { uid: true });
      const info = m
        ? parts(m.bodyStructure, emptyParts()).attachments.find((a) => a.id === attachmentId)
        : undefined;
      if (!info) {
        throw new Error("The mail has no such attachment.");
      }
      return {
        name: info.name,
        mime: info.mime,
        data_base64: (await bytes(client, id, attachmentId)).toString("base64"),
      };
    }),
};

export const imapConnector: ConnectorDefinition = {
  id: "imap",
  moduleId: "wizards-mail",
  name: "IMAP",
  description: "Read mail in any mailbox over IMAP (GMX, iCloud, your own domain …).",
  icon: "mail",
  toolPrefix: "mail",
  auth: {
    kind: "api_key",
    apiKey: {
      fields: [
        { key: "email", label: "Email address", placeholder: "name@company.com" },
        { key: "password", label: "Password or app password", secret: true },
        {
          key: "host",
          label: "IMAP server",
          placeholder: "leave empty for Gmail, GMX, iCloud …",
          required: false,
        },
        { key: "port", label: "Port", placeholder: "993", required: false },
      ],
      verify: async (credentials) => {
        const client = await open(credentials as unknown as ImapCredentials);
        await client.logout().catch(() => undefined);
        return { label: credentials.email.trim(), externalId: credentials.email.trim() };
      },
    },
  },
  actions: mailActions(backend, []),
};
