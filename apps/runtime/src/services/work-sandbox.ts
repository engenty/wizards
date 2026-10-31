import { createSandbox, type Sandbox } from "../sandbox/index.js";

/**
 * A Work chat's sandbox, where the space's AI runs commands and the scripts of the space's skills
 * (docs/plans/skills.md). One per chat, made on its first command and kept while the chat is in
 * use, so a file one turn writes is there for the next; gone after IDLE_MS without a command, or
 * when the runtime stops.
 */

/** A chat's sandbox goes after this long without a command. */
export const IDLE_MS = 30 * 60_000;

interface Kept {
  sandbox: Sandbox;
  timer: NodeJS.Timeout;
}

const kept = new Map<string, Kept>();

const drop = (chatId: string) => {
  const k = kept.get(chatId);
  if (k) {
    kept.delete(chatId);
    clearTimeout(k.timer);
    void k.sandbox.destroy().catch(() => undefined);
  }
};

/** The chat's sandbox, made on first use; each use keeps it IDLE_MS longer. */
export function chatSandbox(chatId: string): Sandbox {
  let k = kept.get(chatId);
  if (k) {
    clearTimeout(k.timer);
  } else {
    k = { sandbox: createSandbox(`chat-${chatId}`), timer: undefined as never };
    kept.set(chatId, k);
  }
  k.timer = setTimeout(() => drop(chatId), IDLE_MS).unref();
  return k.sandbox;
}

/** Ends a chat's sandbox now: the chat was deleted. */
export const dropChatSandbox = drop;

/** Ends every chat's sandbox: the runtime stops. */
export async function dropChatSandboxes(): Promise<void> {
  const all = [...kept.values()];
  kept.clear();
  await Promise.all(
    all.map((k) => {
      clearTimeout(k.timer);
      return k.sandbox.destroy().catch(() => undefined);
    }),
  );
}
