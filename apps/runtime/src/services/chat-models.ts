import { readFileSync } from "node:fs";
import { z } from "zod";
import { env } from "../env.js";
import { readSetting, writeSetting } from "../settings.js";

/**
 * The models the studio's chats (Goose, the editor's chat) run on, per way: the model of
 * everyday work and the one that extra effort switches to. The list is the server's word, so a
 * new model needs no new release: the runtime asks `CHAT_MODELS_URL` at the start and every day
 * after, and keeps what it last got. `data/chat-models.json` is the fallback in the repository.
 */
const entry = z.object({ id: z.string().min(1), label: z.string().min(1) });
const way = z.object({
  /** The model of everyday work. */
  normal: z.string().min(1),
  /** The model of extra effort. */
  extra: z.string().min(1),
  models: z.array(entry),
});
const catalog = z.object({
  version: z.literal(1),
  updated: z.string().optional(),
  ways: z.record(z.string(), way),
});
export type ChatCatalog = z.infer<typeof catalog>;
export type ChatWayModels = z.infer<typeof way>;

const DAY = 24 * 3600_000;

const bundled: ChatCatalog = catalog.parse(
  JSON.parse(readFileSync(new URL("../data/chat-models.json", import.meta.url), "utf8")),
);

let current: ChatCatalog = bundled;
let asked = 0;

/** The catalog now: what the server last said, else the file in the repository. */
export async function chatCatalog(): Promise<ChatCatalog> {
  if (env.chatModelsUrl && Date.now() - asked > DAY) {
    asked = Date.now();
    try {
      const res = await fetch(env.chatModelsUrl, { signal: AbortSignal.timeout(8_000) });
      const parsed = res.ok ? catalog.safeParse(await res.json()) : null;
      if (parsed?.success) {
        current = parsed.data;
      }
    } catch {
      // The server does not answer: the last list stays.
    }
  }
  return current;
}

/** What a person chose per way: a model for everyday work, one for extra effort. Unset: the way's own. */
export type ChatModelChoice = { normal?: string; extra?: string };
const KEY = "chat-models";

export async function chatModelChoices(): Promise<Record<string, ChatModelChoice>> {
  return (await readSetting<Record<string, ChatModelChoice>>(KEY)) ?? {};
}

export async function setChatModelChoice(wayId: string, choice: ChatModelChoice): Promise<void> {
  const all = await chatModelChoices();
  const next = { ...all, [wayId]: choice };
  await writeSetting(KEY, next);
}

/** The model id a way runs for everyday work or for extra effort: the person's, else the catalog's. */
export async function chatModelId(
  wayId: string,
  effort: "normal" | "extra",
): Promise<string | null> {
  const chosen = (await chatModelChoices())[wayId]?.[effort];
  return chosen ?? (await chatCatalog()).ways[wayId]?.[effort] ?? null;
}
