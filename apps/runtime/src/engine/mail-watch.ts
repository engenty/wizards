import { and, eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import type { StreamPullResult } from "../engenty/connections-sdk/types.js";
import { sendSignal } from "./signals.js";

/** The signal a mail makes: heard by a run that waits for its sender or for its thread. */
export const MAIL_SIGNAL = "mail.received";

/**
 * The mailboxes that runs wait on, each pulled once from its stored cursor: a mailbox nobody waits
 * on costs nothing. A mail becomes two signals, by sender and by thread, so a run can wait for
 * "a reply in the thread I started" or for "anything from anna@…".
 */
export async function watchMailbox(input: {
  spaceId: string;
  connection: string;
  cursor: string | null;
  pull: (cursor: string | null) => Promise<StreamPullResult>;
}): Promise<{ cursor: string | null; signals: number }> {
  const waiting = await db.query.runWait.findFirst({
    where: and(eq(schema.runWait.spaceId, input.spaceId), eq(schema.runWait.name, MAIL_SIGNAL)),
  });
  if (!waiting) {
    return { cursor: input.cursor, signals: 0 };
  }
  let cursor = input.cursor;
  let signals = 0;
  for (;;) {
    const page = await input.pull(cursor);
    for (const mail of page.items) {
      const data = {
        from: mail.from_email,
        subject: mail.subject,
        text: mail.body_text?.slice(0, 20_000) ?? null,
        thread: mail.provider_thread_id,
        message: mail.provider_message_id,
      };
      for (const key of [mail.from_email?.toLowerCase(), mail.provider_thread_id && `thread:${mail.provider_thread_id}`]) {
        if (key) {
          await sendSignal({ spaceId: input.spaceId, name: MAIL_SIGNAL, key, data, source: `mail:${input.connection}` });
          signals++;
        }
      }
    }
    cursor = page.nextCursor;
    if (!page.hasMore) {
      return { cursor, signals };
    }
  }
}
