import type { LiveChange } from "@engenty/wizards-shared/live";
import type { LiveBinding } from "../live/patch";

/**
 * Work's chats on the studio's live feed (behind `workMode`): a change of kind `chat` carries no
 * view, so the sidebar, the chat it names and the bell are read again; also for a chat that is
 * gone, or that the person was taken out of (it comes as gone).
 */
const keysOf = (change: LiveChange) => [
  ["work-chats"],
  ...(change.parent === "section" ? [] : [["work-chat", change.item]]),
  ["work-approvals"],
];

export const chatLive: LiveBinding[] = [
  {
    id: "work-chats",
    kinds: ["chat"],
    patch: (change, { invalidate }) => {
      for (const key of keysOf(change)) {
        invalidate(key);
      }
    },
    fallback: keysOf,
  },
];
