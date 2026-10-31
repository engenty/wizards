import { z } from "zod";
import type { ConnectorAction, ConnectorActionContext } from "../engenty/connections-sdk/types.js";
import { prompt } from "../prompts.js";

/**
 * Mail as wizards use it: read-only, and the same three actions whichever provider the person
 * connected. Every mail connector is an engenty `ConnectorDefinition` whose actions are these.
 */

export const mailSearchInput = z.object({
  terms: z
    .array(z.string().min(1))
    .max(12)
    .optional()
    .describe("Words to look for in subject and body; a mail matches when ANY of them occurs."),
  from: z.string().optional().describe("Sender address or domain, e.g. billing@notion.so"),
  since: z.string().optional().describe("First day, YYYY-MM-DD (inclusive)."),
  until: z.string().optional().describe("Last day, YYYY-MM-DD (inclusive)."),
  has_attachment: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).optional().describe("Newest first; default 40."),
});
export type MailSearchInput = z.infer<typeof mailSearchInput>;

export const mailReadInput = z.object({ id: z.string() });
export const mailAttachmentInput = z.object({ id: z.string(), attachment_id: z.string() });

export interface MailAttachmentInfo {
  id: string;
  name: string;
  mime: string;
  size: number | null;
}

export interface MailSummary {
  id: string;
  date: string | null;
  from: string | null;
  subject: string | null;
  snippet: string;
  attachments: MailAttachmentInfo[];
}

export interface MailMessage extends MailSummary {
  to: string[];
  text: string;
  html: string | null;
}

export interface MailAttachment {
  name: string;
  mime: string;
  data_base64: string;
}

/** What a provider implements. */
export interface MailBackend {
  search(input: MailSearchInput, ctx: ConnectorActionContext): Promise<MailSummary[]>;
  read(id: string, ctx: ConnectorActionContext): Promise<MailMessage>;
  attachment(
    id: string,
    attachmentId: string,
    ctx: ConnectorActionContext,
  ): Promise<MailAttachment>;
}

export function mailActions(backend: MailBackend, providerScopes: string[]): ConnectorAction[] {
  return [
    {
      id: "search",
      group: "read",
      summary: "Search the mailbox",
      description: prompt("tools", "connector.mail.search"),
      inputSchema: mailSearchInput,
      providerScopes,
      handler: async (input, ctx) => ({
        mails: await backend.search(mailSearchInput.parse(input), ctx),
      }),
    },
    {
      id: "read",
      group: "read",
      summary: "Read one mail",
      description: prompt("tools", "connector.mail.read"),
      inputSchema: mailReadInput,
      providerScopes,
      handler: (input, ctx) => backend.read(mailReadInput.parse(input).id, ctx),
    },
    {
      id: "get_attachment",
      group: "read",
      summary: "Fetch an attachment",
      description: prompt("tools", "connector.mail.get_attachment"),
      inputSchema: mailAttachmentInput,
      providerScopes,
      handler: (input, ctx) => {
        const { id, attachment_id } = mailAttachmentInput.parse(input);
        return backend.attachment(id, attachment_id, ctx);
      },
    },
  ];
}

export function snippetOf(text: string, length = 240): string {
  return text.replace(/\s+/g, " ").trim().slice(0, length);
}

/** The day after a YYYY-MM-DD date — for providers whose "before" is exclusive. */
export function dayAfter(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
