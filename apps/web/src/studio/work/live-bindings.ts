import type { LiveBinding } from "../live/patch";

/**
 * Work's chats on the studio's live feed (behind `workMode`): a change of kind `chat` carries no
 * view, so the sidebar, the chat it names and the bell are read again.
 */
export const chatLive: LiveBinding[] = [
  {
    id: "work-chats",
    kinds: ["chat"],
    patch: () => {},
    fallback: (change) => [
      ["work-chats"],
      ...(change.parent === "section" ? [] : [["work-chat", change.item]]),
      ["work-approvals"],
    ],
  },
];
