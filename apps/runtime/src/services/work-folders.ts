import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";

/**
 * Work's folders (Ordner, docs/plans/org-spaces.md): a section of a space's sidebar that also
 * holds what every chat in it should know, its Infos.
 */

/** A chat's folder, where it has Infos: read by the AI of each chat in it. */
export async function folderInfosOf(
  chatId: string,
): Promise<{ name: string; infos: string } | null> {
  const chat = await db.query.chat.findFirst({
    columns: { sectionId: true },
    where: eq(schema.chat.id, chatId),
  });
  if (!chat?.sectionId) {
    return null;
  }
  const section = await db.query.chatSection.findFirst({
    columns: { name: true, infos: true },
    where: eq(schema.chatSection.id, chat.sectionId),
  });
  return section?.infos.trim() ? section : null;
}
