import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";

/**
 * Work's folders (Ordner, docs/plans/org-spaces.md): a section of a space's sidebar that also
 * holds what every chat in it should know, its Infos.
 */

/**
 * A chat's folder, where it has Infos or a linked drive: read by the AI of each chat in it. The
 * drive is named by its path in the space's files (`dateien/<slug>/`).
 */
export async function folderInfosOf(
  chatId: string,
): Promise<{ name: string; infos: string; drive: string | null } | null> {
  const chat = await db.query.chat.findFirst({
    columns: { sectionId: true },
    where: eq(schema.chat.id, chatId),
  });
  if (!chat?.sectionId) {
    return null;
  }
  const section = await db.query.chatSection.findFirst({
    columns: { name: true, infos: true, mountId: true },
    where: eq(schema.chatSection.id, chat.sectionId),
  });
  if (!section) {
    return null;
  }
  const mount = section.mountId
    ? await db.query.spaceMount.findFirst({
        columns: { slug: true },
        where: eq(schema.spaceMount.id, section.mountId),
      })
    : undefined;
  const drive = mount ? `dateien/${mount.slug}/` : null;
  return section.infos.trim() || drive ? { name: section.name, infos: section.infos, drive } : null;
}
