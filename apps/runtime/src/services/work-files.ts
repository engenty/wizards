import type { SpaceFileKind } from "@engenty/wizards-shared/spaces";
import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { ServiceError } from "./errors.js";
import { spaceFileContent } from "./space-files.js";

/**
 * Files in Work's chats: what a person adds to a message lands in the space's files, and the
 * message names them. The model sees pictures and PDFs as the AI SDK's file parts; any other file
 * it is told of by name, to find in the space's files once it is read.
 */

/** A file of the space that goes with a message, as the message keeps it. */
export interface ChatFile {
  id: string;
  name: string;
  mime: string;
  /** The model read it as a file part; else it was told of it. */
  read?: boolean;
}

/** At most this many files go with one message. */
export const FILES_PER_MESSAGE = 10;

/** What the model reads itself, up to this many bytes; larger or other files it is told of. */
const MODEL_READS: Record<string, number> = {
  "image/png": 5_000_000,
  "image/jpeg": 5_000_000,
  "image/webp": 5_000_000,
  "image/gif": 5_000_000,
  "application/pdf": 10_000_000,
};

/** Where an upload goes among the space's files: pictures and media are assets, the rest documents. */
export const fileKind = (mime: string): SpaceFileKind =>
  /^(image|audio|video)\//.test(mime) ? "asset" : "document";

type TextPart = { type: "text"; text: string };
type FilePart = { type: "file"; data: string; mediaType: string; filename: string };

/** The line the model gets for files it does not read itself; the chat doesn't show it. */
const elsewhere = (names: string[]) =>
  `(Attached: ${names.join(", ")}. In the space's files; search_space finds what they say once they are read.)`;

/** The space's files a message names, in its order; one not in the chat's space is refused. */
export async function chatFiles(spaceId: string, ids: string[]): Promise<ChatFile[]> {
  if (!ids.length) {
    return [];
  }
  const rows = await db.query.spaceFile.findMany({
    where: and(eq(schema.spaceFile.spaceId, spaceId), inArray(schema.spaceFile.id, ids)),
  });
  return [...new Set(ids)].map((id) => {
    const row = rows.find((r) => r.id === id);
    if (!row) {
      throw new ServiceError("not_found", "file not found");
    }
    return { id: row.id, name: row.name, mime: row.mime };
  });
}

/**
 * A message's contents for the model: the text, the files it reads as file parts, and one line
 * naming the others; and the files as the message keeps them. Without files, the text as it is.
 */
export async function messageContents(
  spaceId: string,
  text: string,
  files: ChatFile[],
): Promise<{ contents: string | (TextPart | FilePart)[]; files: ChatFile[] }> {
  if (!files.length) {
    return { contents: text, files };
  }
  const parts: (TextPart | FilePart)[] = text ? [{ type: "text", text }] : [];
  const kept: ChatFile[] = [];
  for (const file of files) {
    const { row, data } = await spaceFileContent(spaceId, file.id);
    const read = data.byteLength <= (MODEL_READS[row.mime] ?? 0);
    if (read) {
      parts.push({
        type: "file",
        data: Buffer.from(data).toString("base64"),
        mediaType: row.mime,
        filename: row.name,
      });
    }
    kept.push({ ...file, read });
  }
  const told = kept.filter((f) => !f.read).map((f) => f.name);
  if (told.length) {
    parts.push({ type: "text", text: elsewhere(told) });
  }
  return { contents: parts, files: kept };
}

/**
 * A stored message's parts as the chat shows them: the files as links to the space's files (not
 * their bytes), after the text, without the line for the model.
 */
export function viewParts(
  spaceId: string,
  parts: { type: string; [key: string]: unknown }[],
  files: ChatFile[] | undefined,
): { type: string; [key: string]: unknown }[] {
  if (!files?.length) {
    return parts;
  }
  const line = elsewhere(files.filter((f) => !f.read).map((f) => f.name));
  return [
    ...parts.filter((p) => p.type !== "file" && !(p.type === "text" && p.text === line)),
    ...files.map((f) => ({
      type: "file",
      fileId: f.id,
      mediaType: f.mime,
      filename: f.name,
      url: `/api/studio/spaces/${spaceId}/files/${f.id}/content`,
    })),
  ];
}
