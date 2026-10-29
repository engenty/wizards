import { useChat as useAiChat } from "@ai-sdk/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createUIMessageStreamResponse, DefaultChatTransport } from "ai";
import { type RefObject, useMemo } from "react";
import { api, CLIENT } from "../../lib/api";
import { withBase } from "../../lib/base";
import { useFeature } from "../../lib/features";
import { lang } from "../../lib/i18n";
import { useMe } from "../../lib/session";
import type { PickedFile } from "../../ui/composer";

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
  /** A file of the space that went with the message: `url` its content, `fileId` its id there. */
  | { type: "file"; url: string; mediaType: string; filename?: string; fileId?: string }
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

/** What the developer mode hears of a turn (dev.tsx): its start, each chunk of its stream, its end. */
export interface TurnTap {
  /** `message`: what the person asked; empty when following a turn someone else started. */
  start: (message: string) => void;
  chunk: (chunk: { type: string } & Record<string, unknown>) => void;
  end: () => void;
}

/** Reads a copy of a turn's stream for the developer mode: one chunk per `data:` line. */
async function hear(
  body: ReadableStream<Uint8Array>,
  request: RequestInit | undefined,
  tap: TurnTap,
) {
  let message = "";
  try {
    message = String((JSON.parse(String(request?.body ?? "{}")) as { text?: string }).text ?? "");
  } catch {
    // Not a question of ours: a turn followed from its start.
  }
  tap.start(message);
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let rest = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const lines = (rest + decoder.decode(value, { stream: true })).split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) {
        const data = line.startsWith("data:") ? line.slice(5).trim() : "";
        if (data && data !== "[DONE]") {
          try {
            tap.chunk(JSON.parse(data));
          } catch {
            // Half a line or none of ours: the turn goes on without it.
          }
        }
      }
    }
  } finally {
    tap.end();
  }
}

/**
 * Messages that ask the space's AI, through `useChat`: the turn's answer streams in as the AI
 * SDK's parts. A message taken into a turn already running, or queued, comes back without one.
 * When a turn ends, the chat is read again and the streamed message gives way to the stored one.
 * `tap`: the developer mode, while it is on, hears a copy of each turn's stream.
 */
export function useAiTurn(id: string, tap?: RefObject<TurnTap | null>) {
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
          if (res.ok && res.headers.get("content-type")?.includes("application/json")) {
            return NO_TURN();
          }
          // 204: no turn to follow, and nothing to hear.
          const listening = tap?.current;
          if (!(listening && res.status === 200 && res.body)) {
            return res;
          }
          const [shown, heard] = res.body.tee();
          void hear(heard, init, listening);
          return new Response(shown, {
            status: res.status,
            statusText: res.statusText,
            headers: res.headers,
          });
        },
      }),
    [id, tap],
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

/**
 * The names of the models a turn answers with, for everyday work and for extra effort: what the
 * person chose in the settings, else the way's own. None where engenty picks them (credits).
 */
export function useTurnModels(): { normal?: string; extra?: string } {
  const me = useMe().data;
  const listed = me ? me.chatModels.ways[me.chatEngine] : undefined;
  if (!(me && listed)) {
    return {};
  }
  const chosen = me.chatModels.chosen[me.chatEngine] ?? {};
  const label = (id: string) =>
    listed.models.find((m) => m.id === id)?.label ?? id.replace(/^[a-z]+:/, "");
  return {
    normal: label(chosen.normal ?? listed.normal),
    extra: label(chosen.extra ?? listed.extra),
  };
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
  useChange(
    ({
      id,
      text,
      later,
      files,
      extra,
    }: {
      id: string;
      text: string;
      later?: boolean;
      files?: string[];
      /** For after the answer: the turn it starts works with extra effort. */
      extra?: boolean;
    }) =>
      api.post<{ sent: string }>(`${BASE}/chats/${id}/messages`, {
        text,
        ...(files?.length ? { files } : {}),
        ...(later ? { ask: true, later, ...(extra ? { extra } : {}) } : {}),
      }),
  );

/** Files for a message: each lands in the chat's space's files, and comes back as its entry there. */
export async function uploadFiles(id: string, files: File[]): Promise<PickedFile[]> {
  const added: PickedFile[] = [];
  for (const file of files) {
    const row = await api.upload<PickedFile>(`${BASE}/chats/${id}/files`, file);
    added.push({ id: row.id, name: row.name, mime: row.mime });
  }
  return added;
}

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
