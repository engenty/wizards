import type { AgentStep } from "@engenty/wizards-shared/definition";
import type { ConnectionDef } from "@engenty/wizards-shared/store";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  type BrokerConnection,
  brokerCall,
  brokerConnected,
  reachesOutside,
  whereOf,
  whoOf,
} from "../broker/index.js";
import {
  type MailAttachment,
  type MailMessage,
  type MailSummary,
  mailSearchInput,
} from "../connectors/mail.js";
import type { StepContext } from "../engine/types.js";
import { prompt } from "../prompts.js";
import { escapeHtml, htmlToPdf } from "../render/convert.js";
import { guardHtml } from "../render/guard.js";
import { attempt, clip, type FileKeeper } from "./shared.js";

reachesOutside("mail_search", { connection: "mail", action: "search", kind: "read" });
reachesOutside("mail_read", { connection: "mail", action: "read", kind: "read" });
reachesOutside("mail_save", [
  { connection: "mail", action: "read", kind: "read" },
  { connection: "mail", action: "get_attachment", kind: "read" },
]);

/**
 * Read-only mail for a step that names a mail connection. The tools are the same whichever
 * provider the person connected; attachments never pass through the model — they are saved.
 * Every read goes through the broker, which holds the mailbox's account.
 */
export function mailTools(step: AgentStep, ctx: StepContext, files: FileKeeper) {
  const connection = (ctx.def.connections ?? []).find(
    (c) => c.kind === "mail" && step.connections?.includes(c.id),
  );
  if (!connection) {
    return {};
  }
  const held = (def: ConnectionDef): BrokerConnection => ({
    kind: "store_secret",
    def,
    scope: ctx.store,
    spaceId: ctx.space.id,
  });
  /** The mailbox's label, or the note that nothing is connected. */
  const open = async () => {
    const found = await brokerConnected(held(connection));
    if (!found) {
      throw new Error(prompt("tools", "note.mail_not_connected"));
    }
    return found.label;
  };
  const read = async <T>(action: "search" | "read" | "get_attachment", input: unknown) => {
    const out = await brokerCall<T>({
      who: whoOf(ctx.store.holder),
      where: whereOf(ctx),
      connection: held(connection),
      action: { id: action, kind: "read" },
      input,
    });
    if (!out.ok) {
      throw new Error(
        out.refused === "not_connected" ? prompt("tools", "note.mail_not_connected") : out.reason,
      );
    }
    return out.result;
  };
  const tools: Record<string, any> = {};

  tools.mail_search = createTool({
    id: "mail_search",
    description: prompt("tools", "tool.mail_search"),
    inputSchema: mailSearchInput,
    execute: (input) =>
      attempt(async () => {
        const label = await open();
        await ctx.emit("tool", { code: "searchesMail", params: { label } });
        const { mails } = await read<{ mails: MailSummary[] }>("search", input);
        return {
          mailbox: label,
          total: mails.length,
          mails: mails.map((m) => ({ ...m, snippet: m.snippet.slice(0, 200) })),
        };
      }),
  });

  tools.mail_read = createTool({
    id: "mail_read",
    description: prompt("tools", "tool.mail_read"),
    inputSchema: z.object({ id: z.string() }),
    execute: ({ id }) =>
      attempt(async () => {
        const mail = await read<MailMessage>("read", { id });
        const { html: _html, ...rest } = mail;
        return { ...rest, text: clip(mail.text, 6000) };
      }),
  });

  tools.mail_save = createTool({
    id: "mail_save",
    description: prompt("tools", "tool.mail_save"),
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
        const label = await open();
        await ctx.emit("tool", {
          code: "savesReceipts",
          params: { count: items.length, label },
        });
        const saved: Record<string, unknown>[] = [];
        for (const item of items) {
          try {
            if (item.attachment_id) {
              const a = await read<MailAttachment>("get_attachment", {
                id: item.id,
                attachment_id: item.attachment_id,
              });
              const kept = await files.keep(item.path, Buffer.from(a.data_base64, "base64"), {
                mime: a.mime,
                source: `E-Mail-Anhang „${a.name}“ aus ${label}`,
              });
              saved.push({ id: item.id, saved: kept.path, size: kept.size });
            } else {
              const mail = await read<MailMessage>("read", { id: item.id });
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
