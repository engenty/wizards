import { Markdown } from "@engenty/wizards-runner";
import { useQueryClient } from "@tanstack/react-query";
import type { UIMessage } from "ai";
import { Brain, Lock, MessageSquarePlus, ShieldQuestion, Sparkles, Wrench } from "lucide-react";
import { createContext, Fragment, useContext, useEffect, useState } from "react";
import { NavLink, useNavigate } from "react-router";
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
} from "@/components/ui/message-scroller";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace";
import { EngentyLogoMark } from "../../engenty/logo";
import { lang, t } from "../../lib/i18n";
import { useCurrentProject, useMe } from "../../lib/session";
import { Button, cn } from "../../ui";
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

/**
 * One chat of Work: its title, members and sub-threads, the messages in the shadcn/ui chat
 * parts, and the field to write in. A message's parts are the AI SDK's: people write text; a
 * turn of the space's AI adds its reasoning and tool calls as Trace lines (shadcn/ui AI
 * Elements, Tool).
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
  const messages = [...data.messages, ...pending(turn.messages, me ?? "")];
  const approvals = {
    approvals: new Map(data.approvals.map((a) => [a.id, a])),
    may: (a: Approval) => a.askedBy === me || role !== "member",
    decide: (approvalId: string, approve: boolean) => decide.mutate({ id: approvalId, approve }),
    busy: decide.isPending,
  };
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
          <ApprovalsContext.Provider value={approvals}>
            <MessageScrollerProvider key={id}>
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
                          <MessageScrollerItem messageId={first.id} scrollAnchor={mine}>
                            <Turn
                              group={group}
                              mine={mine}
                              author={author}
                              spaceName={project?.name ?? ""}
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
          </ApprovalsContext.Provider>
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
 * AI's answer as it streams, until the chat is read again with both stored.
 */
function pending(messages: UIMessage[], me: string): ChatMessage[] {
  return messages.map((m) => ({
    id: `pending-${m.id}`,
    author:
      m.role === "user" ? { kind: "person", id: me, name: "" } : { kind: "ai", id: "ai", name: "" },
    parts: m.parts as ChatPart[],
    createdAt: new Date().toISOString(),
  }));
}

const titleOf = (data: OpenChat | undefined) =>
  data ? data.chat.title || t("work.untitled") : t("work.chats");

function ChatHeader({ chat: data }: { chat: OpenChat }) {
  const create = useCreateChat();
  const navigate = useNavigate();
  return (
    <header className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1 border-border-soft border-b px-6 py-2">
      <h1 className="flex min-w-0 items-center gap-1.5 font-semibold text-[0.9375rem] text-ink">
        <span className="truncate">{titleOf(data)}</span>
        {data.chat.private ? (
          <Lock className="size-3.5 shrink-0 text-ink-4" aria-label={t("work.private")} />
        ) : null}
      </h1>
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
}: {
  group: ChatMessage[];
  mine: boolean;
  author: ChatMember | null;
  spaceName: string;
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
              <AiParts key={m.id} parts={m.parts} />
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

type ToolPart = Extract<ChatPart, { toolCallId: string }>;

const isTool = (p: ChatPart): p is ToolPart => p.type.startsWith("tool-") && "toolCallId" in p;

/** The chat's held calls and how to decide them, for the cards of the AI's turns. */
const ApprovalsContext = createContext<{
  approvals: Map<string, Approval>;
  may: (a: Approval) => boolean;
  decide: (id: string, approve: boolean) => void;
  busy: boolean;
}>({ approvals: new Map(), may: () => false, decide: () => {}, busy: false });

/** The approval a tool's result names, when the gate held the call. */
const heldBy = (part: ToolPart): string | null => {
  const output = part.output as { approval?: unknown; status?: unknown } | undefined;
  return output && typeof output.approval === "string" && output.status === "waiting"
    ? output.approval
    : null;
};

/** A turn of the space's AI: its steps (reasoning, tool calls) as Trace lines, then its text. */
function AiParts({ parts }: { parts: ChatPart[] }) {
  const steps = parts.filter((p) => p.type === "reasoning" || isTool(p));
  const held = steps
    .filter(isTool)
    .map(heldBy)
    .filter((id): id is string => Boolean(id));
  const text = textOf(parts);
  return (
    <div className="grid gap-3">
      {steps.length ? (
        <Trace>
          {steps.map((part, at) =>
            isTool(part) ? (
              <ToolStep key={part.toolCallId} part={part} />
            ) : (
              <TraceCollapsible key={at}>
                <TraceCollapsibleTrigger>
                  <TraceLine>
                    <TraceIcon>
                      <Brain />
                    </TraceIcon>
                    <TraceTitle>{t("work.thought")}</TraceTitle>
                  </TraceLine>
                </TraceCollapsibleTrigger>
                <TraceCollapsibleContent>
                  <p className="whitespace-pre-wrap text-[0.8125rem]">
                    {String((part as { text?: string }).text ?? "")}
                  </p>
                </TraceCollapsibleContent>
              </TraceCollapsible>
            ),
          )}
        </Trace>
      ) : null}
      {held.map((id) => (
        <ApprovalCard key={id} id={id} />
      ))}
      {text ? <Markdown text={text} className="text-[0.9375rem]" /> : null}
    </div>
  );
}

/** A held call (shadcn/ui AI Elements, Confirmation): what the AI wants to do, Approve or Deny. */
function ApprovalCard({ id }: { id: string }) {
  const { approvals, may, decide, busy } = useContext(ApprovalsContext);
  const approval = approvals.get(id);
  if (!approval) {
    return null;
  }
  const input = JSON.stringify(approval.input ?? {}, null, 2);
  const state =
    approval.state === "approved"
      ? t("work.approval.approved")
      : approval.state === "denied"
        ? t("work.approval.denied")
        : approval.state === "failed"
          ? t("work.approval.failed")
          : null;
  return (
    <div className="grid gap-2 rounded-xl border border-border bg-card/40 p-3 text-[0.875rem]">
      <p className="flex items-center gap-2 font-medium text-ink">
        <ShieldQuestion className="size-4 shrink-0 text-ember" />
        {t("work.approval.waiting", { name: approval.toolName })}
      </p>
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-ink/5 p-2 font-mono text-[0.75rem]">
        {input}
      </pre>
      {state ? (
        <p className="text-ink-3">{state}</p>
      ) : may(approval) ? (
        <div className="flex gap-2">
          <Button size="sm" disabled={busy} onClick={() => decide(approval.id, true)}>
            {t("work.approval.approve")}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => decide(approval.id, false)}
          >
            {t("work.approval.deny")}
          </Button>
        </div>
      ) : (
        <p className="text-ink-3">{t("work.approval.notYours")}</p>
      )}
    </div>
  );
}

/** One tool call by the state the AI SDK gives it (shadcn/ui AI Elements, Tool's table). */
function ToolStep({ part }: { part: ToolPart }) {
  const { approvals } = useContext(ApprovalsContext);
  const name = part.type.slice("tool-".length);
  const icon = (
    <TraceIcon>
      <Wrench />
    </TraceIcon>
  );
  // Held by the gate: the line says what the person decided (the card below has the details).
  const held = part.state === "output-available" ? heldBy(part) : null;
  if (held) {
    const decided = approvals.get(held)?.state ?? "pending";
    return (
      <TraceLine
        status={decided === "pending" ? "pending" : decided === "failed" ? "error" : undefined}
      >
        {icon}
        <TraceTitle>
          {decided === "approved"
            ? t("work.tool.ran", { name })
            : decided === "denied"
              ? t("work.tool.denied", { name })
              : decided === "failed"
                ? t("work.tool.failed", { name })
                : t("work.tool.asks", { name })}
        </TraceTitle>
      </TraceLine>
    );
  }
  if (part.state === "output-available" || part.state === "output-error") {
    const failed = part.state === "output-error";
    return (
      <TraceCollapsible>
        <TraceCollapsibleTrigger>
          <TraceLine status={failed ? "error" : undefined}>
            {icon}
            <TraceTitle>{t(failed ? "work.tool.failed" : "work.tool.ran", { name })}</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-ink/5 p-2 font-mono text-[0.75rem]">
            {failed ? part.errorText : JSON.stringify(part.output, null, 2)}
          </pre>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    );
  }
  const title =
    part.state === "output-denied"
      ? t("work.tool.denied", { name })
      : part.state === "approval-requested"
        ? t("work.tool.asks", { name })
        : t("work.tool.running", { name });
  return (
    <TraceLine
      status={
        part.state === "output-denied"
          ? undefined
          : part.state === "approval-requested"
            ? "pending"
            : "running"
      }
    >
      {icon}
      <TraceTitle>{title}</TraceTitle>
    </TraceLine>
  );
}
