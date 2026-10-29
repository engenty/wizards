import { useQueryClient } from "@tanstack/react-query";
import type { UIMessage } from "ai";
import { Lock, MessageSquarePlus, Sparkles } from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Marker, MarkerContent } from "@/components/ui/marker";
import {
  Message,
  MessageAvatar,
  MessageContent,
  MessageGroup,
  MessageHeader,
} from "@/components/ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
} from "@/components/ui/message-scroller";
import { EngentyLogoMark } from "../../engenty/logo";
import { lang, t } from "../../lib/i18n";
import { useCurrentProject, useMe } from "../../lib/session";
import { cn } from "../../ui";
import { Composer } from "../../ui/composer";
import { useCrumbs } from "../AppFrame";
import {
  type Approval,
  type ChatMember,
  type ChatMessage,
  type ChatPart,
  type OpenChat,
  stopTurn,
  useAiTurn,
  useCreateChat,
  useDecide,
  useOpenChat,
  usePostMessage,
} from "./chats";
import { AiParts, StepsContext } from "./Steps";

/**
 * One chat of Work: its title, members and sub-threads, the messages in the shadcn/ui chat
 * parts, and the field to write in. A message's parts are the AI SDK's: people write text; a
 * turn of the space's AI adds its reasoning and tool calls as steps (Steps.tsx).
 */

export function ChatView({ id }: { id: string }) {
  const turn = useAiTurn(id);
  const streaming = turn.status === "submitted" || turn.status === "streaming";
  const { data, isError } = useOpenChat(id, streaming);
  const meData = useMe().data;
  const me = meData?.user.id;
  const role = meData?.tenant.role ?? "member";
  const decide = useDecide(id);
  const post = usePostMessage();
  const [askChoice, setAskChoice] = useState<boolean | null>(null);
  // Someone else's turn runs here: follow it from its start (useChat's resume), once per turn.
  const answering = data?.chat.answeringSince ?? null;
  const followed = useRef<string | null>(null);
  useEffect(() => {
    if (answering && !streaming && followed.current !== answering) {
      followed.current = answering;
      void turn.resumeStream();
    }
  }, [answering, streaming, turn]);
  // A question from Work's start comes along with the new chat: asked once the chat is read.
  const location = useLocation();
  const navigate = useNavigate();
  const handedOver = (location.state as { ask?: string } | null)?.ask;
  const loaded = Boolean(data);
  const askedFor = useRef<string | null>(null);
  useEffect(() => {
    if (handedOver && loaded && askedFor.current !== location.key) {
      askedFor.current = location.key;
      navigate(location.pathname, { replace: true, state: null });
      void turn.sendMessage({ text: handedOver });
    }
  }, [handedOver, loaded, navigate, location.key, location.pathname, turn]);
  // How often each of the person's texts was stored when its pending copy first showed.
  const storedBefore = useRef(new Map<string, number>());
  const { project } = useCurrentProject();
  const client = useQueryClient();
  const opened = data?.chat.id;
  // Opening a chat marks it read: the sidebar loses its dot at once.
  useEffect(() => {
    if (opened) {
      client.invalidateQueries({ queryKey: ["work-chats"] });
    }
  }, [opened, client]);
  useCrumbs([{ label: t("work.chats"), to: "/work" }, { label: titleOf(data) }]);

  if (isError) {
    return <p className="m-auto text-ink-3">{t("work.chatGone")}</p>;
  }
  if (!data) {
    return <div className="flex-1" />;
  }
  const names = new Map(data.members.map((m) => [`${m.kind}:${m.id}`, m]));
  // Alone with the AI, every message asks it; with more people, the button or an "@" does.
  const people = data.members.filter((m) => m.kind === "person").length;
  const ask = askChoice ?? people <= 1;
  const messages = [
    ...data.messages,
    ...pending(turn.messages, me ?? "", data.messages, storedBefore.current),
  ];
  const approvals = {
    approvals: new Map(data.approvals.map((a) => [a.id, a])),
    may: (a: Approval) => a.askedBy === me || role !== "member",
    decide: (approvalId: string, approve: boolean) => decide.mutate({ id: approvalId, approve }),
    busy: decide.isPending,
    tools: data.tools ?? {},
  };
  // The AI's answer streaming right now: the last message, while it is still `useChat`'s.
  const last = messages.at(-1);
  const liveId =
    streaming && last?.author.kind === "ai" && last.id.startsWith("pending-") ? last.id : null;
  const authorOf = (m: ChatMessage): ChatMember | null =>
    m.author.kind === "ai"
      ? null
      : (names.get(`person:${m.author.id}`) ?? {
          kind: "person",
          id: m.author.id,
          name: m.author.name,
          image: null,
        });

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <ChatHeader chat={data} />
      <div className="min-h-0 flex-1">
        {messages.length ? (
          <StepsContext.Provider value={approvals}>
            {/* Whoever reads at the end stays there as messages and answers come in. */}
            <MessageScrollerProvider key={id} autoScroll>
              <EndOnSend
                sent={
                  messages.filter((m) => m.author.kind === "person" && m.author.id === me).length
                }
              />
              <MessageScroller>
                <MessageScrollerViewport>
                  <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-4 px-6 py-6">
                    {groups(messages).map((group, at, all) => {
                      const first = group[0];
                      const mine = first.author.kind === "person" && first.author.id === me;
                      const author = authorOf(first);
                      const day = dayOf(first.createdAt);
                      const newDay = at === 0 || dayOf(all[at - 1][0].createdAt) !== day;
                      return (
                        <Fragment key={first.id}>
                          {newDay ? (
                            <Marker variant="separator">
                              <MarkerContent>{dayLabel(first.createdAt)}</MarkerContent>
                            </Marker>
                          ) : null}
                          <MessageScrollerItem messageId={first.id}>
                            <Turn
                              group={group}
                              mine={mine}
                              author={author}
                              spaceName={project?.name ?? ""}
                              liveId={liveId}
                            />
                          </MessageScrollerItem>
                        </Fragment>
                      );
                    })}
                  </MessageScrollerContent>
                </MessageScrollerViewport>
                <MessageScrollerButton />
              </MessageScroller>
            </MessageScrollerProvider>
          </StepsContext.Provider>
        ) : (
          <p className="grid h-full place-items-center text-[0.9375rem] text-ink-3">
            {t("work.emptyChat")}
          </p>
        )}
      </div>
      <div className="mx-auto grid w-full max-w-3xl gap-2 px-6 pb-5">
        {turn.error ? (
          <p className="text-[0.8125rem] text-danger">
            {t("work.turnFailed", { message: turn.error.message })}
          </p>
        ) : null}
        <div className="flex">
          <button
            type="button"
            aria-pressed={ask}
            onClick={() => setAskChoice(!ask)}
            className={cn(
              "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.8125rem] transition",
              ask ? "bg-ember/15 text-ink" : "text-ink-3 hover:bg-ink/5 hover:text-ink",
            )}
          >
            <Sparkles className="size-3.5" />
            {t("work.askAi", { name: project?.name ?? "" })}
          </button>
        </div>
        <Composer
          key={id}
          autoFocus
          attach={false}
          busy={streaming}
          onStop={() => {
            void turn.stop();
            void stopTurn(id);
          }}
          placeholder={ask ? t("work.writeAsk") : t("work.write")}
          onSend={async (raw, _files, later) => {
            const text = raw.trim();
            if (!text) {
              return false;
            }
            if (later && streaming) {
              await post.mutateAsync({ id, text, later: true });
            } else if (ask || text.startsWith("@")) {
              void turn.sendMessage({ text });
            } else {
              await post.mutateAsync({ id, text });
            }
            return true;
          }}
        />
      </div>
    </div>
  );
}

/**
 * What `useChat` holds of a turn under way, as the chat's messages: the person's message and the
 * AI's answer as it streams, until the chat is read again with both stored. The person's message
 * is stored when it is sent, so its copy here goes as soon as the chat read again has it: one
 * more stored message of the same text than when the copy first showed.
 */
function pending(
  messages: UIMessage[],
  me: string,
  stored: ChatMessage[],
  storedBefore: Map<string, number>,
): ChatMessage[] {
  const times = (text: string) =>
    stored.filter(
      (m) => m.author.kind === "person" && m.author.id === me && textOf(m.parts) === text,
    ).length;
  return messages.flatMap((m): ChatMessage[] => {
    if (m.role === "user") {
      const text = textOf(m.parts as ChatPart[]);
      if (!storedBefore.has(m.id)) {
        storedBefore.set(m.id, times(text));
      }
      if (times(text) > (storedBefore.get(m.id) ?? 0)) {
        return [];
      }
    }
    return [
      {
        id: `pending-${m.id}`,
        author:
          m.role === "user"
            ? { kind: "person", id: me, name: "" }
            : { kind: "ai", id: "ai", name: "" },
        parts: m.parts as ChatPart[],
        createdAt: new Date().toISOString(),
      },
    ];
  });
}

/** The person sent a message: back to the end, where it and the answer show, wherever they read. */
function EndOnSend({ sent }: { sent: number }) {
  const { scrollToEnd } = useMessageScroller();
  const before = useRef(sent);
  useEffect(() => {
    if (sent > before.current) {
      scrollToEnd({ behavior: "smooth" });
    }
    before.current = sent;
  }, [sent, scrollToEnd]);
  return null;
}

const titleOf = (data: OpenChat | undefined) =>
  data ? data.chat.title || t("work.untitled") : t("work.chats");

function ChatHeader({ chat: data }: { chat: OpenChat }) {
  const create = useCreateChat();
  const navigate = useNavigate();
  return (
    <header className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1 border-border-soft border-b px-6 py-2">
      {/* The title stands in the top bar's trail; here what belongs to the chat. */}
      {data.chat.private ? (
        <Lock className="size-3.5 shrink-0 text-ink-4" aria-label={t("work.private")} />
      ) : null}
      <div className="-space-x-1.5 flex" title={data.members.map((m) => m.name).join(", ")}>
        {data.members.slice(0, 5).map((m) => (
          <Avatar key={`${m.kind}:${m.id}`} member={m} className="ring-2 ring-canvas" />
        ))}
      </div>
      <div className="ml-auto flex flex-wrap items-center gap-1.5">
        {data.threads.map((thread) => (
          <NavLink
            key={thread.id}
            to={`/work/c/${thread.id}`}
            className="max-w-48 truncate rounded-full bg-ink/5 px-2.5 py-1 text-[0.8125rem] text-ink-2 hover:bg-ink/10"
          >
            {thread.title || t("work.untitled")}
          </NavLink>
        ))}
        <button
          type="button"
          onClick={async () => {
            const thread = await create.mutateAsync({ parentId: data.chat.id });
            navigate(`/work/c/${thread.id}`);
          }}
          className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.8125rem] text-ink-3 hover:bg-ink/5 hover:text-ink"
        >
          <MessageSquarePlus className="size-3.5" />
          {t("work.newThread")}
        </button>
        {data.chat.parentId ? (
          <NavLink
            to={`/work/c/${data.chat.parentId}`}
            className="rounded-full px-2.5 py-1 text-[0.8125rem] text-ink-3 hover:bg-ink/5 hover:text-ink"
          >
            {t("work.toParent")}
          </NavLink>
        ) : null}
      </div>
    </header>
  );
}

function Avatar({ member, className }: { member?: ChatMember; className?: string }) {
  const initials = (member?.name ?? "?")
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return member?.image ? (
    <img
      src={member.image}
      alt=""
      className={`size-7 shrink-0 rounded-full object-cover ${className ?? ""}`}
    />
  ) : (
    <span
      className={`grid size-7 shrink-0 place-items-center rounded-full bg-ink/10 font-semibold text-[0.6875rem] text-ink-2 ${className ?? ""}`}
    >
      {initials}
    </span>
  );
}

/** Consecutive messages of one author within five minutes read as one turn. */
function groups(messages: ChatMessage[]): ChatMessage[][] {
  const out: ChatMessage[][] = [];
  for (const m of messages) {
    const last = out.at(-1)?.at(-1);
    if (
      last &&
      last.author.kind === m.author.kind &&
      last.author.id === m.author.id &&
      Date.parse(m.createdAt) - Date.parse(last.createdAt) < 5 * 60_000
    ) {
      out.at(-1)?.push(m);
    } else {
      out.push([m]);
    }
  }
  return out;
}

const dayOf = (iso: string) => new Date(iso).toDateString();

function dayLabel(iso: string) {
  const day = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (day.toDateString() === today.toDateString()) {
    return t("work.today");
  }
  if (day.toDateString() === yesterday.toDateString()) {
    return t("work.yesterday");
  }
  return day.toLocaleDateString(lang, { weekday: "long", day: "numeric", month: "long" });
}

const timeOf = (iso: string) =>
  new Date(iso).toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" });

/** One author's turn. The space's AI shows as the space's name with the engenty figure. */
function Turn({
  group,
  mine,
  author,
  spaceName,
  liveId,
}: {
  group: ChatMessage[];
  mine: boolean;
  author: ChatMember | null;
  spaceName: string;
  liveId: string | null;
}) {
  const ai = group[0].author.kind === "ai";
  return (
    <Message align={mine ? "end" : "start"}>
      {mine ? null : (
        <MessageAvatar className="min-w-0 self-start bg-transparent">
          {ai ? <EngentyLogoMark size={28} /> : <Avatar member={author ?? undefined} />}
        </MessageAvatar>
      )}
      <MessageContent>
        <MessageHeader className={mine ? "justify-end" : undefined}>
          {mine ? t("work.you") : ai ? spaceName : (author?.name ?? "")}
          <span className="ml-2 font-normal text-ink-4">{timeOf(group[0].createdAt)}</span>
        </MessageHeader>
        <MessageGroup>
          {group.map((m) =>
            ai ? (
              <AiParts key={m.id} id={m.id} parts={m.parts} live={m.id === liveId} />
            ) : (
              <Bubble
                key={m.id}
                align={mine ? "end" : "start"}
                variant={mine ? "muted" : "outline"}
              >
                <BubbleContent className="whitespace-pre-wrap text-[0.9375rem]">
                  {textOf(m.parts)}
                </BubbleContent>
              </Bubble>
            ),
          )}
        </MessageGroup>
      </MessageContent>
    </Message>
  );
}

const textOf = (parts: ChatPart[]) =>
  parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n");
