import type { Lang } from "@engenty-wizards/shared/definition";
import { eq } from "drizzle-orm";
import { type ChatImage, runArchitect } from "../agents/architect.js";
import { chatEngine, subscriptionTurn } from "../agents/subscription.js";
import { listConnectors } from "../connectors/external.js";
import { db, schema } from "../db/client.js";
import { managed } from "../manage.js";
import { hasTextModel } from "../models.js";
import { serverText } from "../texts.js";
import { draftFiles, readFile } from "./files.js";
import { ownedProject } from "./projects.js";
import { addMessage, draftIssues, ownedWizard, wizardMessages, writableWizard } from "./wizards.js";

/** The formats a model can look at; an SVG it reads as text. */
const VISIBLE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** A picture larger than this would pass the model's limit once base64-encoded. */
const VISIBLE_BYTES = 3_700_000;

/** The pictures a message attaches ("Angehängt: a.png, b.pdf"), read from the workspace. */
async function attachedImages(
  userId: string,
  wizardId: string,
  message: string,
): Promise<ChatImage[]> {
  const names = message.match(/(?:^|\n\n)(?:Angehängt|Attached): ([^\n]+)$/)?.[1]?.split(", ");
  const images: ChatImage[] = [];
  for (const name of names?.slice(0, 8) ?? []) {
    try {
      const { file, data } = await readFile(userId, wizardId, name);
      if (VISIBLE.has(file.mime) && data.byteLength <= VISIBLE_BYTES) {
        images.push({ path: file.path, mime: file.mime, data });
      }
    } catch {
      // A name that is no workspace file stays text.
    }
  }
  return images;
}

/** One studio chat turn: the architect reads the draft, its workspace and the thread, and changes them with tools. */
export async function architectTurn(
  userId: string,
  wizardId: string,
  message: string,
  /** The language the admin reads: the lines about what it does, and its stock replies. */
  lang: Lang,
  io: {
    signal: AbortSignal;
    onText: (delta: string) => void;
    onActivity: (label: string) => void;
    onThought: (line: string) => void;
    onBuilding: () => void;
  },
) {
  // Asked before the first model call: a wizard that is not changed here costs nothing to refuse.
  const w = await writableWizard(userId, wizardId);
  const history = await wizardMessages(w.id);
  const project = await ownedProject(userId, w.projectId);
  const images = await attachedImages(userId, w.id, message);
  const userMessageId = await addMessage(w.id, { role: "user", content: message });
  try {
    // A runtime that runs alone can answer the chat on the admin's own Claude subscription.
    const engine = managed ? "models" : await chatEngine(await hasTextModel());
    const result =
      engine === "claude"
        ? {
            ...(await subscriptionTurn({
              wizardId: w.id,
              message,
              signal: io.signal,
              onText: io.onText,
              onActivity: io.onActivity,
              onThought: io.onThought,
              onBuilding: io.onBuilding,
              images,
              lang,
            })),
            unfinished: false,
          }
        : await runArchitect({
            userId,
            wizardId: w.id,
            message,
            history: history.map((m) => ({ role: m.role, content: m.content })),
            mcpServers: project.mcpServers.map((s) => ({ id: s.id, name: s.name })),
            connectors: await listConnectors(project.id),
            signal: io.signal,
            onText: io.onText,
            onActivity: io.onActivity,
            onThought: io.onThought,
            onBuilding: io.onBuilding,
            images,
            lang,
          });
    const reply = result.unfinished
      ? `${result.reply ? `${result.reply}\n\n` : ""}${serverText(lang, "notFinished")}`
      : result.reply || serverText(lang, result.changed ? "done" : "notUnderstood");
    await addMessage(w.id, { role: "assistant", content: reply, changed: result.changed });
    const after = await ownedWizard(userId, wizardId);
    return {
      reply,
      changed: result.changed,
      draft: after.draft,
      revision: after.revision,
      files: await draftFiles(after.id),
      issues: await draftIssues(after),
    };
  } catch (err) {
    // An unanswered turn would repeat in the next turn's history.
    await db.delete(schema.wizardMessage).where(eq(schema.wizardMessage.id, userMessageId));
    throw err;
  }
}
