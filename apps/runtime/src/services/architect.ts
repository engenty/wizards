import type { Lang } from "@engenty/wizards-shared/definition";
import { eq } from "drizzle-orm";
import { type ChatImage, runArchitect } from "../agents/architect.js";
import { chatTurnWay, subscriptionTurn } from "../agents/subscription.js";
import { TurnClock } from "../agents/turn-clock.js";
import { listConnectors } from "../connectors/external.js";
import { db, schema } from "../db/client.js";
import { currentFeatures } from "../features.js";
import { managed } from "../manage.js";
import { prompt } from "../prompts.js";
import { serverText } from "../texts.js";
import { draftFiles, readFile } from "./files.js";
import { type FirstPassResult, firstPass, firstPassLine } from "./first-pass.js";
import { ownedSpace } from "./spaces.js";
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

export interface ArchitectIo {
  signal: AbortSignal;
  onText: (delta: string) => void;
  onActivity: (label: string) => void;
  onThought: (line: string) => void;
  onBuilding: () => void;
  /** After a first pass: the steps the architect still works on, shown as being prepared. */
  onPreparing?: (stepIds: string[]) => void;
}

/**
 * Whether a message gets the fast first pass (switch fastCreate): the first message of a wizard
 * made from nothing, no template, nothing said before.
 */
export async function fastCreateFor(userId: string, wizardId: string): Promise<boolean> {
  if (!(await currentFeatures()).fastCreate) {
    return false;
  }
  const w = await writableWizard(userId, wizardId);
  return !w.starter && (await wizardMessages(w.id)).length === 0;
}

/**
 * A new wizard's first turn with the switch fastCreate on: the first pass writes the draft step
 * by step (services/first-pass.ts), then the architect finishes it on the wizard that now exists,
 * while the admin can already go through its pages.
 */
export async function fastCreateTurn(
  userId: string,
  wizardId: string,
  message: string,
  lang: Lang,
  extra: boolean | undefined,
  io: ArchitectIo,
) {
  const started = Date.now();
  const w = await writableWizard(userId, wizardId);
  const userMessageId = await addMessage(w.id, { role: "user", content: message });
  const way = await chatTurnWay(managed);
  let pass: FirstPassResult | null = null;
  let outcome = "failed";
  io.onActivity(serverText(lang, "firstPassWriting"));
  io.onBuilding();
  try {
    pass = await firstPass({
      userId,
      wizardId,
      // The wish without the line naming its attachments: the first pass cannot read them.
      wish: message.replace(/\n\n(?:Angehängt|Attached): [^\n]+$/, ""),
      way,
      signal: io.signal,
      started,
    });
    outcome = pass.empty ? "empty" : "ok";
  } catch (err) {
    outcome = io.signal.aborted ? "stopped" : "failed";
    if (io.signal.aborted) {
      await db.delete(schema.wizardMessage).where(eq(schema.wizardMessage.id, userMessageId));
      throw err;
    }
    // What the first pass could not do, the architect does from the wish, as without the switch.
    console.error("[first-pass]", (err as Error).message);
  } finally {
    console.info(firstPassLine({ way, wizardId: w.id, outcome, ms: Date.now() - started }, pass));
  }
  if (!pass || pass.empty) {
    return architectTurn(userId, wizardId, message, lang, extra, io, { asked: message });
  }
  const after = await ownedWizard(userId, wizardId);
  const preparing = [
    ...new Set([
      ...pass.issues.map((i) => i.stepId).filter((id): id is string => Boolean(id)),
      ...after.draft.steps.filter((s) => s.type === "widget").map((s) => s.id),
    ]),
  ].filter((id) => after.draft.steps.some((s) => s.id === id));
  io.onPreparing?.(preparing);
  io.onActivity(serverText(lang, "firstPassFinishing"));
  io.onText(`${serverText(lang, "firstPassDone", { count: pass.steps })}\n\n`);
  const followup = prompt("architect", "firstpass.followup", {
    wish: message,
    issues: pass.issues.length ? pass.issues.map((i) => `- ${i.message}`).join("\n") : "none",
  });
  return architectTurn(userId, wizardId, followup, lang, extra, io, { asked: message });
}

/** One studio chat turn: the architect reads the draft, its workspace and the thread, and changes them with tools. */
export async function architectTurn(
  userId: string,
  wizardId: string,
  message: string,
  /** The language the admin reads: the lines about what it does, and its stock replies. */
  lang: Lang,
  extra: boolean | undefined,
  io: ArchitectIo,
  opts: {
    /** The admin's own message is in the thread already; `message` is the turn's instruction. */
    asked?: string;
  } = {},
) {
  // Asked before the first model call: a wizard that is not changed here costs nothing to refuse.
  const w = await writableWizard(userId, wizardId);
  const history = await wizardMessages(w.id);
  const space = await ownedSpace(userId, w.spaceId);
  const images = await attachedImages(userId, w.id, opts.asked ?? message);
  const userMessageId =
    opts.asked === undefined ? await addMessage(w.id, { role: "user", content: message }) : null;
  const clock = new TurnClock();
  const told = { way: "none", changed: false, stepsAfter: w.draft.steps.length };
  let outcome: "ok" | "failed" = "failed";
  try {
    // A runtime that runs alone can answer the chat on the admin's own subscription or key.
    const engine = await chatTurnWay(managed);
    told.way = engine;
    const result =
      engine === "claude" || engine === "codex" || engine === "cursor"
        ? {
            ...(await subscriptionTurn({
              client: engine,
              wizardId: w.id,
              message,
              signal: io.signal,
              onText: io.onText,
              onActivity: io.onActivity,
              onThought: io.onThought,
              onBuilding: io.onBuilding,
              images,
              extra,
              lang,
              clock,
            })),
            unfinished: false,
          }
        : await runArchitect({
            way: engine,
            userId,
            wizardId: w.id,
            message,
            extra,
            history: history.map((m) => ({ role: m.role, content: m.content })),
            connectors: await listConnectors(space.id),
            signal: io.signal,
            onText: io.onText,
            onActivity: io.onActivity,
            onThought: io.onThought,
            onBuilding: io.onBuilding,
            images,
            lang,
            clock,
          });
    clock.modelDone();
    told.changed = result.changed;
    const reply = result.unfinished
      ? `${result.reply ? `${result.reply}\n\n` : ""}${serverText(lang, "notFinished")}`
      : result.reply || serverText(lang, result.changed ? "done" : "notUnderstood");
    await addMessage(w.id, { role: "assistant", content: reply, changed: result.changed });
    const after = await ownedWizard(userId, wizardId);
    told.stepsAfter = after.draft.steps.length;
    outcome = "ok";
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
    if (userMessageId) {
      await db.delete(schema.wizardMessage).where(eq(schema.wizardMessage.id, userMessageId));
    }
    throw err;
  } finally {
    console.info(
      clock.line({
        way: told.way,
        wizardId: w.id,
        outcome: io.signal.aborted ? "stopped" : outcome,
        changed: told.changed,
        stepsBefore: w.draft.steps.length,
        stepsAfter: told.stepsAfter,
      }),
    );
  }
}
