import type { AgentStep } from "@engenty-wizards/shared/definition";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { connectionContext } from "../connectors/index.js";
import {
  type MailAttachment,
  type MailMessage,
  type MailSummary,
  mailAction,
  mailSearchInput,
} from "../connectors/mail.js";
import type { StepContext } from "../engine/types.js";
import { escapeHtml, htmlToPdf } from "../render/convert.js";
import { guardHtml } from "../render/guard.js";
import { attempt, clip, type FileKeeper } from "./shared.js";

const NOT_CONNECTED =
  "The person has not connected a mailbox. Go on without mail and say in your result that the mailbox is not connected.";

/**
 * Read-only mail for a step that names a mail connection. The tools are the same whichever
 * provider the person connected; attachments never pass through the model — they are saved.
 */
export function mailTools(step: AgentStep, ctx: StepContext, files: FileKeeper) {
  const connection = (ctx.def.connections ?? []).find(
    (c) => c.kind === "mail" && step.connections?.includes(c.id),
  );
  if (!connection) {
    return {};
  }
  const open = async () => {
    const found = await connectionContext(ctx.store, connection, ctx.project.id);
    if (!found) {
      throw new Error(NOT_CONNECTED);
    }
    return found;
  };
  const tools: Record<string, any> = {};

  tools.mail_search = createTool({
    id: "mail_search",
    description:
      "Search the person's mailbox (read-only), newest first. Returns id, date, sender, subject, snippet and attachments (id, name, size) of each mail. Search broadly with several terms at once rather than one call per word.",
    inputSchema: mailSearchInput,
    execute: (input) =>
      attempt(async () => {
        const { connector, ctx: actionCtx, label } = await open();
        await ctx.emit("tool", { code: "searchesMail", params: { label } });
        const { mails } = await mailAction<{ mails: MailSummary[] }>(
          connector,
          "search",
          input,
          actionCtx,
        );
        return {
          mailbox: label,
          total: mails.length,
          mails: mails.map((m) => ({ ...m, snippet: m.snippet.slice(0, 200) })),
        };
      }),
  });

  tools.mail_read = createTool({
    id: "mail_read",
    description: "Read one mail in full: sender, recipients, text, attachments.",
    inputSchema: z.object({ id: z.string() }),
    execute: ({ id }) =>
      attempt(async () => {
        const { connector, ctx: actionCtx } = await open();
        const mail = await mailAction<MailMessage>(connector, "read", { id }, actionCtx);
        const { html: _html, ...rest } = mail;
        return { ...rest, text: clip(mail.text, 6000) };
      }),
  });

  tools.mail_save = createTool({
    id: "mail_save",
    description:
      "Keep mail attachments (invoice PDFs) as files, several at once: each is stored under `path` in the wizard's files and added to this step's result. Leave attachment_id out to keep the mail itself as a PDF — for receipts that only exist as mail text. Then read them with scan_documents or read_document.",
    inputSchema: z.object({
      items: z
        .array(
          z.object({
            id: z.string().describe("Mail id from mail_search."),
            attachment_id: z.string().optional(),
            path: z.string().describe("e.g. invoices/2026-09/2026-09-03_Notion_INV-123.pdf"),
          }),
        )
        .min(1)
        .max(40),
    }),
    execute: ({ items }) =>
      attempt(async () => {
        const { connector, ctx: actionCtx, label } = await open();
        await ctx.emit("tool", {
          code: "savesReceipts",
          params: { count: items.length, label },
        });
        const saved: Record<string, unknown>[] = [];
        for (const item of items) {
          try {
            if (item.attachment_id) {
              const a = await mailAction<MailAttachment>(
                connector,
                "get_attachment",
                { id: item.id, attachment_id: item.attachment_id },
                actionCtx,
              );
              const kept = await files.keep(item.path, Buffer.from(a.data_base64, "base64"), {
                mime: a.mime,
                source: `E-Mail-Anhang „${a.name}“ aus ${label}`,
              });
              saved.push({ id: item.id, saved: kept.path, size: kept.size });
            } else {
              const mail = await mailAction<MailMessage>(
                connector,
                "read",
                { id: item.id },
                actionCtx,
              );
              const page =
                mail.html ??
                `<pre style="white-space:pre-wrap;font:14px system-ui">${escapeHtml(mail.text)}</pre>`;
              const head = `<div style="font:13px system-ui;color:#444;border-bottom:1px solid #ddd;padding-bottom:8px;margin-bottom:12px">${escapeHtml(mail.from ?? "")}<br>${escapeHtml(mail.date ?? "")}<br><b>${escapeHtml(mail.subject ?? "")}</b></div>`;
              // The mail's own HTML is rendered offline: its remote images and scripts never load.
              const pdf = await htmlToPdf(
                guardHtml(`<!doctype html><html><body>${head}${page}</body></html>`),
              );
              const kept = await files.keep(item.path.replace(/(\.pdf)?$/i, ".pdf"), pdf, {
                mime: "application/pdf",
                source: `E-Mail „${mail.subject ?? ""}“ aus ${label}`,
              });
              saved.push({ id: item.id, saved: kept.path, size: kept.size });
            }
          } catch (err) {
            saved.push({ id: item.id, error: String((err as Error).message).slice(0, 200) });
          }
        }
        return { saved };
      }),
  });

  return tools;
}
