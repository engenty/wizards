import { Markdown } from "@engenty-wizards/runner";
import type { AssistantStep } from "@engenty-wizards/shared/assistant";
import type { WizardDefinition } from "@engenty-wizards/shared/definition";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, Paperclip, Plug, Sparkles } from "lucide-react";
import { Fragment, type ReactNode, useEffect, useRef, useState } from "react";
import { Mascot } from "../../brand";
import { postStream } from "../../lib/api";
import { withBase } from "../../lib/base";
import { lang, t } from "../../lib/i18n";
import type { WizardDetail } from "../../lib/session";
import { Composer, type ComposerHandle, cn, pastedName, Spinner } from "../../ui";

/** What a plugin's tool returned in a turn, for the plugin's card in the thread. */
export interface ChatCard {
  id: string;
  plugin: string;
  tool: string;
  data: unknown;
}

/** A tool the assistant called in a turn (AG-UI's tool call), for a line under its answer. */
export interface ChatToolCall {
  toolCallId: string;
  toolCallName: string;
  args: unknown;
  result?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** Cards of plugins' tools, below the answer's text. */
  cards?: ChatCard[];
  toolCalls?: ChatToolCall[];
  changed?: boolean;
  pending?: boolean;
  source?: "studio" | "mcp";
  client?: string | null;
  /** Pictures sent with this message, by file name, shown before the server has them. */
  previews?: Record<string, string>;
  /** Written while the answer before it was under way, and taken into that turn. */
  signal?: boolean;
  /** The model's steps of this answer, in the studio assistant's developer mode. */
  steps?: AssistantStep[];
}

const IMAGE = /\.(png|jpe?g|gif|webp|avif|svg)$/i;

/** Local URLs for the pictures among `files`, so the thread shows them right away. */
export function previewsOf(files: File[]): Record<string, string> | undefined {
  const images = files.filter((f) => f.type.startsWith("image/"));
  return images.length
    ? Object.fromEntries(images.map((f) => [f.name, URL.createObjectURL(f)]))
    : undefined;
}

/** A message's own text and the files its last line names ("Angehängt: a.png, b.pdf"). */
function attachmentsOf(content: string): { text: string; names: string[] } {
  const match = content.match(/(?:^|\n\n)(?:Angehängt|Attached): ([^\n]+)$/);
  if (!match) {
    return { text: content, names: [] };
  }
  return {
    text: content.slice(0, match.index).trim(),
    names: match[1].split(", ").filter(Boolean),
  };
}

/** The pictures and files a user message carries, above its bubble. */
function Attachments({
  names,
  previews,
  fileUrl,
}: {
  names: string[];
  previews?: Record<string, string>;
  fileUrl?: (name: string) => string;
}) {
  const images = names.filter((n) => previews?.[n] || (fileUrl && IMAGE.test(n)));
  const others = names.filter((n) => !images.includes(n));
  return (
    <div className="flex flex-col items-end gap-1.5">
      {images.map((name) => {
        const url = previews?.[name] ?? fileUrl?.(name) ?? "";
        return (
          <a key={name} href={url} target="_blank" rel="noreferrer" title={name}>
            <img
              src={url}
              alt={name}
              className="max-h-60 w-auto max-w-full rounded-xl bg-paper-2 object-contain ring-1 ring-border"
            />
          </a>
        );
      })}
      {others.length ? (
        <div className="flex flex-wrap justify-end gap-1.5">
          {others.map((name) => (
            <span
              key={name}
              className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-paper-2 px-2.5 py-1 text-[0.75rem] text-ink-2"
            >
              <Paperclip className="size-3 shrink-0 text-ink-4" />
              <span className="truncate">{name}</span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function useArchitectChat(
  wizard: WizardDetail | undefined,
  onChanged: (draft: WizardDefinition, revision: number) => void,
) {
  const qc = useQueryClient();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [phase, setPhase] = useState<"idle" | "thinking" | "building">("idle");
  const [error, setError] = useState<string | null>(null);
  const [activity, setActivity] = useState<string | null>(null);
  const [thought, setThought] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const loadedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!wizard) {
      return;
    }
    if (loadedFor.current !== wizard.id) {
      loadedFor.current = wizard.id;
      setMessages(wizard.messages);
      return;
    }
    // Between turns the server's thread is the truth — it also carries notes an MCP client left.
    // A turn's optimistic messages stay until the server has them (it may still be refetching).
    if (phase === "idle") {
      setMessages((local) => (wizard.messages.length >= local.length ? wizard.messages : local));
    }
  }, [wizard, phase]);

  /** False when nothing was sent: the composer keeps its draft and files. */
  const send = async (text: string, files: File[] = []): Promise<boolean> => {
    if (!wizard || !(text.trim() || files.length) || phase !== "idle") {
      return false;
    }
    setError(null);
    setStartedAt(Date.now());
    setThought(null);
    if (files.length) {
      // Files go into the wizard's workspace; the message names them.
      setPhase("thinking");
      try {
        for (const file of files) {
          const res = await fetch(
            withBase(`/api/studio/wizards/${wizard.id}/files/${encodeURIComponent(file.name)}`),
            {
              method: "PUT",
              credentials: "include",
              headers: {
                "content-type": file.type || "application/octet-stream",
                "accept-language": lang,
              },
              body: file,
            },
          );
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(body.error ?? res.statusText);
          }
        }
      } catch (err) {
        setError((err as Error).message);
        setPhase("idle");
        setStartedAt(null);
        await qc.invalidateQueries({ queryKey: ["wizard", wizard.id] });
        return false;
      }
      const named = `${t("editor.attached")}: ${files.map((f) => f.name).join(", ")}`;
      text = text.trim() ? `${text}\n\n${named}` : named;
    }
    const pendingId = `p-${Date.now()}`;
    setMessages((m) => [
      ...m,
      { id: `u-${Date.now()}`, role: "user", content: text, previews: previewsOf(files) },
      { id: pendingId, role: "assistant", content: "", pending: true },
    ]);
    setPhase("thinking");
    setActivity(null);
    let answered = false;
    try {
      await postStream(
        `/api/studio/wizards/${wizard.id}/chat`,
        { message: text },
        (event, data) => {
          if (event === "text") {
            const delta = JSON.parse(data) as string;
            setMessages((m) =>
              m.map((x) => (x.id === pendingId ? { ...x, content: x.content + delta } : x)),
            );
          } else if (event === "activity") {
            setActivity(JSON.parse(data) as string);
          } else if (event === "thought") {
            setThought(JSON.parse(data) as string);
          } else if (event === "building") {
            setPhase("building");
          } else if (event === "done") {
            answered = true;
            const done = JSON.parse(data) as {
              reply: string;
              changed: boolean;
              draft: WizardDefinition;
              revision: number;
            };
            setMessages((m) =>
              m.map((x) =>
                x.id === pendingId
                  ? { ...x, content: done.reply, changed: done.changed, pending: false }
                  : x,
              ),
            );
            if (done.changed) {
              onChanged(done.draft, done.revision);
            }
          } else if (event === "error") {
            answered = true;
            setError(JSON.parse(data).message);
          }
        },
      );
      if (!answered) {
        setError(t("editor.chatBroken"));
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setActivity(null);
      setThought(null);
      setStartedAt(null);
      setMessages((m) =>
        m.filter((x) => !(x.id === pendingId && !x.content)).map((x) => ({ ...x, pending: false })),
      );
      setPhase("idle");
      await qc.invalidateQueries({ queryKey: ["wizard", wizard.id] });
      await qc.invalidateQueries({ queryKey: ["me"] });
    }
    return true;
  };

  const fileUrl = (name: string) =>
    withBase(`/api/studio/wizards/${wizard?.id}/files/${encodeURIComponent(name)}`);

  return { messages, phase, activity, thought, startedAt, error, send, fileUrl };
}

/** What the panel shows and sends; the architect's chat and the project assistant both are one. */
export type Chat = Pick<
  ReturnType<typeof useArchitectChat>,
  "messages" | "phase" | "activity" | "startedAt" | "error" | "send"
> & {
  thought?: string | null;
  /** Where a file the thread names can be loaded from, once the message is the server's. */
  fileUrl?: (name: string) => string;
};

/** Seconds since `since`, counting up once a second; null while nothing runs. */
function useElapsed(since: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) {
      return;
    }
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  return since === null ? null : Math.max(0, Math.floor((now - since) / 1000));
}

function elapsed(seconds: number): string {
  return seconds < 60
    ? `${seconds} s`
    : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} min`;
}

/** What a running turn does, for how long, and — with `thought` — the line it is thinking about. */
export function Working({
  chat,
  thought,
  className,
  spinner = "size-3.5",
}: {
  chat: Chat;
  thought?: boolean;
  className?: string;
  spinner?: string;
}) {
  const seconds = useElapsed(chat.startedAt);
  return (
    <div className={cn("min-w-0", className)}>
      <div className="flex min-w-0 items-center gap-2">
        <Spinner className={cn("shrink-0", spinner)} />
        <span className="min-w-0 truncate">
          {chat.activity ??
            (chat.phase === "building" ? t("editor.building") : t("editor.thinking"))}
        </span>
        {seconds === null ? null : (
          <span className="shrink-0 text-ink-4 tabular-nums">{elapsed(seconds)}</span>
        )}
      </div>
      {thought && chat.thought ? (
        <p className="mt-0.5 truncate pl-5.5 text-[0.75rem] text-ink-4">{chat.thought}</p>
      ) : null}
    </div>
  );
}

function UserMessage({
  message,
  fileUrl,
}: {
  message: ChatMessage;
  fileUrl?: (name: string) => string;
}) {
  const { text, names } = attachmentsOf(message.content);
  return (
    <div className="ml-8 flex flex-col items-end gap-1.5 self-end">
      {message.signal ? (
        <span className="text-[0.6875rem] text-ink-4">{t("assistant.signalled")}</span>
      ) : null}
      {names.length ? (
        <Attachments names={names} previews={message.previews} fileUrl={fileUrl} />
      ) : null}
      {text ? (
        <div className="rounded-xl rounded-br-md bg-paper-2 px-4 py-2.5 text-[0.875rem] leading-relaxed">
          <span className="whitespace-pre-wrap">{text}</span>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The thread's messages: the person's on the right, the assistant's with its avatar, the cards
 * of plugins' tools and `calls` (a line per tool it called) above an answer, `foot` below it.
 */
export function Messages({
  chat,
  avatar,
  changedLabel,
  card,
  calls,
  foot,
}: {
  chat: Chat;
  avatar: string;
  changedLabel: string;
  card?: (card: ChatCard) => ReactNode;
  calls?: (message: ChatMessage) => ReactNode;
  foot?: (message: ChatMessage) => ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4">
      {chat.messages.map((m) =>
        m.role === "user" ? (
          <UserMessage key={m.id} message={m} fileUrl={chat.fileUrl} />
        ) : (
          <div key={m.id} className="flex items-start gap-3">
            <div className="shrink-0">
              <Mascot kind={avatar} size={28} interactive={false} />
            </div>
            <div className="min-w-0 pt-0.5 text-[0.875rem]">
              {m.source === "mcp" ? (
                <div className="mb-1 inline-flex items-center gap-1.5 text-[0.75rem] text-ink-3">
                  <Plug className="size-3" /> {t("editor.viaClient", { client: m.client ?? "MCP" })}
                </div>
              ) : null}
              {calls ? calls(m) : null}
              {m.content ? <Markdown text={m.content} className="text-[0.875rem]" /> : null}
              {card && m.cards?.length ? (
                <div className="mt-2 flex flex-col gap-2">
                  {m.cards.map((c) => (
                    <Fragment key={c.id}>{card(c)}</Fragment>
                  ))}
                </div>
              ) : null}
              {m.pending ? (
                <Working chat={chat} thought className="mt-1 text-[0.8125rem] text-ink-3" />
              ) : null}
              {m.changed ? (
                <div className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-ember-tint px-2.5 py-0.5 text-[0.75rem] text-ember-strong">
                  <Sparkles className="size-3" /> {changedLabel}
                </div>
              ) : null}
              {foot ? foot(m) : null}
            </div>
          </div>
        ),
      )}
    </div>
  );
}

const THREAD_KEY = "wizards.editorThread.height";
const THREAD_DEFAULT = 320;
const THREAD_MIN = 120;
/** The docked thread leaves the page this much room above it. */
const threadMax = () => Math.max(THREAD_MIN, window.innerHeight - 260);

/** The docked thread's height, dragged at its grip; remembered per browser. */
function useThreadHeight() {
  const [height, setHeight] = useState(() => {
    try {
      const n = Number(localStorage.getItem(THREAD_KEY));
      return n ? Math.min(Math.max(n, THREAD_MIN), threadMax()) : THREAD_DEFAULT;
    } catch {
      return THREAD_DEFAULT;
    }
  });
  const set = (next: number) => {
    const h = Math.round(Math.min(Math.max(next, THREAD_MIN), threadMax()));
    setHeight(h);
    try {
      localStorage.setItem(THREAD_KEY, String(h));
    } catch {
      // the height only lasts this page then
    }
  };
  return { height, set };
}

/**
 * The grip on top of the docked thread: dragged, it sets the thread's height and opens a folded
 * one; clicked, it folds the thread in or out. Arrow keys change the height, Enter folds.
 */
function ThreadGrip({
  open,
  height,
  onHeight,
  onToggle,
}: {
  open: boolean;
  height: number;
  onHeight: (h: number) => void;
  onToggle: (open: boolean) => void;
}) {
  const start = useRef<{ y: number; height: number; moved: boolean } | null>(null);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a window splitter that moves is a focusable separator (WAI-ARIA)
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="horizontal"
      aria-valuenow={height}
      aria-valuemin={THREAD_MIN}
      aria-label={t("editor.threadGrip")}
      title={t("editor.threadGrip")}
      onPointerDown={(e) => {
        if (e.button !== 0) {
          return;
        }
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { y: e.clientY, height: open ? height : 0, moved: false };
      }}
      onPointerMove={(e) => {
        const from = start.current;
        if (!from || (!from.moved && Math.abs(e.clientY - from.y) < 4)) {
          return;
        }
        if (!(open || from.moved) && e.clientY > from.y) {
          return;
        }
        if (!(open || from.moved)) {
          onToggle(true);
        }
        from.moved = true;
        onHeight(from.height + (from.y - e.clientY));
      }}
      onPointerUp={() => {
        const click = start.current && !start.current.moved;
        start.current = null;
        if (click) {
          onToggle(!open);
        }
      }}
      onPointerCancel={() => {
        start.current = null;
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          if (!open) {
            if (e.key === "ArrowUp") {
              onToggle(true);
            }
            return;
          }
          onHeight(height + (e.key === "ArrowUp" ? 32 : -32));
        } else if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggle(!open);
        }
      }}
      className="group flex h-3.5 shrink-0 cursor-row-resize touch-none items-center justify-center outline-none"
    >
      <span className="h-1 w-10 rounded-full bg-ink-4/40 transition group-hover:bg-ink-4 group-focus-visible:bg-ember" />
    </div>
  );
}

export function ChatPanel({
  chat,
  avatar,
  hello = t("editor.chatHello"),
  placeholder = t("editor.composer"),
  changedLabel = t("editor.flowChanged"),
  compact,
  intro,
  closed,
  card,
}: {
  chat: Chat;
  avatar: string;
  hello?: string;
  placeholder?: string;
  changedLabel?: string;
  /** Only the composer and one line about the last turn; the thread opens on demand. */
  compact?: boolean;
  /** What an empty thread shows in place of the avatar with `hello`. */
  intro?: ReactNode;
  /** Nothing is sent here: this note stands in place of the composer, the thread is there to read. */
  closed?: string;
  /** Draws a card of a plugin's tool; without it, cards are not shown. */
  card?: (card: ChatCard) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const threadHeight = useThreadHeight();
  const scroller = useRef<HTMLDivElement>(null);
  const composer = useRef<ComposerHandle>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on new content
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [chat.messages, chat.phase]);
  const thread = !compact || open;
  const last = chat.messages.at(-1);
  // Files dropped anywhere on the conversation are attached to the next message. Entering and
  // leaving the children is counted, so the drop sign does not flicker.
  const [drag, setDrag] = useState(false);
  const depth = useRef(0);
  const takes = (e: React.DragEvent) => !closed && e.dataTransfer.types.includes("Files");
  return (
    <div
      className="relative flex h-full min-h-0 flex-col"
      onDragEnter={(e) => {
        if (!takes(e)) {
          return;
        }
        e.preventDefault();
        depth.current += 1;
        setDrag(true);
      }}
      onDragOver={(e) => {
        if (takes(e)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }
      }}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) {
          setDrag(false);
        }
      }}
      onDrop={(e) => {
        if (!takes(e)) {
          return;
        }
        e.preventDefault();
        depth.current = 0;
        setDrag(false);
        composer.current?.add(Array.from(e.dataTransfer.files).map(pastedName));
        composer.current?.focus();
      }}
    >
      {drag ? (
        <div className="pointer-events-none absolute inset-3 z-20 flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-ember border-dashed bg-ember-veil text-[0.875rem] text-ember-strong">
          <Paperclip className="size-6" />
          {t("editor.dropToAttach")}
        </div>
      ) : null}
      {/* Docked, the last turn and the thread are a card of their own above the composer. */}
      <div
        className={
          compact
            ? cn(
                "mb-2 flex min-h-0 flex-col overflow-hidden rounded-2xl bg-card shadow-overlay ring-1 ring-border",
                !(last || chat.error) && "hidden",
              )
            : "contents"
        }
      >
        {compact && (last || chat.error) ? (
          <ThreadGrip
            open={open}
            height={threadHeight.height}
            onHeight={threadHeight.set}
            onToggle={setOpen}
          />
        ) : null}
        {compact && (last || chat.error) ? (
          <button
            type="button"
            aria-expanded={open}
            aria-label={t("editor.thread")}
            onClick={() => setOpen((o) => !o)}
            className="flex items-center gap-2 px-4 pb-0.5 text-left text-[0.8125rem] text-ink-3 transition hover:text-ink"
          >
            {!(chat.error || open) && last?.pending ? (
              <Working chat={chat} className="flex-1" />
            ) : (
              <span className={cn("min-w-0 flex-1 truncate", chat.error && "text-rose")}>
                {chat.error ?? (open ? t("editor.thread") : last?.content)}
              </span>
            )}
            {open ? (
              <ChevronDown className="size-4 shrink-0" />
            ) : (
              <ChevronUp className="size-4 shrink-0" />
            )}
          </button>
        ) : null}
        <div
          ref={scroller}
          className={cn("min-h-0 flex-1 overflow-y-auto px-5 py-5", !thread && "hidden")}
          // Docked, the thread is as high as its grip was pulled.
          style={compact ? { height: threadHeight.height, flex: "none" } : undefined}
        >
          {chat.messages.length === 0 && !closed
            ? (intro ?? (
                <div className="flex items-start gap-3">
                  <Mascot kind={avatar} size={32} interactive={false} />
                  <p className="pt-1 text-[0.875rem] text-ink-2 leading-relaxed">{hello}</p>
                </div>
              ))
            : null}
          <Messages chat={chat} avatar={avatar} changedLabel={changedLabel} card={card} />
          {chat.error ? (
            <div className="mt-4 rounded-lg bg-rose-tint px-3 py-2 text-[0.8125rem] text-rose">
              {chat.error}
            </div>
          ) : null}
        </div>
      </div>
      {closed ? (
        <p className="m-3 rounded-xl bg-paper-2 px-4 py-3 text-[0.8125rem] text-ink-2 leading-relaxed">
          {closed}
        </p>
      ) : (
        <Composer
          ref={composer}
          floating={compact}
          className={compact ? undefined : "p-3"}
          placeholder={placeholder}
          disabled={chat.phase !== "idle"}
          onSend={(text, files) => chat.send(text, files)}
        />
      )}
    </div>
  );
}
