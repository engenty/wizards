import type {
  AssistantEvents,
  AssistantLayout,
  AssistantPrompt,
} from "@engenty-wizards/shared/assistant";
import type { ProjectFileKind } from "@engenty-wizards/shared/projects";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router";
import { api, postStream } from "../../lib/api";
import { lang, t } from "../../lib/i18n";
import { useCurrentProject, useMe } from "../../lib/session";
import { useStudioPlugins } from "../../plugins/host";
import type { Chat, ChatCard, ChatMessage, ChatToolCall } from "../editor/ChatPanel";
import { previewsOf } from "../editor/ChatPanel";
import { settingsSections } from "../settings-sections";
import { setDockPrefs, useDockPrefs } from "./dock";
import { type LiveChat, useLiveChat } from "./live";
import { pageChanged, pageSnapshot } from "./page";
import { bindNavigation, browserTools, runBrowserTool, setHighlight } from "./tools";

/**
 * The studio assistant's one chat, above the routes: it stays while the person moves between
 * pages, and the assistant may move them (navigate). Stored per person and team on the server.
 * While a turn runs the person writes on: Enter sends a message into the turn before its next
 * step (a signal), ⌘↩ queues it for after the turn; Stop ends the turn.
 */

interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  cards: { plugin: string; tool: string; data: unknown }[];
  toolCalls: ChatToolCall[];
  changed: boolean;
}

export interface EarlierChat {
  id: string;
  title: string;
  summary: string;
  /** Its summary is still being written. */
  summarising: boolean;
  startedAt: string;
  closedAt: string;
}

/** Written while a turn runs: into the turn before its next step (`signal`), or after it (`queue`). */
export interface PendingMessage {
  id: string;
  text: string;
  way: "signal" | "queue";
}

/** One turn as the developer mode keeps it: every event with its time, for the turns' view. */
export interface DevTurn {
  id: string;
  message: string;
  startedAt: number;
  endedAt: number | null;
  prompt: AssistantPrompt | null;
  events: { at: number; event: string; data: unknown }[];
}

const asMessage = (m: StoredMessage): ChatMessage => ({
  id: m.id,
  role: m.role,
  content: m.content,
  cards: m.cards.map((c, i) => ({ ...c, id: `${m.id}-${i}` })),
  toolCalls: m.toolCalls,
  changed: m.changed,
});

/** Where a file given to the assistant goes: pictures and clips are assets, the rest documents. */
function kindOf(file: File): ProjectFileKind {
  if (file.type.startsWith("image/") && /logo/i.test(file.name)) {
    return "logo";
  }
  return /^(image|video|audio)\//.test(file.type) ? "asset" : "document";
}

let counter = 0;
const localId = (prefix: string) => `${prefix}-${Date.now()}-${++counter}`;

/** What the panel, the sidebar and the avatar show; the chat behind all three. */
export type AssistantView = { kind: "chat" } | { kind: "earlier" } | { kind: "read"; id: string };

export interface AssistantState {
  chat: Chat;
  ready: boolean;
  /** "New chat" is closing the one before. */
  renewing: boolean;
  newChat: () => Promise<void>;
  /** Sends now, or – while a turn runs – into it (`signal`) or after it (`queue`). */
  send: (text: string, files?: File[], way?: PendingMessage["way"]) => Promise<boolean>;
  /** What waits to go into the running turn or after it. */
  pending: PendingMessage[];
  /** Stops the running turn here and sends a waiting message at once. */
  sendNow: (id: string) => void;
  /** Takes a waiting message back, unsent; it is returned to edit. */
  takeBack: (id: string) => PendingMessage | undefined;
  /** Stops the running turn; what waits stays unsent. */
  stop: () => void;
  layout: AssistantLayout;
  setLayout: (layout: AssistantLayout) => void;
  open: boolean;
  setOpen: (open: boolean) => void;
  view: AssistantView;
  setView: (view: AssistantView) => void;
  /** The live chat: it goes on while the person, or the assistant, moves between pages. */
  live: LiveChat;
  /** The developer mode: offered by the runtime, switched on per browser. */
  dev: { offered: boolean; on: boolean; set: (on: boolean) => void; turns: DevTurn[] };
}

const Context = createContext<AssistantState | null>(null);

export function useAssistant(): AssistantState | null {
  return useContext(Context);
}

/** The studio's own addresses and the plugins' pages: what `navigate` may open. */
function useRoutes(): () => string[] {
  const plugins = useStudioPlugins();
  const me = useMe();
  const ref = useRef<string[]>([]);
  ref.current = [
    "/",
    "/new",
    "/edit/:id",
    "/space",
    "/space/:group",
    "/settings",
    ...settingsSections(me.data, plugins).map((s) => `/settings/${s.id}`),
    ...plugins.pages.map((p) => p.path),
  ];
  return useCallback(() => ref.current, []);
}

export function AssistantProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const me = useMe();
  const signedIn = Boolean(me.data);
  const { project } = useCurrentProject();
  const navigate = useNavigate();
  const routes = useRoutes();
  useEffect(() => {
    bindNavigation((to) => navigate(to), routes);
  }, [navigate, routes]);

  const stored = useQuery({
    queryKey: ["assistant-chat"],
    queryFn: () => api.get<{ id: string; messages: StoredMessage[] }>("/api/studio/assistant/chat"),
    enabled: signedIn,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const savedLayout = useQuery({
    queryKey: ["assistant-layout"],
    queryFn: () => api.get<{ layout: AssistantLayout }>("/api/studio/assistant/layout"),
    enabled: signedIn,
    staleTime: Number.POSITIVE_INFINITY,
  });

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [phase, setPhase] = useState<Chat["phase"]>("idle");
  const [error, setError] = useState<string | null>(null);
  const [activity, setActivity] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [renewing, setRenewing] = useState(false);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<AssistantView>({ kind: "chat" });
  const [layout, setLayoutState] = useState<AssistantLayout | null>(null);
  const [pending, setPendingState] = useState<PendingMessage[]>([]);
  const [turns, setTurns] = useState<DevTurn[]>([]);
  const loaded = useRef<string | null>(null);

  const prefs = useDockPrefs();
  const devOffered = Boolean(me.data?.assistantDev);
  const devOn = devOffered && prefs.dev;
  const devRef = useRef(devOn);
  devRef.current = devOn;

  // The stored chat is the truth once, when it arrives; the turns keep the thread from then on.
  useEffect(() => {
    if (stored.data && loaded.current !== stored.data.id) {
      loaded.current = stored.data.id;
      setMessages(stored.data.messages.map(asMessage));
    }
  }, [stored.data]);

  const setLayout = useCallback(
    (next: AssistantLayout) => {
      setLayoutState(next);
      qc.setQueryData(["assistant-layout"], { layout: next });
      void api.put("/api/studio/assistant/layout", { layout: next }).catch(() => null);
    },
    [qc],
  );

  const refreshing = useRef<Promise<void> | null>(null);
  /** The space and the page read their data again; changes that arrive meanwhile wait. */
  const refresh = useCallback(() => {
    refreshing.current ??= (async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["projects"] }),
        project ? qc.invalidateQueries({ queryKey: ["project-files", project.id] }) : null,
        project ? qc.invalidateQueries({ queryKey: ["knowledge", project.id] }) : null,
      ]);
      pageChanged();
      refreshing.current = null;
    })();
    return refreshing.current;
  }, [qc, project]);

  // What waits, readable at once by the turn that ends; the state draws it.
  const waiting = useRef<PendingMessage[]>([]);
  const setPending = useCallback((change: (all: PendingMessage[]) => PendingMessage[]) => {
    waiting.current = change(waiting.current);
    setPendingState(waiting.current);
  }, []);

  const busy = useRef(false);
  /** The running turn: its id on the server once it said it, and how to stop it here. */
  const running = useRef<{ runId: string | null; abort: AbortController; stopped: boolean } | null>(
    null,
  );
  /** Sent with "Send now": the turn it stops starts this one when it has ended. */
  const nextUp = useRef<string | null>(null);
  /** The turn after this one starts here (a turn cannot name itself while it is made). */
  const startNext = useRef<(text: string) => void>(() => undefined);

  /** Hands the signals not yet posted to the running turn; a turn that is over takes none. */
  const posted = useRef(new Set<string>());
  const postSignals = useCallback(() => {
    const runId = running.current?.runId;
    if (!runId) {
      return;
    }
    for (const p of waiting.current) {
      if (p.way !== "signal" || posted.current.has(p.id)) {
        continue;
      }
      posted.current.add(p.id);
      void api
        .post(`/api/studio/assistant/run/${runId}/signal`, { ref: p.id, message: p.text })
        .catch(() => {
          // The turn ended meanwhile: the message goes as the next one.
        });
    }
  }, []);

  /** Uploads files given with a message; the message names them. Null when that failed. */
  const attach = useCallback(
    async (text: string, files: File[]): Promise<string | null> => {
      if (!files.length) {
        return text;
      }
      if (!project || project.readOnly) {
        setError(t("assistant.filesNeedSpace"));
        return null;
      }
      try {
        for (const file of files) {
          await api.upload(`/api/studio/projects/${project.id}/files?kind=${kindOf(file)}`, file);
        }
      } catch (err) {
        setError((err as Error).message);
        await refresh();
        return null;
      }
      await refresh();
      const named = `${t("editor.attached")}: ${files.map((f) => f.name).join(", ")}`;
      return text.trim() ? `${text}\n\n${named}` : named;
    },
    [project, refresh],
  );

  const runTurn = useCallback(
    async (text: string, previews?: Record<string, string>): Promise<void> => {
      busy.current = true;
      setError(null);
      setPhase("thinking");
      setStartedAt(Date.now());
      setHighlight(null);
      setView({ kind: "chat" });
      // The answer's bubble: a message written meanwhile ends it, the answer goes on in a new one.
      let answerId = localId("p");
      const mineId = localId("u");
      setMessages((m) => [
        ...m,
        { id: mineId, role: "user", content: text, previews },
        { id: answerId, role: "assistant", content: "", pending: true },
      ]);
      setActivity(null);
      // The bubble is the one at the event, not at the render: a `signal` right after it moves on.
      const patch = (change: (m: ChatMessage) => ChatMessage) => {
        const id = answerId;
        setMessages((all) => all.map((x) => (x.id === id ? change(x) : x)));
      };
      const turn: DevTurn | null = devRef.current
        ? {
            id: localId("t"),
            message: text,
            startedAt: Date.now(),
            endedAt: null,
            prompt: null,
            events: [],
          }
        : null;
      if (turn) {
        setTurns((all) => [...all, turn]);
      }
      const record = (event: string, data: unknown) => {
        if (turn) {
          turn.events.push({ at: Date.now(), event, data });
          if (event === "prompt") {
            turn.prompt = data as AssistantPrompt;
          }
          setTurns((all) => all.map((x) => (x.id === turn.id ? { ...turn } : x)));
        }
      };
      const abort = new AbortController();
      const run = { runId: null as string | null, abort, stopped: false };
      running.current = run;
      let answered = false;
      try {
        await postStream(
          "/api/studio/assistant/turn",
          {
            message: text,
            projectId: project?.id,
            page: pageSnapshot(),
            tools: browserTools(),
            lang,
            ...(devRef.current ? { debug: true } : {}),
          },
          (event, raw) => {
            const data = JSON.parse(raw);
            record(event, data);
            switch (event as keyof AssistantEvents) {
              case "run_started": {
                const started = data as AssistantEvents["run_started"];
                run.runId = started.runId;
                setMessages((all) =>
                  all.map((x) => (x.id === mineId ? { ...x, id: started.messageId } : x)),
                );
                postSignals();
                break;
              }
              case "text":
                patch((x) => ({
                  ...x,
                  content: x.content + (data as AssistantEvents["text"]).delta,
                }));
                break;
              case "activity":
                setActivity((data as AssistantEvents["activity"]).label);
                break;
              case "tool_call": {
                const call = data as AssistantEvents["tool_call"];
                patch((x) => ({ ...x, toolCalls: [...(x.toolCalls ?? []), call] }));
                void runBrowserTool(call.toolCallName, call.args).then((ran) => {
                  if (ran) {
                    void api
                      .post(`/api/studio/assistant/tool/${call.toolCallId}`, {
                        result: ran.result ?? null,
                      })
                      .catch(() => null);
                  }
                });
                break;
              }
              case "tool_result": {
                const done = data as AssistantEvents["tool_result"];
                patch((x) => ({
                  ...x,
                  toolCalls: x.toolCalls?.map((c) =>
                    c.toolCallId === done.toolCallId ? { ...c, result: done.content } : c,
                  ),
                }));
                break;
              }
              case "card": {
                const card = data as AssistantEvents["card"];
                patch((x) => ({
                  ...x,
                  cards: [
                    ...(x.cards ?? []),
                    { ...card, id: `${x.id}-${x.cards?.length ?? 0}` } as ChatCard,
                  ],
                }));
                break;
              }
              case "changed":
                void refresh();
                break;
              case "step":
                patch((x) => ({
                  ...x,
                  steps: [...(x.steps ?? []), data as AssistantEvents["step"]],
                }));
                break;
              case "signal": {
                // The turn took a message written meanwhile: the answer so far ends there.
                const taken = data as AssistantEvents["signal"];
                const before = answerId;
                answerId = localId("p");
                setPending((all) => all.filter((p) => p.id !== taken.ref));
                setMessages((all) => [
                  ...all.flatMap((x) => {
                    if (x.id !== before) {
                      return [x];
                    }
                    const said = x.content || x.toolCalls?.length || x.cards?.length;
                    return said || x.steps?.length
                      ? [{ ...x, id: taken.answerId ?? x.id, pending: false }]
                      : [];
                  }),
                  { id: taken.messageId, role: "user", content: taken.content, signal: true },
                  { id: answerId, role: "assistant", content: "", pending: true },
                ]);
                break;
              }
              case "done": {
                answered = true;
                const done = data as AssistantEvents["done"];
                patch((x) => ({
                  ...x,
                  id: done.messageId,
                  content: done.reply,
                  changed: done.changed,
                  pending: false,
                }));
                break;
              }
              case "error":
                answered = true;
                setError((data as AssistantEvents["error"]).message);
                break;
            }
          },
          abort.signal,
        );
        if (!answered) {
          setError(t("editor.chatBroken"));
        }
      } catch (err) {
        if (!run.stopped) {
          setError((err as Error).message);
        }
      } finally {
        if (turn) {
          turn.endedAt = Date.now();
          setTurns((all) => all.map((x) => (x.id === turn.id ? { ...turn } : x)));
        }
        running.current = null;
        setActivity(null);
        setStartedAt(null);
        setMessages((m) =>
          m
            .filter(
              (x) =>
                !(
                  x.pending &&
                  !x.content &&
                  !x.cards?.length &&
                  !x.toolCalls?.length &&
                  !x.steps?.length
                ),
            )
            .map((x) => ({ ...x, pending: false })),
        );
        setPhase("idle");
        busy.current = false;
        await refreshing.current;
        void qc.invalidateQueries({ queryKey: ["me"] });
      }
      // What was written meanwhile and not taken is the next turn: the signals, else the first
      // queued message. A stopped turn leaves them waiting – unless one was sent now.
      let next = nextUp.current;
      nextUp.current = null;
      if (!(next || run.stopped)) {
        const signals = waiting.current.filter((p) => p.way === "signal");
        const taken = signals.length
          ? signals
          : waiting.current.filter((p) => p.way === "queue").slice(0, 1);
        if (taken.length) {
          setPending((all) => all.filter((p) => !taken.includes(p)));
          next = taken.map((p) => p.text).join("\n\n");
        }
      }
      if (next) {
        startNext.current(next);
      }
    },
    [project, refresh, qc, postSignals, setPending],
  );
  startNext.current = (text) => void runTurn(text);

  const send = useCallback(
    async (input: string, files: File[] = [], way: PendingMessage["way"] = "signal") => {
      if (!(input.trim() || files.length)) {
        return false;
      }
      setOpen(true);
      if (!busy.current) {
        busy.current = true;
        setPhase("thinking");
        const text = await attach(input, files);
        if (text === null) {
          busy.current = false;
          setPhase("idle");
          return false;
        }
        void runTurn(text, previewsOf(files));
        return true;
      }
      // A turn runs: the message waits for it.
      const text = await attach(input, files);
      if (text === null) {
        return false;
      }
      setPending((all) => [...all, { id: localId("s"), text, way }]);
      postSignals();
      return true;
    },
    [attach, runTurn, postSignals, setPending],
  );

  const stop = useCallback(() => {
    const run = running.current;
    if (run) {
      run.stopped = true;
      run.abort.abort();
    }
  }, []);

  const sendNow = useCallback(
    (id: string) => {
      const item = waiting.current.find((p) => p.id === id);
      if (!item) {
        return;
      }
      setPending((all) => all.filter((p) => p !== item));
      if (running.current) {
        nextUp.current = item.text;
        stop();
      } else if (!busy.current) {
        void runTurn(item.text);
      }
    },
    [runTurn, stop, setPending],
  );

  const takeBack = useCallback(
    (id: string) => {
      const item = waiting.current.find((p) => p.id === id);
      setPending((all) => all.filter((p) => p !== item));
      return item;
    },
    [setPending],
  );

  /** A new chat at once: the window clears, the server closes the old one and sums it up meanwhile. */
  const newChat = useCallback(async () => {
    stop();
    setPending(() => []);
    setMessages([]);
    setTurns([]);
    setError(null);
    setView({ kind: "chat" });
    setRenewing(true);
    try {
      const fresh = await api.post<{ id: string; messages: StoredMessage[] }>(
        "/api/studio/assistant/chat/new",
      );
      loaded.current = fresh.id;
      qc.setQueryData(["assistant-chat"], fresh);
      await qc.invalidateQueries({ queryKey: ["assistant-chats"] });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRenewing(false);
    }
  }, [qc, stop, setPending]);

  const chatSend = useCallback((text: string, files?: File[]) => send(text, files), [send]);
  const chat = useMemo<Chat>(
    () => ({ messages, phase, activity, startedAt, error, send: chatSend }),
    [messages, phase, activity, startedAt, error, chatSend],
  );
  const live = useLiveChat(chat);
  const setDev = useCallback((on: boolean) => setDockPrefs({ dev: on }), []);
  const value = useMemo<AssistantState>(
    () => ({
      chat,
      ready: Boolean(stored.data),
      renewing,
      newChat,
      send,
      pending,
      sendNow,
      takeBack,
      stop,
      layout: layout ?? savedLayout.data?.layout ?? "bottom",
      setLayout,
      open,
      setOpen,
      view,
      setView,
      live,
      dev: { offered: devOffered, on: devOn, set: setDev, turns },
    }),
    [
      chat,
      stored.data,
      renewing,
      newChat,
      send,
      pending,
      sendNow,
      takeBack,
      stop,
      layout,
      savedLayout.data,
      setLayout,
      open,
      view,
      live,
      devOffered,
      devOn,
      setDev,
      turns,
    ],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** The person's closed chats, for "Earlier chats". */
export function useEarlierChats(enabled: boolean) {
  return useQuery({
    queryKey: ["assistant-chats"],
    queryFn: () => api.get<{ chats: EarlierChat[] }>("/api/studio/assistant/chats"),
    enabled,
    // A summary still being written comes a little later.
    refetchInterval: (query) => (query.state.data?.chats.some((c) => c.summarising) ? 2000 : false),
  });
}

/** One earlier chat, to read. */
export function useStoredChat(id: string | null) {
  return useQuery({
    queryKey: ["assistant-chat", id],
    queryFn: async () => {
      const chat = await api.get<EarlierChat & { messages: StoredMessage[] }>(
        `/api/studio/assistant/chats/${id}`,
      );
      return { ...chat, messages: chat.messages.map(asMessage) };
    },
    enabled: Boolean(id),
  });
}
