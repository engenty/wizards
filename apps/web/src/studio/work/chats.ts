import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";

/**
 * Work's chats from `/api/studio/work` (behind `workMode`): the sidebar, one chat, and what the
 * person does with them. A message's parts are the AI SDK's (text, reasoning, tool calls).
 */

const BASE = "/api/studio/work";
/** How often an open chat and the sidebar ask for what others wrote, until the live feed carries it. */
const POLL_MS = 4000;

/** Members of a chat: people, and later engenties. The space's AI is no member. */
export type MemberKind = "person" | "engenty";

export interface ChatItem {
  id: string;
  spaceId: string;
  title: string;
  sectionId: string | null;
  parentId: string | null;
  private: boolean;
  updatedAt: string;
}

export interface SidebarChat extends ChatItem {
  pinned: boolean;
  archived: boolean;
  unread: boolean;
  last: { author: string; text: string; at: string } | null;
}

export interface Section {
  id: string;
  name: string;
}

/** One part of a message, as the AI SDK's `UIMessage` holds it. */
export type ChatPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | {
      type: `tool-${string}`;
      toolCallId: string;
      state:
        | "input-streaming"
        | "input-available"
        | "approval-requested"
        | "approval-responded"
        | "output-available"
        | "output-error"
        | "output-denied";
      input?: unknown;
      output?: unknown;
      errorText?: string;
    }
  | { type: string; [key: string]: unknown };

/** A message: the AI SDK's parts, and who wrote it (a person, or the space's AI). */
export interface ChatMessage {
  id: string;
  author: { kind: "person" | "ai"; id: string; name: string };
  parts: ChatPart[];
  createdAt: string;
}

export interface ChatMember {
  kind: MemberKind;
  id: string;
  name: string;
  image: string | null;
}

export interface OpenChat {
  chat: ChatItem;
  members: ChatMember[];
  messages: ChatMessage[];
  threads: ChatItem[];
}

const SIDEBAR = ["work-chats"] as const;

/** The sidebar of a space. */
export function useSidebar(spaceId: string | undefined, query: string) {
  return useQuery({
    queryKey: [...SIDEBAR, spaceId, query],
    queryFn: () =>
      api.get<{ sections: Section[]; chats: SidebarChat[] }>(
        `${BASE}/chats?space=${encodeURIComponent(spaceId ?? "")}${
          query ? `&q=${encodeURIComponent(query)}` : ""
        }`,
      ),
    enabled: Boolean(spaceId),
    refetchInterval: POLL_MS,
    placeholderData: (previous) => previous,
  });
}

export function useChat(id: string | undefined) {
  return useQuery({
    queryKey: ["work-chat", id],
    queryFn: () => api.get<OpenChat>(`${BASE}/chats/${id}`),
    enabled: Boolean(id),
    refetchInterval: POLL_MS,
  });
}

/** Every change re-reads the sidebar and the open chat. */
function useChange<A, R>(run: (args: A) => Promise<R>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSettled: () => {
      client.invalidateQueries({ queryKey: SIDEBAR });
      client.invalidateQueries({ queryKey: ["work-chat"] });
    },
  });
}

export const useCreateChat = () =>
  useChange(
    (body: {
      spaceId?: string;
      title?: string;
      sectionId?: string | null;
      parentId?: string | null;
    }) => api.post<ChatItem>(`${BASE}/chats`, body),
  );

export const useUpdateChat = () =>
  useChange(
    ({
      id,
      ...patch
    }: {
      id: string;
      title?: string;
      sectionId?: string | null;
      private?: boolean;
    }) => api.patch<ChatItem>(`${BASE}/chats/${id}`, patch),
  );

export const useChatState = () =>
  useChange(
    ({ id, ...patch }: { id: string; pinned?: boolean; archived?: boolean; read?: boolean }) =>
      api.put(`${BASE}/chats/${id}/state`, patch),
  );

export const useDeleteChat = () => useChange((id: string) => api.del(`${BASE}/chats/${id}`));

export const usePostMessage = () =>
  useChange(({ id, text }: { id: string; text: string }) =>
    api.post<ChatMessage>(`${BASE}/chats/${id}/messages`, { text }),
  );

export const useCreateSection = () =>
  useChange((body: { spaceId: string; name: string }) =>
    api.post<Section>(`${BASE}/sections`, body),
  );

export const useRenameSection = () =>
  useChange(({ id, name }: { id: string; name: string }) =>
    api.patch(`${BASE}/sections/${id}`, { name }),
  );

export const useMoveSection = () =>
  useChange(({ id, direction }: { id: string; direction: "up" | "down" }) =>
    api.post(`${BASE}/sections/${id}/move`, { direction }),
  );

export const useDeleteSection = () => useChange((id: string) => api.del(`${BASE}/sections/${id}`));
