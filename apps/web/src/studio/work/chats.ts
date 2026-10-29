import { useChat as useAiChat } from "@ai-sdk/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createUIMessageStreamResponse, DefaultChatTransport } from "ai";
import { useMemo } from "react";
import { api, CLIENT } from "../../lib/api";
import { withBase } from "../../lib/base";
import { useFeature } from "../../lib/features";
import { lang } from "../../lib/i18n";

/**
 * Work's chats from `/api/studio/work` (behind `workMode`): the sidebar, one chat, and what the
 * person does with them. A message's parts are the AI SDK's (text, reasoning, tool calls).
 */

const BASE = "/api/studio/work";
/**
 * How often an open chat, the sidebar and the bell ask for what others wrote when the live feed
 * is off (`liveChanges`); with it on, they are read again when it tells of a change.
 */
const POLL_MS = 4000;
const usePoll = () => (useFeature("liveChanges") ? false : POLL_MS);

/** Members of a chat: people, and later engenties. The space's AI is no member. */
export type MemberKind = "person" | "engenty";

export interface ChatItem {
  id: string;
  spaceId: string;
  /** Since when the space's AI answers here; null while it doesn't. */
  answeringSince: string | null;
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

/** A call of the AI held for a person's approval. */
export interface Approval {
  id: string;
  chatId: string;
  toolName: string;
  input: unknown;
  askedBy: string;
  state: "pending" | "approved" | "denied" | "failed";
  output: unknown;
  decidedBy: string | null;
  createdAt: string;
}

export interface OpenChat {
  chat: ChatItem;
  members: ChatMember[];
  messages: ChatMessage[];
  threads: ChatItem[];
  approvals: Approval[];
  /** The plugins' tools of the space's AI by the model's name: whose, and what a call does. */
  tools: Record<string, ToolLabel>;
}

export interface ToolLabel {
  plugin: string;
  tool: string;
  label: { de: string; en: string } | null;
}

const SIDEBAR = ["work-chats"] as const;

/** The sidebar of a space. */
export function useSidebar(spaceId: string | undefined, query: string) {
  const poll = usePoll();
  return useQuery({
    queryKey: [...SIDEBAR, spaceId, query],
    queryFn: () =>
      api.get<{ sections: Section[]; chats: SidebarChat[] }>(
        `${BASE}/chats?space=${encodeURIComponent(spaceId ?? "")}${
          query ? `&q=${encodeURIComponent(query)}` : ""
        }`,
      ),
    enabled: Boolean(spaceId),
    refetchInterval: poll,
    placeholderData: (previous) => previous,
  });
}

/** One chat with its messages; not asked again while the AI's answer streams in here. */
export function useOpenChat(id: string | undefined, streaming = false) {
  const poll = usePoll();
  return useQuery({
    queryKey: ["work-chat", id],
    queryFn: () => api.get<OpenChat>(`${BASE}/chats/${id}`),
    enabled: Boolean(id),
    refetchInterval: streaming ? false : poll,
  });
}

/** A message that went somewhere else than a new turn answers in JSON: an empty stream for `useChat`. */
const NO_TURN = () =>
  createUIMessageStreamResponse({
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "start" });
        controller.enqueue({ type: "finish" });
        controller.close();
      },
    }),
  });

/**
 * Messages that ask the space's AI, through `useChat`: the turn's answer streams in as the AI
 * SDK's parts. A message taken into a turn already running, or queued, comes back without one.
 * When a turn ends, the chat is read again and the streamed message gives way to the stored one.
 */
export function useAiTurn(id: string) {
  const client = useQueryClient();
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: withBase(`${BASE}/chats/${id}/messages`),
        credentials: "include",
        headers: { ...CLIENT, "accept-language": lang },
        prepareSendMessagesRequest: ({ messages, body }) => {
          const last = messages.at(-1);
          const text = (last?.parts ?? []).map((p) => (p.type === "text" ? p.text : "")).join("");
          return { body: { text, ask: true, ...body } };
        },
        // Following a turn someone else started: what streamed so far, then the rest (204: none).
        prepareReconnectToStreamRequest: () => ({
          api: withBase(`${BASE}/chats/${id}/follow`),
          credentials: "include",
          headers: { ...CLIENT, "accept-language": lang },
        }),
        fetch: async (input, init) => {
          const res = await fetch(input, init);
          return res.ok && res.headers.get("content-type")?.includes("application/json")
            ? NO_TURN()
            : res;
        },
      }),
    [id],
  );
  const chat = useAiChat({
    id: `work-${id}`,
    transport,
    onFinish: async () => {
      await client.invalidateQueries({ queryKey: ["work-chat", id] });
      await client.invalidateQueries({ queryKey: SIDEBAR });
      chat.setMessages([]);
    },
  });
  return chat;
}

export const stopTurn = (id: string) => api.post(`${BASE}/chats/${id}/stop`);

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

/** A message that doesn't start a turn now: one the AI isn't asked for, or one for after its answer. */
export const usePostMessage = () =>
  useChange(({ id, text, later }: { id: string; text: string; later?: boolean }) =>
    api.post<{ sent: string }>(
      `${BASE}/chats/${id}/messages`,
      later ? { text, ask: true, later } : { text },
    ),
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

/** The approvals waiting for the person: the bell's count and list. */
export function useWaiting() {
  const poll = usePoll();
  return useQuery({
    queryKey: ["work-approvals"],
    queryFn: () => api.get<{ approvals: Approval[] }>(`${BASE}/approvals`),
    refetchInterval: poll,
  });
}

/**
 * Approve or deny a held call. The AI goes on with the outcome; its answer streams back, read to
 * the end here, and the chat is read again then.
 */
export function useDecide(chatId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, approve }: { id: string; approve: boolean }) => {
      const res = await fetch(withBase(`${BASE}/chats/${chatId}/approvals/${id}`), {
        method: "POST",
        credentials: "include",
        headers: { ...CLIENT, "content-type": "application/json", "accept-language": lang },
        body: JSON.stringify({ approve }),
      });
      if (!res.ok) {
        throw new Error(
          ((await res.json().catch(() => null)) as { error?: string } | null)?.error ??
            res.statusText,
        );
      }
      void client.invalidateQueries({ queryKey: ["work-chat", chatId] });
      void client.invalidateQueries({ queryKey: ["work-approvals"] });
      await res.text();
    },
    onSettled: () => {
      client.invalidateQueries({ queryKey: ["work-chat", chatId] });
      client.invalidateQueries({ queryKey: ["work-approvals"] });
      client.invalidateQueries({ queryKey: SIDEBAR });
    },
  });
}
