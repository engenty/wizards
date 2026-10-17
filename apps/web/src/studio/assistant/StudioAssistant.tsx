import type { MarketplaceEntry } from "@engenty-wizards/shared/marketplace";
import {
  Activity,
  ArrowLeft,
  AudioLines,
  ChevronDown,
  GripVertical,
  History,
  Mic,
  MicOff,
  PanelBottom,
  PanelRight,
  Pencil,
  PhoneOff,
  SquarePen,
  Volume2,
  X,
} from "lucide-react";
import {
  type CSSProperties,
  lazy,
  type ReactNode,
  type RefObject,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { Mascot } from "../../brand";
import { lang, t } from "../../lib/i18n";
import { spokenText } from "../../lib/read-aloud";
import { PluginFrame, useStudioPlugins } from "../../plugins/host";
import { Composer, type ComposerHandle, cn, IconButton, LATER_KEYS, Spinner } from "../../ui";
import { useDismiss, useTrail } from "../AppFrame";
import { type ChatCard, type ChatToolCall, Messages, Working } from "../editor/ChatPanel";
import { type AssistantState, useAssistant, useEarlierChats, useStoredChat } from "./chat";
import { CopyThread, StepLines, ToolDetails, TurnsDialog, UsageMeter } from "./dev";
import {
  type DockZone,
  dockWidth,
  hasRight,
  setDockPrefs,
  startDockDrag,
  useDockDrag,
  useDockPrefs,
} from "./dock";
import { canLive } from "./live";
import { type AssistantSuggestion, usePageAssistant } from "./page";
import { openStudioLink, setHighlight, useHighlight } from "./tools";

// The gallery's cards come with the gallery's code, loaded when an answer shows templates.
const MarketplaceCards = lazy(() =>
  import("../Marketplace").then((m) => ({ default: m.MarketplaceCards })),
);

/**
 * Goose, the studio assistant on every page but the editor: docked at the bottom (the default),
 * as a sidebar on a window wide enough, or small at the lower right. At the bottom it moves by its
 * grip – it stays where it is put, snaps to the middle or the right near the bottom, and into the
 * sidebar against the window's right edge; the handle on top sets the thread's height, a click on
 * it folds the chat away. Opened at the bottom, the chat rises above the bar; empty, it greets
 * with the page's words and three suggestions.
 */

/** The content keeps its 760 px beside a 400 px sidebar. */
const SIDEBAR_FROM = 1520;
const PHONE_BELOW = 768;
/** The thread's height, set with the handle on top. */
const THREAD = { min: 120, max: 900 };

function useWindowWidth(): number {
  return useSyncExternalStore(
    (listener) => {
      window.addEventListener("resize", listener);
      return () => window.removeEventListener("resize", listener);
    },
    () => window.innerWidth,
  );
}

/** Where the assistant stands now: the person's choice, as far as the window allows it. */
function useWhere(state: AssistantState) {
  const width = useWindowWidth();
  const page = usePageAssistant();
  const wide = width >= SIDEBAR_FROM;
  const phone = width < PHONE_BELOW;
  let where = state.layout;
  if (where === "sidebar" && (!wide || phone)) {
    where = "bottom";
  }
  // A page of full-height tables keeps the assistant small, at the lower right.
  const compact = where === "bottom" && Boolean(page.compact);
  if (compact) {
    where = "avatar";
  }
  return { where, wide: wide && !phone, phone, compact };
}

// --- what the thread shows -------------------------------------------------------------------

const QUIET = new Set(["scroll_to"]);

function callLabel(call: ChatToolCall): string | null {
  const args = (call.args ?? {}) as Record<string, unknown>;
  let result: Record<string, unknown> = {};
  try {
    result = call.result ? JSON.parse(call.result) : {};
  } catch {
    // a result cut short says nothing more
  }
  // A ref of look_at_page ("e19") says nothing to the person.
  const target = /^e\d+$/.test(String(args.target ?? "")) ? "" : String(args.target ?? "");
  const what = String(result.shown || result.filled || result.area || target);
  switch (call.toolCallName) {
    case "navigate":
      return t("assistant.tool.navigate", { where: String(args.to ?? "") });
    case "highlight":
      return t("assistant.tool.highlight", { what });
    case "look_at_page":
      return t("assistant.tool.look");
    case "read_section":
      return t("assistant.tool.read", { what });
    case "fill_field":
      return t("assistant.tool.fill", { what });
    case "docs_search":
    case "docs_read":
    case "authoring_guide":
      return t("assistant.tool.docs");
    case "gallery_search":
    case "gallery_detail":
    case "show_templates":
      return t("assistant.tool.gallery");
    case "plans":
    case "account":
    case "usage":
      return t("assistant.tool.account");
    case "chats_search":
    case "chat_read":
      return t("assistant.tool.chats");
    case "wizards":
    case "runs":
      return t("assistant.tool.space");
    case "models":
      return t("assistant.tool.models");
    default:
      return null;
  }
}

function Calls({ calls }: { calls?: ChatToolCall[] }) {
  const labels = [
    ...new Set(
      (calls ?? [])
        .filter((c) => !QUIET.has(c.toolCallName))
        .map(callLabel)
        .filter((l): l is string => Boolean(l)),
    ),
  ];
  if (!labels.length) {
    return null;
  }
  return (
    <div className="mb-1.5 flex flex-wrap gap-1.5">
      {labels.map((label) => (
        <span
          key={label}
          className="inline-flex max-w-full items-center rounded-full bg-paper-2 px-2.5 py-0.5 text-[0.75rem] text-ink-3"
        >
          <span className="truncate">{label}</span>
        </span>
      ))}
    </div>
  );
}

/** A card under an answer: the studio's own templates, or a plugin's for what its tool returned. */
function AnswerCard({ card, send }: { card: ChatCard; send: (message: string) => void }) {
  if (!card.plugin && card.tool === "templates") {
    const { entries } = card.data as { entries: MarketplaceEntry[] };
    return (
      <Suspense fallback={<Spinner className="m-2 size-4" />}>
        <MarketplaceCards entries={entries} />
      </Suspense>
    );
  }
  return <PluginCard card={card} send={send} />;
}

/** A plugin's card for what its tool returned, drawn by the plugin's studio half. */
function PluginCard({ card, send }: { card: ChatCard; send: (message: string) => void }) {
  const plugins = useStudioPlugins();
  const found = plugins.cards.find((c) => c.plugin === card.plugin && c.tool === card.tool);
  if (!found) {
    return null;
  }
  return (
    <PluginFrame of={found}>
      <found.component data={card.data} send={send} />
    </PluginFrame>
  );
}

function defaultSuggestions(): AssistantSuggestion[] {
  return [
    { label: t("assistant.suggest.what") },
    { label: t("assistant.suggest.models") },
    { label: t("assistant.suggest.credits") },
  ];
}

function Hello({
  state,
  composer,
}: {
  state: AssistantState;
  composer: RefObject<ComposerHandle | null>;
}) {
  const page = usePageAssistant();
  const suggestions = (page.suggestions?.length ? page.suggestions : defaultSuggestions()).slice(
    0,
    3,
  );
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-3">
        <div className="shrink-0">
          <Mascot kind="round" size={44} goggles interactive={false} />
        </div>
        <div className="min-w-0 pt-0.5">
          <h2 className="font-display font-semibold text-[1.0625rem] leading-tight tracking-tight">
            {page.title ?? t("assistant.helloTitle")}
          </h2>
          <p className="mt-1 text-[0.875rem] text-ink-2 leading-relaxed">
            {page.hello ?? t("assistant.hello")}
          </p>
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        {suggestions.map((s) => (
          <button
            key={s.label}
            type="button"
            disabled={state.chat.phase !== "idle"}
            onClick={() => {
              const message = s.message ?? s.label;
              if (s.fill) {
                composer.current?.fill(message);
              } else {
                void state.chat.send(message);
              }
            }}
            className="flex items-center gap-2 rounded-xl bg-paper-2 px-3.5 py-2.5 text-left text-[0.875rem] text-ink-2 transition hover:bg-paper-3 hover:text-ink disabled:opacity-60"
          >
            <span className="min-w-0 flex-1">{s.label}</span>
            {s.fill ? <SquarePen className="size-3.5 shrink-0 text-ink-4" /> : null}
          </button>
        ))}
      </div>
    </div>
  );
}

function Earlier({ state }: { state: AssistantState }) {
  const chats = useEarlierChats(true);
  if (chats.isLoading) {
    return <Spinner className="m-4 size-4" />;
  }
  const list = chats.data?.chats ?? [];
  if (!list.length) {
    return <p className="text-[0.875rem] text-ink-3">{t("assistant.noEarlier")}</p>;
  }
  return (
    <ul className="flex flex-col gap-1">
      {list.map((c) => (
        <li key={c.id}>
          <button
            type="button"
            onClick={() => state.setView({ kind: "read", id: c.id })}
            className="flex w-full flex-col gap-0.5 rounded-lg px-3 py-2.5 text-left transition hover:bg-accent"
          >
            <span className="flex items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate font-medium text-[0.875rem]">
                {c.title || t("assistant.untitled")}
              </span>
              <span className="shrink-0 text-[0.75rem] text-ink-4 tabular-nums">
                {new Date(c.closedAt).toLocaleDateString(lang)}
              </span>
            </span>
            <span className="line-clamp-1 text-[0.8125rem] text-ink-3">
              {c.summarising ? t("assistant.summarising") : c.summary.split("\n")[0]}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function ReadChat({ id }: { id: string }) {
  const chat = useStoredChat(id);
  if (!chat.data) {
    return <Spinner className="m-4 size-4" />;
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl bg-paper-2 px-4 py-3 text-[0.8125rem] text-ink-2 leading-relaxed">
        <div className="font-medium text-ink">{chat.data.title || t("assistant.untitled")}</div>
        <p className="mt-1 whitespace-pre-line">{chat.data.summary}</p>
      </div>
      <Messages
        chat={{
          messages: chat.data.messages,
          phase: "idle",
          activity: null,
          startedAt: null,
          error: null,
          send: async () => false,
        }}
        avatar="round"
        changedLabel={t("project.assistantChanged")}
        // Its cards show again with what their tools returned; nothing is sent from here.
        card={(card) => <AnswerCard card={card} send={() => undefined} />}
        calls={(m) => <Calls calls={m.toolCalls} />}
      />
    </div>
  );
}

function Thread({
  state,
  composer,
}: {
  state: AssistantState;
  composer: RefObject<ComposerHandle | null>;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const { chat, view } = state;
  // A studio page an answer links to opens in the app, the chat beside it; others in a new tab.
  useEffect(() => {
    const el = scroller.current;
    const onClick = (e: MouseEvent) => {
      const href = (e.target as HTMLElement).closest("a")?.getAttribute("href");
      if (!href || e.metaKey || e.ctrlKey || e.shiftKey) {
        return;
      }
      if (openStudioLink(href)) {
        e.preventDefault();
      } else if (/^https?:\/\//.test(href)) {
        // The guides and other sites open beside the studio, not in its place.
        e.preventDefault();
        window.open(href, "_blank", "noopener,noreferrer");
      }
    };
    el?.addEventListener("click", onClick);
    return () => el?.removeEventListener("click", onClick);
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on new content
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [chat.messages, chat.phase, view]);
  return (
    <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">
      {view.kind === "earlier" ? (
        <Earlier state={state} />
      ) : view.kind === "read" ? (
        <ReadChat id={view.id} />
      ) : chat.messages.length ? (
        <Messages
          chat={chat}
          avatar="round"
          changedLabel={t("project.assistantChanged")}
          card={(card) => <AnswerCard card={card} send={(message) => void chat.send(message)} />}
          calls={(m) =>
            state.dev.on ? <ToolDetails calls={m.toolCalls} /> : <Calls calls={m.toolCalls} />
          }
          foot={(m) => (state.dev.on ? <StepLines steps={m.steps} /> : null)}
        />
      ) : (
        <Hello state={state} composer={composer} />
      )}
      {chat.error && view.kind === "chat" ? (
        <div className="mt-4 rounded-lg bg-rose-tint px-3 py-2 text-[0.8125rem] text-rose">
          {chat.error}
        </div>
      ) : null}
    </div>
  );
}

// --- the header ----------------------------------------------------------------------------

function ChatMenu({ state }: { state: AssistantState }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));
  const item =
    "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[0.875rem] text-ink-2 hover:bg-accent hover:text-ink disabled:opacity-50";
  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("assistant.menu")}
        onClick={() => setOpen((o) => !o)}
        className="-ml-1 flex items-center gap-1 rounded-lg px-1.5 py-0.5 font-display font-semibold text-[0.9375rem] transition hover:bg-accent"
      >
        {t("assistant.name")}
        <ChevronDown className="size-3.5 text-ink-4" />
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute top-8 left-0 z-50 w-56 animate-rise rounded-xl bg-card p-1.5 shadow-overlay ring-1 ring-border-soft"
        >
          <button
            type="button"
            role="menuitem"
            className={item}
            disabled={state.renewing}
            onClick={() => {
              setOpen(false);
              void state.newChat();
            }}
          >
            <SquarePen className="size-4" /> {t("assistant.newChat")}
          </button>
          <button
            type="button"
            role="menuitem"
            className={item}
            onClick={() => {
              setOpen(false);
              state.setView({ kind: "earlier" });
            }}
          >
            <History className="size-4" /> {t("assistant.earlier")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** The developer mode's switch beside the name, where the runtime offers it. */
function DevSwitch({ state }: { state: AssistantState }) {
  const on = state.dev.on;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={t("assistant.dev")}
      title={on ? t("assistant.devOn") : t("assistant.devOff")}
      onClick={() => state.dev.set(!on)}
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-full font-mono font-semibold text-[0.625rem] uppercase tracking-wide transition",
        on
          ? "bg-ember pr-0.5 pl-2 text-white"
          : "flex-row-reverse bg-paper-3 pr-2 pl-0.5 text-ink-3",
      )}
    >
      dev
      <span className="size-4 rounded-full bg-white shadow-sm" />
    </button>
  );
}

function Header({
  state,
  where,
  wide,
  phone,
  compact,
  grip,
}: {
  state: AssistantState;
  where: "bottom" | "sidebar" | "avatar";
  wide: boolean;
  phone: boolean;
  /** The page keeps it small: no docking at the bottom here. */
  compact?: boolean;
  /** What moves the chat, before the name. */
  grip?: ReactNode;
}) {
  const live = state.live;
  const [turnsOpen, setTurnsOpen] = useState(false);
  const sees = useTrail()
    .map((c) => c.label)
    .join(" · ");
  const dev = state.dev.on && state.view.kind === "chat";
  // The sidebar is 400 px: the meter shows its ring, Copy stays in the turns.
  const narrow = where === "sidebar";
  const messages = state.chat.messages;
  return (
    <div
      className={cn(
        "flex items-center border-border-soft border-b py-2",
        narrow ? "gap-1 px-3" : "gap-1.5 px-3 sm:px-4",
      )}
    >
      {grip}
      {state.view.kind !== "chat" ? (
        <IconButton
          label={t("assistant.back")}
          onClick={() => state.setView({ kind: state.view.kind === "read" ? "earlier" : "chat" })}
          className="size-8"
        >
          <ArrowLeft className="size-4" />
        </IconButton>
      ) : where !== "sidebar" ? null : (
        <Mascot kind="round" size={26} goggles interactive={false} />
      )}
      {/* Never narrower than the name and the developer switch. */}
      <div className="ml-0.5 min-w-[8.5rem] flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          {state.view.kind === "chat" ? (
            <ChatMenu state={state} />
          ) : (
            <span className="font-display font-semibold text-[0.9375rem]">
              {t("assistant.earlier")}
            </span>
          )}
          {state.dev.offered && state.view.kind === "chat" ? <DevSwitch state={state} /> : null}
        </div>
        {live.state !== "off" ? (
          <div className="flex items-center gap-1.5 text-[0.75rem] text-ember-strong">
            <span className="size-1.5 animate-pulse-dot rounded-full bg-ember" />
            {t("assistant.live")} · <Clock since={live.since} />
          </div>
        ) : sees ? (
          <div className="truncate text-[0.75rem] text-ink-4">
            {t("assistant.sees", { page: sees })}
          </div>
        ) : null}
      </div>
      {dev ? <UsageMeter messages={messages} narrow={narrow} /> : null}
      {dev ? (
        <>
          {/* On a phone the head keeps its room for the name; the turns are a desktop's look. */}
          <IconButton
            label={t("assistant.inspect")}
            onClick={() => setTurnsOpen(true)}
            className="size-8 max-sm:hidden"
          >
            <Activity className="size-4" />
          </IconButton>
          {messages.length && !narrow ? (
            <span className="max-sm:hidden">
              <CopyThread messages={messages} turns={state.dev.turns} />
            </span>
          ) : null}
          <TurnsDialog
            open={turnsOpen}
            onClose={() => setTurnsOpen(false)}
            turns={state.dev.turns}
            messages={messages}
          />
        </>
      ) : null}
      {state.view.kind === "chat" && messages.length ? (
        <IconButton
          label={t("assistant.newChat")}
          disabled={state.renewing}
          onClick={() => void state.newChat()}
          className="size-8"
        >
          <SquarePen className="size-4" />
        </IconButton>
      ) : null}
      {where !== "sidebar" && wide ? (
        <IconButton
          label={t("assistant.layoutSidebar")}
          onClick={() => state.setLayout("sidebar")}
          className="size-8"
        >
          <PanelRight className="size-4" />
        </IconButton>
      ) : null}
      {where === "sidebar" || (where === "avatar" && !phone && !compact) ? (
        <IconButton
          label={t("assistant.layoutBottom")}
          onClick={() => {
            state.setLayout("bottom");
            state.setOpen(true);
          }}
          className="size-8"
        >
          <PanelBottom className="size-4" />
        </IconButton>
      ) : null}
      {/* Closed, Goose is the small engenty at the lower right; opened again, the chat stands where it was. */}
      <IconButton
        label={t("assistant.close")}
        onClick={() => {
          if (where !== "avatar") {
            state.setLayout("avatar");
          }
          state.setOpen(false);
        }}
        className="size-8"
      >
        <X className="size-4" />
      </IconButton>
    </div>
  );
}

function Clock({ since }: { since: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = since ? Math.max(0, Math.floor((now - since) / 1000)) : 0;
  return (
    <span className="tabular-nums">
      {String(Math.floor(seconds / 60)).padStart(2, "0")}:{String(seconds % 60).padStart(2, "0")}
    </span>
  );
}

// --- the composer or the call --------------------------------------------------------------

function CallStrip({ state }: { state: AssistantState }) {
  const live = state.live;
  const label =
    live.state === "thinking"
      ? t("assistant.liveThinking")
      : live.state === "speaking"
        ? t("assistant.liveSpeaking")
        : live.muted
          ? t("assistant.liveMuted")
          : t("assistant.liveListening");
  return (
    <div className="flex items-center gap-2 rounded-full bg-card p-1 pl-4 shadow-overlay ring-1 ring-ember-veil">
      <span className="size-2 shrink-0 animate-pulse-dot rounded-full bg-ember" />
      <span aria-hidden className="flex h-5 shrink-0 items-center gap-0.5">
        {[0.5, 0.8, 1, 0.75, 0.45].map((f, i) => (
          <span
            key={i}
            className="w-1 rounded-full bg-ember transition-[height] duration-100"
            style={{ height: `${Math.max(3, Math.round(live.level * f * 20))}px` }}
          />
        ))}
      </span>
      <span className="min-w-0 flex-1 truncate text-[0.8125rem] text-ink-2">
        {live.heard ? (
          <span className="text-ink">{live.heard}</span>
        ) : live.state === "thinking" ? (
          <Working chat={state.chat} className="text-ink-3" />
        ) : (
          <>
            {label} · <Clock since={live.since} />
          </>
        )}
      </span>
      {live.voice && live.voice.way !== "none" ? (
        <IconButton
          label={t("assistant.naturalVoice")}
          aria-pressed={live.voice.natural}
          onClick={() => live.setNatural(!live.voice?.natural)}
          className={cn(live.voice.natural && "bg-ember-tint text-ember-strong")}
        >
          <Volume2 className="size-4" />
        </IconButton>
      ) : null}
      <IconButton
        label={live.muted ? t("assistant.unmute") : t("assistant.mute")}
        aria-pressed={live.muted}
        onClick={live.toggleMute}
      >
        {live.muted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
      </IconButton>
      <button
        type="button"
        onClick={live.end}
        className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-rose px-3.5 font-medium text-[0.8125rem] text-white coarse:h-11"
      >
        <PhoneOff className="size-4" /> {t("assistant.end")}
      </button>
    </div>
  );
}

/** What the person wrote while Goose works: into its next step, or after the answer. */
function Pending({
  state,
  composer,
}: {
  state: AssistantState;
  composer: RefObject<ComposerHandle | null>;
}) {
  if (!state.pending.length) {
    return null;
  }
  return (
    <ul aria-label={t("assistant.pending")} className="mb-2 flex flex-col gap-1">
      {state.pending.map((p) => (
        <li
          key={p.id}
          className="flex items-center gap-2 rounded-xl bg-card py-1 pr-1 pl-3 text-[0.8125rem] shadow-soft ring-1 ring-border"
        >
          <span
            title={
              p.way === "queue" ? t("assistant.pendingQueueHint") : t("assistant.pendingSignalHint")
            }
            className={cn(
              "shrink-0 rounded-full px-2 py-0.5 text-[0.6875rem]",
              p.way === "queue" ? "bg-paper-2 text-ink-3" : "bg-ember-tint text-ember-strong",
            )}
          >
            {p.way === "queue" ? t("assistant.pendingQueue") : t("assistant.pendingSignal")}
          </span>
          <span className="min-w-0 flex-1 truncate">{p.text}</span>
          <button
            type="button"
            title={t("assistant.sendNowHint")}
            onClick={() => state.sendNow(p.id)}
            className="shrink-0 rounded-full px-2 py-1 font-medium text-[0.75rem] text-ember-strong transition hover:bg-ember-tint"
          >
            {t("assistant.sendNow")}
          </button>
          <IconButton
            label={t("assistant.edit")}
            onClick={() => {
              const item = state.takeBack(p.id);
              if (item) {
                composer.current?.fill(item.text);
              }
            }}
            className="size-7"
          >
            <Pencil className="size-3.5" />
          </IconButton>
          <IconButton
            label={t("assistant.remove")}
            onClick={() => state.takeBack(p.id)}
            className="size-7"
          >
            <X className="size-3.5" />
          </IconButton>
        </li>
      ))}
    </ul>
  );
}

function Bottom({
  state,
  composer,
  floating,
  bare,
}: {
  state: AssistantState;
  composer: RefObject<ComposerHandle | null>;
  floating?: boolean;
  /** In the dock's one card: the composer draws no card of its own. */
  bare?: boolean;
}) {
  const page = usePageAssistant();
  const live = state.live;
  if (state.view.kind === "earlier") {
    return null;
  }
  if (state.view.kind === "read") {
    return (
      <p className="m-3 rounded-xl bg-paper-2 px-4 py-3 text-[0.8125rem] text-ink-2 leading-relaxed">
        {t("assistant.readOnly")}
      </p>
    );
  }
  const busy = state.chat.phase !== "idle";
  return (
    <div className={floating ? undefined : "p-3"}>
      {live.state !== "off" ? (
        <CallStrip state={state} />
      ) : (
        <>
          <Pending state={state} composer={composer} />
          <Composer
            ref={composer}
            floating={floating}
            bare={bare}
            placeholder={
              busy
                ? t("assistant.busyComposer", { keys: LATER_KEYS })
                : (page.placeholder ?? t("assistant.composer"))
            }
            busy={busy}
            onStop={state.stop}
            onSend={(text, files, later) => state.send(text, files, later ? "queue" : "signal")}
            onTalk={
              canLive
                ? () => {
                    state.setOpen(true);
                    void live.start();
                  }
                : undefined
            }
          />
        </>
      )}
      {live.error ? (
        <p className="mt-2 px-3 text-[0.75rem] text-rose">
          {live.error === "denied" ? t("editor.micDenied") : live.error}
        </p>
      ) : null}
    </div>
  );
}

/** Files dropped anywhere on the assistant go with the next message. */
function DropZone({
  composer,
  children,
  className,
  style,
}: {
  composer: RefObject<ComposerHandle | null>;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      data-assistant-ui
      className={className}
      style={style}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
        }
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) {
          return;
        }
        e.preventDefault();
        composer.current?.add(Array.from(e.dataTransfer.files));
        composer.current?.focus();
      }}
    >
      {children}
    </div>
  );
}

// --- moving it -----------------------------------------------------------------------------

/**
 * The page column's size, followed as it changes. The column is the parent's: its ref is set
 * after this component's first layout effect, so a missing node is looked for again a frame later.
 */
function useSize(el: RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    let observer: ResizeObserver | null = null;
    let frame = 0;
    const follow = () => {
      const node = el.current;
      if (!node) {
        frame = requestAnimationFrame(follow);
        return;
      }
      const measure = () => setSize({ width: node.clientWidth, height: node.clientHeight });
      measure();
      observer = new ResizeObserver(measure);
      observer.observe(node);
    };
    follow();
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [el]);
  return size;
}

/** The chat at the bottom, or the sidebar, put where a drag ended. */
function dropped(state: AssistantState) {
  return (zone: DockZone | "free", free?: { left: number; bottom: number }) => {
    if (zone === "sidebar") {
      state.setLayout("sidebar");
      return;
    }
    // Made small, it stays small: the place is where it opens next time.
    setDockPrefs(zone === "free" ? { place: "free", free } : { place: zone });
  };
}

/** What moves the chat: dragged, or with the arrow keys (left: the middle, right: the right, then the sidebar). */
function Grip({
  state,
  column,
  frame,
  wide,
  from,
}: {
  state: AssistantState;
  column: RefObject<HTMLElement | null>;
  frame: () => HTMLElement | null;
  wide: boolean;
  from: "bottom" | "sidebar";
}) {
  const prefs = useDockPrefs();
  const drop = dropped(state);
  return (
    <button
      type="button"
      title={t("assistant.move")}
      aria-label={t("assistant.move")}
      onPointerDown={(e) =>
        startDockDrag(e, {
          column: () => column.current,
          frame,
          sidebar: wide,
          onLeave:
            from === "sidebar"
              ? () => {
                  state.setLayout("bottom");
                  state.setOpen(true);
                }
              : undefined,
          onDrop: drop,
        })
      }
      onKeyDown={(e) => {
        let next: DockZone | null = null;
        if (from === "sidebar") {
          next = e.key === "ArrowLeft" || e.key === "ArrowDown" ? "right" : null;
        } else if (e.key === "ArrowLeft") {
          next = "center";
        } else if (e.key === "ArrowRight") {
          const room = hasRight(column.current?.clientWidth ?? 0);
          next = room && prefs.place !== "right" ? "right" : wide ? "sidebar" : null;
        }
        if (next) {
          e.preventDefault();
          drop(next);
        }
      }}
      className="-ml-1.5 inline-flex h-8 w-5 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-ink-4 transition hover:bg-accent hover:text-ink active:cursor-grabbing"
    >
      <GripVertical className="size-4" />
    </button>
  );
}

/** Where a drag would snap: a dashed outline in the page column. */
function DropOutline() {
  const drag = useDockDrag();
  if (!drag?.spot) {
    return null;
  }
  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute rounded-2xl border-2 border-dashed transition-all duration-200",
        drag.zone ? "border-ember bg-ember-veil opacity-100" : "border-ink-4 opacity-0",
      )}
      style={drag.spot}
    />
  );
}

/**
 * Places the chat at the bottom: in the middle, at the right, where it was put, or – while it is
 * dragged – under the pointer. Only this re-renders while it moves, not the thread inside.
 */
function DockFrame({
  place,
  free,
  width,
  column,
  frame,
  children,
}: {
  place: "center" | "right" | "free";
  free: { left: number; bottom: number } | null;
  width: number;
  column: { width: number; height: number };
  frame: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}) {
  const drag = useDockDrag();
  let style: CSSProperties;
  if (drag) {
    style = { left: drag.left, top: drag.top, width };
  } else if (place === "free" && free) {
    style = {
      left: Math.min(Math.max(free.left, 8), Math.max(8, column.width - width - 8)),
      bottom: Math.min(Math.max(free.bottom, 8), Math.max(8, column.height - 200)),
      width,
    };
  } else {
    style = {
      left: place === "right" ? column.width - width - 12 : (column.width - width) / 2,
      bottom: 0,
      width,
    };
  }
  return (
    <div
      ref={frame}
      className={cn(
        "pointer-events-none absolute flex flex-col",
        drag ? "opacity-90" : "transition-[left,bottom] duration-300 ease-out",
      )}
      style={style}
    >
      {children}
    </div>
  );
}

/**
 * The handle on top of the chat at the bottom: dragged, it sets the thread's height; clicked, it
 * folds the chat away. Arrow keys change the height, Enter folds.
 */
function Flap({
  thread,
  max,
  folded,
  onFold,
  onOpen,
}: {
  thread: RefObject<HTMLDivElement | null>;
  max: number;
  /** The chat is folded: a click opens it, and pulling up opens it as high as it was pulled. */
  folded: boolean;
  onFold: () => void;
  onOpen: () => void;
}) {
  const prefs = useDockPrefs();
  const start = useRef<{ y: number; height: number; moved: boolean } | null>(null);
  const clamp = (h: number) => Math.round(Math.min(Math.max(h, THREAD.min), max));
  const height = prefs.height ?? thread.current?.offsetHeight ?? THREAD.min;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a window splitter that moves is a focusable separator (WAI-ARIA)
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="horizontal"
      aria-valuenow={height}
      aria-valuemin={THREAD.min}
      aria-valuemax={max}
      aria-label={folded ? t("assistant.open") : t("assistant.flap")}
      title={folded ? t("assistant.open") : t("assistant.flap")}
      onPointerDown={(e) => {
        if (e.button !== 0) {
          return;
        }
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { y: e.clientY, height: thread.current?.offsetHeight ?? 0, moved: false };
      }}
      onPointerMove={(e) => {
        const from = start.current;
        if (!from || (!from.moved && Math.abs(e.clientY - from.y) < 4)) {
          return;
        }
        if (folded && e.clientY > from.y) {
          return;
        }
        if (folded && !from.moved) {
          onOpen();
        }
        from.moved = true;
        setDockPrefs({ height: clamp(from.height + (from.y - e.clientY)) });
      }}
      onPointerUp={() => {
        const click = start.current && !start.current.moved;
        start.current = null;
        if (click) {
          (folded ? onOpen : onFold)();
        }
      }}
      onPointerCancel={() => {
        start.current = null;
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          if (folded) {
            if (e.key === "ArrowUp") {
              onOpen();
            }
            return;
          }
          setDockPrefs({ height: clamp(height + (e.key === "ArrowUp" ? 32 : -32)) });
        } else if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          (folded ? onOpen : onFold)();
        }
      }}
      className="group flex h-3.5 shrink-0 cursor-row-resize touch-none items-center justify-center outline-none"
    >
      <span className="h-1 w-10 rounded-full bg-ink-4/40 transition group-hover:bg-ink-4 group-focus-visible:bg-ember" />
    </div>
  );
}

// --- the three places ----------------------------------------------------------------------

/**
 * At the bottom of the page and small at its lower right: drawn over the page's column. The
 * height of what stays at rest is written to `--assistant-dock` on the column, so the page's
 * last section stays clear of it – not while the chat stands where it was put.
 */
export function AssistantDock({ column }: { column: RefObject<HTMLDivElement | null> }) {
  const state = useAssistant();
  // Above the highlight's dimming: the conversation stays readable beside what it points at.
  const lifted = Boolean(useHighlight());
  const composer = useRef<ComposerHandle>(null);
  const rest = useRef<HTMLDivElement>(null);
  /** The room kept below the docked card (the phone's home bar). */
  const pad = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const thread = useRef<HTMLDivElement>(null);
  const where = useWhereOrNull(state);
  const prefs = useDockPrefs();
  const size = useSize(column);
  const visible = state && where && where.where !== "sidebar";
  const width = dockWidth(size.width);
  // On a phone, and where the column has no room for it, the chat stands in the middle.
  const place =
    where?.phone ||
    (prefs.place === "right" && !hasRight(size.width)) ||
    (prefs.place === "free" && !prefs.free)
      ? "center"
      : prefs.place;
  const docked = place !== "free";
  // Made small, the chat folds into the engenty at the lower right; opened, it is the same chat
  // as at the bottom, where it last stood – over the page, which keeps room for the engenty only.
  const small = where?.where === "avatar";
  const open = Boolean(state?.open);
  const [focused, setFocused] = useState(false);
  const active =
    focused || open || state?.chat.phase !== "idle" || (state?.live.state ?? "off") !== "off";
  const reserve = small ? !open : docked;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `rest` is the engenty or the bar, by `small` and `open`
  useLayoutEffect(() => {
    const el = rest.current;
    const host = column.current;
    if (!(el && host && visible && reserve)) {
      host?.style.setProperty("--assistant-dock", "0px");
      return;
    }
    const observer = new ResizeObserver(() => {
      const below = pad.current?.offsetHeight ?? 0;
      host.style.setProperty("--assistant-dock", `${Math.ceil(el.offsetHeight + below) + 8}px`);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      host.style.setProperty("--assistant-dock", "0px");
    };
  }, [column, visible, reserve, small, open]);
  // Escape folds the opened chat away.
  useEffect(() => {
    if (!state?.open) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector("[role=dialog], dialog[open]")) {
        state.setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [state]);
  if (!(state && where && visible)) {
    return null;
  }
  if (small && !open) {
    return (
      <DropZone
        composer={composer}
        className={cn("pointer-events-none absolute inset-0", lifted ? "z-[61]" : "z-30")}
      >
        {
          <div
            ref={rest}
            className="pointer-events-auto absolute right-3 bottom-3 sm:right-4 sm:bottom-4"
          >
            <div className="flex items-center gap-1 rounded-full bg-card p-1 pr-1.5 shadow-overlay ring-1 ring-border">
              <button
                type="button"
                onClick={() => state.setOpen(true)}
                className="flex items-center gap-2 rounded-full py-0.5 pr-2 pl-0.5 text-[0.875rem] text-ink-2 transition hover:text-ink"
              >
                <span className="relative">
                  <Mascot kind="round" size={36} goggles interactive={false} />
                  {state.chat.phase !== "idle" || state.live.state !== "off" ? (
                    <span className="absolute top-0 right-0 size-2.5 animate-pulse-dot rounded-full bg-ember ring-2 ring-card" />
                  ) : null}
                </span>
                <span className="max-sm:hidden">{t("assistant.ask")}</span>
              </button>
              {canLive ? (
                <IconButton
                  label={t("assistant.talk")}
                  onClick={() => {
                    state.setOpen(true);
                    void state.live.start();
                  }}
                  className="size-8 bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground"
                >
                  <AudioLines className="size-4" />
                </IconButton>
              ) : null}
            </div>
          </div>
        }
      </DropZone>
    );
  }
  // Goose perches while the chat is in use (focused, open, working or live): on top of whatever
  // stands highest – the open chat, the last turn, or the bar. It is the handle that moves the chat, too.
  const perch = (
    <button
      type="button"
      aria-label={t("assistant.open")}
      title={`${t("assistant.open")} · ${t("assistant.move")}`}
      tabIndex={-1}
      onPointerDown={(e) =>
        startDockDrag(e, {
          column: () => column.current,
          frame: () => frame.current,
          sidebar: where.wide,
          onClick: () => state.setOpen(true),
          onDrop: dropped(state),
        })
      }
      onClick={(e) => {
        if (e.detail === 0) {
          state.setOpen(true);
        }
      }}
      className={cn(
        "pointer-events-auto absolute bottom-full left-6 -mb-3 origin-bottom cursor-grab touch-none transition duration-300 ease-out active:cursor-grabbing max-sm:hidden",
        active
          ? "translate-y-0 scale-100 opacity-100"
          : "pointer-events-none translate-y-3 scale-75 opacity-0",
      )}
    >
      <Mascot kind="round" size={44} goggles interactive={active} />
    </button>
  );
  // The thread is as high as the handle set it, within what the column leaves.
  const maxThread = Math.max(THREAD.min, Math.min(THREAD.max, size.height - 220));
  const threadHeight = prefs.height === null ? null : Math.min(prefs.height, maxThread);
  const grip = where.phone ? undefined : (
    <Grip
      state={state}
      column={column}
      frame={() => frame.current}
      wide={where.wide}
      from="bottom"
    />
  );
  return (
    <DropZone
      composer={composer}
      className={cn("pointer-events-none absolute inset-0", lifted ? "z-[61]" : "z-30")}
    >
      {docked && !small ? (
        <div
          aria-hidden
          className="absolute inset-x-0 bottom-0 h-24 bg-linear-to-t from-paper/85 via-paper/55 to-paper/0 backdrop-blur-xl [mask-image:linear-gradient(to_top,black_45%,transparent)]"
        />
      ) : null}
      <DropOutline />
      <DockFrame place={place} free={prefs.free} width={width} column={size} frame={frame}>
        {perch}
        {/* One card: the open chat or the last turn on top, the bar below, melted together. */}
        <div className="pointer-events-auto flex min-h-0 flex-col overflow-hidden rounded-[1.375rem] bg-card shadow-overlay ring-1 ring-border focus-within:ring-focus">
          {/* The handle stays, open or folded: it sets the height, folds, and opens again. */}
          <Flap
            thread={thread}
            max={maxThread}
            folded={!open}
            onFold={() => state.setOpen(false)}
            onOpen={() => state.setOpen(true)}
          />
          {open ? (
            <div className="relative flex min-h-0 flex-col">
              <div
                className="flex min-h-0 animate-rise flex-col border-border-soft border-b"
                style={{ maxHeight: maxThread + 60 }}
              >
                <Header
                  state={state}
                  where={small ? "avatar" : "bottom"}
                  wide={where.wide}
                  phone={where.phone}
                  compact={where.compact}
                  grip={grip}
                />
                <div
                  ref={thread}
                  className="flex min-h-0 flex-col"
                  style={
                    threadHeight === null ? { maxHeight: maxThread } : { height: threadHeight }
                  }
                >
                  <Thread state={state} composer={composer} />
                </div>
              </div>
            </div>
          ) : state.chat.messages.length || state.chat.error ? (
            <LastTurn state={state} />
          ) : null}
          <div
            ref={rest}
            onFocusCapture={() => setFocused(true)}
            onBlurCapture={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                setFocused(false);
              }
            }}
            className="relative w-full"
          >
            <Bottom state={state} composer={composer} floating bare />
          </div>
        </div>
        {docked ? (
          <div ref={pad} className="h-[max(0.75rem,env(safe-area-inset-bottom))] shrink-0" />
        ) : null}
      </DockFrame>
    </DropZone>
  );
}

/** Folded, one line about the last turn stands on top of the bar, in its card; it opens the chat. */
function LastTurn({ state }: { state: AssistantState }) {
  const last = state.chat.messages.at(-1);
  return (
    <button
      type="button"
      onClick={() => state.setOpen(true)}
      className="flex w-full items-center gap-2 border-border-soft border-b px-4 py-3.5 text-left text-[0.8125rem] text-ink-3 transition hover:text-ink"
    >
      {last?.pending ? (
        <Working chat={state.chat} className="flex-1" />
      ) : (
        <span className={cn("min-w-0 flex-1 truncate", state.chat.error && "text-rose")}>
          {state.chat.error ?? spokenText(last?.content ?? "")}
        </span>
      )}
    </button>
  );
}

function useWhereOrNull(state: AssistantState | null) {
  // Hooks run alike with and without an assistant: a stand-in state keeps their order.
  const where = useWhere(state ?? STAND_IN);
  return state ? where : null;
}

const STAND_IN = {
  layout: "bottom",
  open: false,
  chat: { messages: [] },
} as unknown as AssistantState;

/** The sidebar, beside the page, on a window wide enough; its grip pulls the chat out to the bottom. */
export function AssistantSidebar({ column }: { column: RefObject<HTMLDivElement | null> }) {
  const state = useAssistant();
  const lifted = Boolean(useHighlight());
  const composer = useRef<ComposerHandle>(null);
  const where = useWhereOrNull(state);
  if (!(state && where && where.where === "sidebar")) {
    return null;
  }
  return (
    <DropZone
      composer={composer}
      className={cn(
        "flex w-[400px] shrink-0 flex-col border-border-soft border-l bg-card",
        lifted && "relative z-[61]",
      )}
    >
      <Header
        state={state}
        where="sidebar"
        wide={where.wide}
        phone={where.phone}
        grip={
          <Grip state={state} column={column} frame={() => null} wide={where.wide} from="sidebar" />
        }
      />
      <Thread state={state} composer={composer} />
      <Bottom state={state} composer={composer} />
    </DropZone>
  );
}

// --- the highlight -------------------------------------------------------------------------

/** Dims the page except the element the assistant points at, or rings it, with its card. */
export function HighlightLayer() {
  const highlight = useHighlight();
  const state = useAssistant();
  const [rect, setRect] = useState<DOMRect | null>(null);
  useEffect(() => {
    if (!highlight) {
      setRect(null);
      return;
    }
    let frame = 0;
    const follow = () => {
      if (!highlight.el.isConnected) {
        setHighlight(null);
        return;
      }
      setRect(highlight.el.getBoundingClientRect());
      frame = requestAnimationFrame(follow);
    };
    follow();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setHighlight(null);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKey);
    };
  }, [highlight]);
  if (!(highlight && rect)) {
    return null;
  }
  const pad = 6;
  const box = {
    left: rect.left - pad,
    top: rect.top - pad,
    width: rect.width + pad * 2,
    height: rect.height + pad * 2,
  };
  const below = box.top + box.height + 220 < window.innerHeight;
  const cardTop = below ? box.top + box.height + 10 : Math.max(10, box.top - 10);
  const cardLeft = Math.min(Math.max(10, box.left), window.innerWidth - 330);
  const answer = (text: string) => {
    setHighlight(null);
    void state?.chat.send(text);
  };
  return createPortal(
    <div data-assistant-ui className="pointer-events-none fixed inset-0 z-[60]">
      {highlight.mode === "spotlight" ? (
        <div
          className="pointer-events-auto absolute rounded-xl transition-all duration-200"
          style={{ ...box, boxShadow: "0 0 0 100vmax oklch(0.2 0.01 60 / 0.45)" }}
          onClick={() => setHighlight(null)}
          onKeyDown={undefined}
          role="presentation"
        />
      ) : null}
      <div
        className="absolute rounded-xl ring-2 ring-ember ring-offset-2 ring-offset-transparent transition-all duration-200"
        style={box}
      />
      {highlight.title || highlight.text || highlight.buttons.length ? (
        <div
          className="pointer-events-auto absolute w-80 max-w-[calc(100vw-20px)] animate-rise rounded-xl bg-card p-3.5 shadow-overlay ring-1 ring-border"
          style={{
            left: cardLeft,
            ...(below ? { top: cardTop } : { bottom: window.innerHeight - cardTop }),
          }}
        >
          <div className="flex items-start gap-2.5">
            <Mascot kind="round" size={28} goggles interactive={false} />
            <div className="min-w-0 flex-1">
              {highlight.title ? (
                <div className="font-medium text-[0.875rem]">{highlight.title}</div>
              ) : null}
              {highlight.text ? (
                <p className="mt-0.5 text-[0.8125rem] text-ink-2 leading-relaxed">
                  {highlight.text}
                </p>
              ) : null}
            </div>
          </div>
          <div className="mt-3 flex flex-wrap justify-end gap-1.5">
            {highlight.buttons.map((b) => (
              <button
                key={b}
                type="button"
                onClick={() => answer(b)}
                className="rounded-full bg-paper-2 px-3 py-1.5 text-[0.8125rem] text-ink-2 transition hover:bg-paper-3 hover:text-ink"
              >
                {b}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setHighlight(null)}
              className="rounded-full bg-primary px-3 py-1.5 font-medium text-[0.8125rem] text-primary-foreground"
            >
              {t("assistant.gotIt")}
            </button>
          </div>
        </div>
      ) : null}
    </div>,
    document.body,
  );
}
