import {
  AskPanel,
  choiceLabel,
  DownloadButtons,
  FieldInput,
  initialValues,
  isTouch,
  ListCheck,
  ListDownloads,
  ListTable,
  LiveBrowser,
  OutputView,
  StoreButton,
  textHints,
  useDoneSignal,
  useWakeLock,
  type Values,
} from "@engenty-wizards/runner";
import {
  FIELD_WAYS,
  type Field,
  isDecidedField,
  type LocationValue,
  type PageStep,
  type ResultStep,
  type ReviewStep,
  shownFields,
} from "@engenty-wizards/shared/definition";
import { readNumber } from "@engenty-wizards/shared/numbers";
import type { RunEvent, RunNoteCode, RunView } from "@engenty-wizards/shared/run";
import {
  ArrowUp,
  Check,
  Hand,
  Mic,
  Paperclip,
  Pencil,
  Phone,
  PhoneOff,
  RotateCcw,
  Sparkles,
  Square,
  Undo2,
  Video,
  VideoOff,
  Volume2,
  VolumeX,
} from "lucide-react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { withBase } from "@/lib/base";
import { Mascot } from "../brand";
import { api } from "../lib/api";
import { eventText, lang, t } from "../lib/i18n";
import { canSpeak, useReadAloud, useReadLines } from "../lib/read-aloud";
import { useDictation } from "../lib/speech";
import { ShareResultButton } from "../share/ShareSheet";
import { cn, IconButton, LinkedText, Spinner, Textarea } from "../ui";
import { CallStage } from "./CallStage";
import { type PageBinding, useLiveVoice } from "./live-voice";
import { useRun } from "./useRun";

/*
 * The same run as `RunnerView`, told as a chat: the wizard asks one field at a time, the person
 * answers in the composer or with a tap, and every answer stays in the thread above.
 */

type Run = ReturnType<typeof useRun>;

/** One message of the thread. Consecutive messages of the wizard share one engenty. */
export interface Line {
  key: string;
  who: "bot" | "me";
  node: ReactNode;
  /**
   * A card the width of the thread: an output, a field's own control, a question of the run.
   * "most": the wizard's browser, four fifths of the thread on a wider screen.
   */
  wide?: boolean | "most";
  tone?: "error";
  /** The person's last answer can be changed. */
  onEdit?: () => void;
  /** Where a long answer of the wizard starts: the thread shows it from here, not from its end. */
  anchor?: boolean;
  /** No bubble around it: the answers to tap, under the wizard's question. */
  bare?: boolean;
}

const bot = (key: string, node: ReactNode, more?: Partial<Line>): Line => ({
  key,
  who: "bot",
  node,
  ...more,
});
const me = (key: string, node: ReactNode, more?: Partial<Line>): Line => ({
  key,
  who: "me",
  node,
  ...more,
});

/* ---------- the frame: header, thread, dock ---------- */

const DockSlot = createContext<HTMLElement | null>(null);

/**
 * Speaking and listening around a run's chat: the run whose route writes a recording down, and
 * whether the wizard's bubbles are read aloud. An accessibility feature, switched on per browser.
 */
const SpeechContext = createContext<{
  runId: string;
  lang: string;
  readAloud: boolean;
  setReadAloud: (on: boolean) => void;
  /** The live conversation on the run, where the runtime has a model for it. */
  voice: ReturnType<typeof useLiveVoice> | null;
  /** The conversation was asked for first: its button leads. */
  talk: boolean;
  /** The chat is the screen beside a call: the call's own controls take the voice buttons. */
  call: boolean;
  /** The page the run is on lends the conversation its draft. */
  bindPage: (binding: PageBinding | null) => void;
} | null>(null);

/** The conversation's state, for a header that shows the wizard speaking. */
export function useVoiceState() {
  const speech = useContext(SpeechContext);
  return speech?.voice ?? null;
}

/** What the person types into, under the thread: the composer. */
export function Dock({ children }: { children: ReactNode }) {
  const el = useContext(DockSlot);
  return el ? createPortal(children, el) : null;
}

/**
 * The chat's frame. The thread scrolls and stays at its newest message while the person is down
 * there; anything they do in the dock brings them back down.
 */
export function ChatShell({
  header,
  footer,
  children,
}: {
  header?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const [dock, setDock] = useState<HTMLDivElement | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useLayoutEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner) {
      return;
    }
    // Only the person scrolling up lets go of the bottom: a scroll event can arrive after the
    // thread has already grown again, and then reads as far from the bottom.
    let last = el.scrollTop;
    const onScroll = () => {
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) {
        follow.current = true;
      } else if (el.scrollTop < last) {
        follow.current = false;
      }
      last = el.scrollTop;
    };
    // A review or a result comes in at its start; the person reads down from there.
    let anchored: Element | null = null;
    const observer = new ResizeObserver(() => {
      const anchor = inner.querySelector("[data-anchor]");
      if (anchor && anchor !== anchored) {
        anchored = anchor;
        el.scrollTop += anchor.getBoundingClientRect().top - el.getBoundingClientRect().top - 12;
        follow.current = false;
        last = el.scrollTop;
      } else if (follow.current) {
        el.scrollTop = el.scrollHeight;
      }
    });
    el.scrollTop = el.scrollHeight;
    el.addEventListener("scroll", onScroll, { passive: true });
    // The thread grows, or the dock below it does and leaves it less room.
    observer.observe(inner);
    observer.observe(el);
    return () => {
      observer.disconnect();
      el.removeEventListener("scroll", onScroll);
    };
  }, []);
  return (
    <DockSlot.Provider value={dock}>
      <div className="flex h-full min-h-0 flex-col">
        {header}
        <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div
            ref={content}
            className="mx-auto flex w-full max-w-[760px] flex-col gap-3 px-3 pt-5 pb-4 sm:px-6"
          >
            {children}
          </div>
        </div>
        <div
          className="shrink-0 border-border-soft border-t bg-background"
          onPointerDownCapture={() => {
            follow.current = true;
          }}
          onKeyDownCapture={() => {
            follow.current = true;
          }}
        >
          <div ref={setDock} className="mx-auto w-full max-w-[760px] px-3 pt-3 sm:px-6" />
          {footer}
        </div>
      </div>
    </DockSlot.Provider>
  );
}

/** The thread: the wizard's messages on the left beside its engenty, the person's on the right. */
export function Thread({ avatar, lines }: { avatar: string; lines: Line[] }) {
  const speech = useContext(SpeechContext);
  // What is read: the wizard's bubbles that are words, not the answers to tap or an output.
  const spoken = useMemo(
    () => lines.map((l) => ({ key: l.key, who: l.who, spoken: !l.bare && !l.wide })),
    [lines],
  );
  const textOf = useCallback((key: string) => {
    const el = document.querySelector<HTMLElement>(`[data-say="${CSS.escape(key)}"]`);
    return (
      el?.querySelector("[data-say-text]")?.getAttribute("data-say-text") ?? el?.innerText ?? null
    );
  }, []);
  useReadLines(Boolean(speech?.readAloud), speech?.lang ?? lang, spoken, textOf);
  const groups: { who: Line["who"]; lines: Line[] }[] = [];
  for (const line of lines) {
    const last = groups.at(-1);
    if (last && last.who === "bot" && line.who === "bot") {
      last.lines.push(line);
    } else {
      groups.push({ who: line.who, lines: [line] });
    }
  }
  return groups.map((group, i) =>
    group.who === "bot" ? (
      <div key={group.lines[0].key} className="flex items-start gap-2.5">
        <div className="sticky top-1 shrink-0 pt-0.5">
          {/* Only the engenty that speaks now follows the pointer. */}
          <Mascot kind={avatar} size={30} interactive={i >= groups.length - 2} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col items-start gap-1.5">
          {group.lines.map((line) => (
            <div
              key={line.key}
              data-anchor={line.anchor ? "" : undefined}
              data-say={line.key}
              className={cn(
                "animate-rise",
                line.bare
                  ? "w-full pt-1"
                  : "rounded-2xl rounded-tl-md text-[0.9375rem] text-ink leading-relaxed",
                !line.bare &&
                  (line.wide
                    ? cn(
                        "w-full bg-card p-4 shadow-soft ring-1 ring-border-soft",
                        line.wide === "most" && "md:w-4/5",
                      )
                    : "max-w-[min(36rem,100%)] bg-card px-4 py-2.5 shadow-soft ring-1 ring-border-soft"),
                line.tone === "error" && "bg-rose-tint text-rose shadow-none ring-0",
              )}
            >
              {line.node}
            </div>
          ))}
        </div>
      </div>
    ) : (
      group.lines.map((line) => (
        <div key={line.key} className="flex animate-rise flex-col items-end gap-1 pl-10">
          <div className="max-w-[min(32rem,100%)] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-[0.9375rem] text-primary-foreground leading-relaxed">
            {line.node}
          </div>
          {line.onEdit ? (
            <button
              type="button"
              onClick={line.onEdit}
              className="inline-flex items-center gap-1 px-1 text-[0.75rem] text-ink-4 transition hover:text-ink-2 coarse:min-h-9"
            >
              <Pencil className="size-3" /> {t("chat.change")}
            </button>
          ) : null}
        </div>
      ))
    ),
  );
}

/** Three dots: the wizard is about to say something. */
function Dots() {
  return (
    <span
      className="inline-flex items-center gap-1 py-1.5"
      role="status"
      aria-label={t("run.working")}
    >
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="size-1.5 animate-typing rounded-full bg-ink-3"
          style={{ animationDelay: `${i * 160}ms` }}
        />
      ))}
    </span>
  );
}

/* ---------- what the person answers with ---------- */

/** The answers to tap, in the thread under the wizard's question. */
export function QuickReplies({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

/** The answers to tap as the wizard's last message. */
export const replies = (key: string, children: ReactNode): Line =>
  bot(key, <QuickReplies>{children}</QuickReplies>, { bare: true });

export function Reply({
  onClick,
  children,
  primary,
  on,
  disabled,
  busy,
}: {
  onClick: () => void;
  children: ReactNode;
  primary?: boolean;
  /** Picked, in a choice of several. */
  on?: boolean;
  disabled?: boolean;
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      disabled={disabled || busy}
      onClick={onClick}
      className={cn(
        "inline-flex h-10 items-center gap-1.5 rounded-full px-4 font-medium text-[0.875rem] transition active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 coarse:h-11",
        primary
          ? "bg-primary text-primary-foreground hover:brightness-[1.06]"
          : on
            ? "bg-ember-tint text-ink ring-1 ring-ember"
            : "bg-card text-ink-2 ring-1 ring-input hover:text-ink hover:ring-ink-4",
      )}
    >
      {busy ? <Spinner className="size-4" /> : null}
      {children}
    </button>
  );
}

/** The line the person types into. Enter sends; in a long answer Shift+Enter starts a new line. */
type ComposerInput = HTMLInputElement & HTMLTextAreaElement;

function Composer({
  initial = "",
  placeholder,
  multiline,
  inputProps,
  busy,
  disabled,
  inputRef,
  onSend,
}: {
  initial?: string;
  placeholder: string;
  multiline?: boolean;
  inputProps?: React.InputHTMLAttributes<HTMLInputElement>;
  busy?: boolean;
  disabled?: boolean;
  /** For the turn to put the cursor here. */
  inputRef?: React.RefObject<ComposerInput | null>;
  /** False: the text stays to be corrected. */
  onSend: (text: string) => boolean | undefined;
}) {
  const [text, setText] = useState(initial);
  const own = useRef<ComposerInput>(null);
  const input = inputRef ?? own;
  const speech = useContext(SpeechContext);
  const dictation = useDictation(text, setText, {
    endpoint: speech ? `/api/runs/${speech.runId}/transcribe` : undefined,
  });
  const canDictate = Boolean(speech) && dictation.supported && !disabled;
  // ⌘⇧M (Ctrl on Windows) starts and stops dictating, from anywhere on the page.
  useEffect(() => {
    if (!canDictate) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "m") {
        e.preventDefault();
        dictation.toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canDictate, dictation.toggle]);
  // On a desk the next question is answered without reaching for the mouse; a phone keeps its keyboard down.
  useEffect(() => {
    if (!isTouch && !disabled) {
      input.current?.focus();
    }
  }, [disabled, input]);
  const send = () => {
    if (busy || disabled) {
      return;
    }
    if (dictation.listening) {
      dictation.toggle();
    }
    if (onSend(text) !== false) {
      setText("");
    }
  };
  const heard = dictation.listening
    ? t("chat.listening")
    : dictation.processing
      ? t("chat.transcribing")
      : placeholder;
  const voice = speech?.voice ?? null;
  // Beside a call the stage holds the voice controls; the composer is only for typing.
  const inCall = Boolean(speech?.call);
  const tools =
    speech && !inCall && (canSpeak || canDictate || voice) ? (
      <div className="mb-1 flex shrink-0 items-center">
        {voice ? (
          <IconButton
            label={t(
              voice.state === "live"
                ? "talk.stop"
                : voice.state === "connecting"
                  ? "talk.connecting"
                  : "talk.start",
            )}
            aria-pressed={voice.state === "live"}
            disabled={voice.state === "connecting"}
            onClick={() => (voice.state === "live" ? voice.stop() : void voice.start())}
            className={cn(
              "size-9",
              voice.state === "live" && "bg-rose-tint text-rose hover:bg-rose-tint hover:text-rose",
              voice.state === "off" &&
                speech.talk &&
                "bg-primary text-primary-foreground hover:bg-primary",
            )}
          >
            {voice.state === "connecting" ? (
              <Spinner className="size-4" />
            ) : voice.state === "live" ? (
              <PhoneOff className="size-4" />
            ) : (
              <Phone className="size-4" />
            )}
          </IconButton>
        ) : null}
        {voice?.state === "live" ? (
          <IconButton
            label={t(voice.camera ? "talk.cameraOff" : "talk.camera")}
            aria-pressed={voice.camera}
            onClick={() => (voice.camera ? voice.stopCamera() : void voice.startCamera())}
            className={cn("size-9", voice.camera && "text-ink")}
          >
            {voice.camera ? <Video className="size-4" /> : <VideoOff className="size-4" />}
          </IconButton>
        ) : null}
        {canSpeak ? (
          <IconButton
            label={t(speech.readAloud ? "chat.readAloudOff" : "chat.readAloud")}
            aria-pressed={speech.readAloud}
            onClick={() => speech.setReadAloud(!speech.readAloud)}
            className={cn("size-9", speech.readAloud && "text-ink")}
          >
            {speech.readAloud ? <Volume2 className="size-4" /> : <VolumeX className="size-4" />}
          </IconButton>
        ) : null}
        {canDictate ? (
          <IconButton
            label={t(dictation.listening ? "chat.dictateStop" : "chat.dictate")}
            aria-pressed={dictation.listening}
            disabled={dictation.processing}
            onClick={dictation.toggle}
            className={cn(
              "size-9",
              dictation.listening && "bg-rose-tint text-rose hover:bg-rose-tint hover:text-rose",
            )}
          >
            {dictation.processing ? (
              <Spinner className="size-4" />
            ) : dictation.listening ? (
              <Square className="size-3.5 animate-pulse-dot fill-current" />
            ) : (
              <Mic className="size-4" />
            )}
          </IconButton>
        ) : null}
      </div>
    ) : null;
  return (
    <form
      className="pb-3"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      {/* The camera's picture, small, while the wizard can see it; the element stays so a frame can be taken. */}
      {voice && !inCall ? (
        <video
          ref={voice.video}
          muted
          playsInline
          autoPlay
          className={cn(
            "mb-2 ml-auto w-32 rounded-xl bg-black object-cover shadow-soft ring-1 ring-border-soft",
            voice.camera ? "block" : "hidden",
          )}
        />
      ) : null}
      <div
        className={cn(
          "flex items-end gap-1 rounded-[1.375rem] border border-input bg-card pr-1.5 pl-1 transition focus-within:border-focus focus-within:ring-4 focus-within:ring-focus-glow",
          disabled && "opacity-60",
        )}
      >
        {tools}
        {multiline ? (
          <Textarea
            ref={input}
            minRows={1}
            maxRows={6}
            value={text}
            disabled={disabled}
            placeholder={heard}
            autoCapitalize="sentences"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !isTouch && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
            className="min-h-11 border-0 bg-transparent py-2.5 shadow-none focus:ring-0"
          />
        ) : (
          <input
            ref={input}
            {...inputProps}
            value={text}
            disabled={disabled}
            placeholder={heard}
            enterKeyHint="send"
            onChange={(e) => setText(e.target.value)}
            className="h-11 min-w-0 flex-1 bg-transparent px-3 text-[0.9375rem] text-ink outline-none placeholder:text-ink-4"
          />
        )}
        <button
          type="submit"
          aria-label={t("chat.send")}
          title={t("chat.send")}
          disabled={busy || disabled}
          className="mb-1 flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition hover:brightness-[1.06] disabled:opacity-40"
        >
          {busy ? <Spinner className="size-4" /> : <ArrowUp className="size-4" />}
        </button>
      </div>
      {dictation.error ? (
        <p className="mt-1.5 px-3 text-[0.75rem] text-rose">
          {dictation.error === "denied" ? t("chat.micDenied") : dictation.error}
        </p>
      ) : inCall ? null : voice?.error ? (
        <p className="mt-1.5 px-3 text-[0.75rem] text-rose">{voice.error}</p>
      ) : voice?.state === "live" ? (
        <p className="mt-1.5 px-3 text-[0.75rem] text-ink-3">
          {voice.speaking
            ? t("talk.speaking")
            : voice.listening
              ? t("talk.listening")
              : t("talk.live")}
        </p>
      ) : speech?.talk && voice?.state === "off" ? (
        <p className="mt-1.5 px-3 text-[0.75rem] text-ink-3">{t("talk.hint")}</p>
      ) : null}
    </form>
  );
}

/** The composer while there is nothing to type: the answer is tapped above, or the wizard works. */
export function Idle({ placeholder = t("chat.above") }: { placeholder?: string }) {
  return (
    <Dock>
      <Composer disabled placeholder={placeholder} onSend={() => false} />
    </Dock>
  );
}

/* ---------- fields as questions and answers ---------- */

type Way = "typed" | "tapped" | "control";

/**
 * How a field is answered in the chat, from the shared `FIELD_WAYS`: typed into the composer,
 * tapped from its choices; the others bring their own control into the thread.
 */
function wayOf(field: Field): Way {
  const way = FIELD_WAYS[field.kind];
  if (way === "typed" && !field.scan) {
    return "typed";
  }
  return way === "tapped" ? "tapped" : "control";
}

const isEmpty = (v: unknown) =>
  v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

/** What the runtime would turn down, said before the page goes there. */
function problem(field: Field, v: unknown): string | null {
  const free = field.kind === "toggle" || field.kind === "connection" || field.kind === "list";
  if (isEmpty(v)) {
    return field.required && !free ? t("chat.required") : null;
  }
  const s = String(v).trim();
  if (field.kind === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) {
    return t("chat.badEmail");
  }
  if (field.kind === "url") {
    try {
      new URL(s);
    } catch {
      return t("chat.badUrl");
    }
  }
  if (field.kind === "number" && readNumber(s) === null) {
    return t("chat.badNumber");
  }
  if (Array.isArray(v) && field.multiple && field.min && v.length < field.min) {
    return t("run.filesMin", { n: v.length, min: field.min });
  }
  return null;
}

/** A typed answer as the field keeps it: an address without its scheme gets https://. */
function typedValue(field: Field, text: string): string | undefined {
  const s = field.kind === "textarea" ? text.replace(/\s+$/, "") : text.trim();
  if (!s) {
    return undefined;
  }
  return field.kind === "url" && !/^[a-z][a-z0-9+.-]*:/i.test(s) ? `https://${s}` : s;
}

function FieldAsk({ field }: { field: Field }) {
  return (
    <>
      <span className="font-medium">{field.label}</span>
      {field.help ? (
        <span className="mt-0.5 block text-[0.8125rem] text-ink-3">{field.help}</span>
      ) : null}
    </>
  );
}

function PageAsk({ step, only }: { step: PageStep; only?: Field }) {
  return (
    <>
      <span className="font-medium">{step.title}</span>
      {step.description ? (
        <span className="mt-0.5 block text-ink-2">{step.description}</span>
      ) : null}
      {only?.help ? (
        <span className="mt-1 block text-[0.8125rem] text-ink-3">{only.help}</span>
      ) : null}
    </>
  );
}

/** The person's answer to a field, as their message. */
function Answer({ field, value, runId }: { field: Field; value: unknown; runId: string }) {
  if (field.kind === "connection") {
    return <>{typeof value === "string" && value ? value : t("chat.connected")}</>;
  }
  if (field.kind === "list") {
    return (
      <span className="inline-flex items-center gap-1.5">
        <Check className="size-4" /> {t("chat.checked")}
      </span>
    );
  }
  if (field.kind === "toggle") {
    return <>{t(value === true ? "run.yes" : "run.no")}</>;
  }
  if (isEmpty(value)) {
    return <span className="italic opacity-80">{t("chat.skipped")}</span>;
  }
  switch (field.kind) {
    case "multiselect":
      return <>{(value as string[]).map(choiceLabel).join(", ")}</>;
    case "select":
      return <>{choiceLabel(String(value))}</>;
    case "date": {
      const d = new Date(`${String(value)}T00:00`);
      return (
        <>
          {Number.isNaN(d.getTime())
            ? String(value)
            : new Intl.DateTimeFormat(lang, { dateStyle: "long" }).format(d)}
        </>
      );
    }
    case "color":
      return (
        <span className="inline-flex items-center gap-2">
          <span
            className="size-4 rounded-full ring-1 ring-white/50"
            style={{ background: String(value) }}
          />
          {String(value)}
        </span>
      );
    case "image":
    case "signature": {
      const ids = Array.isArray(value) ? (value as string[]) : [String(value)];
      return (
        <span className="-mx-1.5 flex flex-wrap gap-1.5">
          {ids.map((id) => (
            <img
              key={id}
              src={withBase(`/api/runs/${runId}/assets/${id}`)}
              alt=""
              className={cn(
                "h-16 rounded-lg bg-white",
                field.kind === "image" ? "w-16 object-cover" : "object-contain px-1",
              )}
            />
          ))}
        </span>
      );
    }
    case "file": {
      const n = Array.isArray(value) ? value.length : 1;
      return (
        <span className="inline-flex items-center gap-1.5">
          <Paperclip className="size-4" /> {t(n === 1 ? "chat.file" : "chat.files", { n })}
        </span>
      );
    }
    case "audio": {
      const seconds = (value as { seconds?: number }).seconds;
      return (
        <span className="inline-flex items-center gap-1.5">
          <Mic className="size-4" /> {t("chat.voice")}
          {seconds ? ` · ${Math.round(seconds)} s` : ""}
        </span>
      );
    }
    case "location": {
      const v = value as LocationValue;
      return <>{v.label || `${v.lat?.toFixed(5)}, ${v.lng?.toFixed(5)}`}</>;
    }
    case "items":
      return <>{t("chat.rows", { n: Array.isArray(value) ? value.length : 0 })}</>;
    default:
      return <>{String(value)}</>;
  }
}

/**
 * A page's questions and the answers given to `asked`, as the thread shows them. With one field
 * (`only`) the page's own title is the question.
 */
function pageLines(
  step: PageStep,
  key: string,
  values: Values,
  runId: string,
  asked: Field[],
  only?: Field,
): Line[] {
  const lines: Line[] = [bot(key, <PageAsk step={step} only={only} />)];
  for (const field of asked) {
    if (!only) {
      lines.push(bot(`${key}:${field.id}`, <FieldAsk field={field} />));
    }
    lines.push(
      me(`${key}:${field.id}:a`, <Answer field={field} value={values[field.id]} runId={runId} />),
    );
  }
  return lines;
}

/**
 * The fields of a page answered before: a field under a condition, or one a decision picks, only
 * where it holds a value — hidden ones are not kept, so an empty one was not asked.
 */
const answeredFields = (step: PageStep, values: Values) =>
  step.fields.filter(
    (f) => (!f.when && !isDecidedField(f)) || (values[f.id] !== undefined && values[f.id] !== null),
  );

/** What came before the step the run is on: the greeting, the pages answered, the reviews passed. */
function historyLines(view: RunView, back?: () => void): Line[] {
  const lines: Line[] = [];
  if (view.wizard.description) {
    lines.push(bot("hello", view.wizard.description));
  }
  if (view.wizard.intro) {
    lines.push(bot("intro", view.wizard.intro));
  }
  for (const [n, step] of view.answered.entries()) {
    const key = `${n}:${step.id}`;
    if (step.type === "page") {
      const only = step.fields.length === 1 ? step.fields[0] : undefined;
      lines.push(
        ...pageLines(step, key, view.values, view.id, answeredFields(step, view.values), only),
      );
    } else if (step.type === "review") {
      lines.push(bot(key, <span className="font-medium">{step.title}</span>));
      lines.push(me(`${key}:a`, t("run.accept")));
    }
  }
  const last = lines.at(-1);
  if (back && last?.who === "me") {
    lines[lines.length - 1] = { ...last, onEdit: back };
  }
  return lines;
}

/* ---------- the step the run is on ---------- */

/**
 * The fields of the page the run is on that can be asked: those a decision kept, with choices
 * from earlier data in place of the fixed ones.
 */
function pageFields(step: PageStep, view: RunView): Field[] {
  return step.fields
    .filter((f) => !isDecidedField(f) || view.decidedFields?.includes(f.id))
    .map((f) => (view.options?.[f.id]?.length ? { ...f, options: view.options[f.id] } : f));
}

function PageTurn({
  view,
  run,
  step,
  before,
}: {
  view: RunView;
  run: Run;
  step: PageStep;
  before: Line[];
}) {
  const fields = useMemo(() => pageFields(step, view), [step, view]);
  const known = view.known ?? {};
  // Keyed by the page at the call site, as `PageForm`: a page (or a page revisited) starts afresh.
  const [values, setValues] = useState<Values>(() => initialValues(step, view));
  /**
   * The fields answered, by id. A page gone back to reopens its last answer, as "change" on that
   * answer promised.
   */
  const [done, setDone] = useState<string[]>(() => {
    if (!step.fields.some((f) => view.values[f.id] !== undefined)) {
      return [];
    }
    const shown = shownFields(pageFields(step, view), view.known ?? {}, initialValues(step, view));
    return shown.slice(0, -1).map((f) => f.id);
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  // The page went through; the run moves on as soon as the stream says so.
  const [sent, setSent] = useState(false);
  // Which fields are asked follows the answers: a field's condition can read an earlier one.
  const shown = shownFields(fields, known, values);
  const asked = shown.filter((f) => done.includes(f.id));
  const field = shown.find((f) => !done.includes(f.id));
  const only = fields.length === 1 ? fields[0] : undefined;
  const last = asked.at(-1);
  const reopen = last ? () => setDone((ids) => ids.filter((id) => id !== last.id)) : undefined;

  // The runtime turned something down: back to the first field it named.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the runtime answers
  useEffect(() => {
    const ids = Object.keys(run.fieldErrors);
    const now = shownFields(fields, known, values);
    const i = now.findIndex((f) => ids.includes(f.id));
    if (i >= 0) {
      setDone(now.slice(0, i).map((f) => f.id));
      setErrors(run.fieldErrors);
    }
  }, [run.fieldErrors]);

  const send = (all: Values) => {
    void run.submitPage(step.id, all).then(setSent);
  };
  // The live conversation sets fields and sends the page through the same draft.
  const speech = useContext(SpeechContext);
  const valuesRef = useRef(values);
  valuesRef.current = values;
  const bindPage = speech?.bindPage;
  const sendRef = useRef(send);
  sendRef.current = send;
  useEffect(() => {
    if (!bindPage) {
      return;
    }
    const current = shownFields(fields, known, values);
    bindPage({
      step,
      fields: current,
      values,
      setField: (id, value) => {
        const target = current.find((f) => f.id === id);
        if (!target) {
          return "no such field on this page";
        }
        const error = problem(target, value);
        if (error) {
          return error;
        }
        setValues((prev) => ({ ...prev, [id]: value }));
        setDone((prev) => (prev.includes(id) ? prev : [...prev, id]));
        setErrors({});
        return null;
      },
      submit: () => sendRef.current(valuesRef.current),
    });
    return () => bindPage(null);
  }, [bindPage, step, fields, known, values]);
  const answer = (value: unknown) => {
    if (!field) {
      return false;
    }
    const error = problem(field, value);
    if (error) {
      setErrors({ [field.id]: error });
      return false;
    }
    const next = { ...values, [field.id]: value };
    const nextDone = [...done, field.id];
    setValues(next);
    setDone(nextDone);
    setErrors({});
    // A hidden field is neither asked nor required; the runtime does not keep its value.
    if (!shownFields(fields, known, next).some((f) => !nextDone.includes(f.id))) {
      send(next);
    }
    return true;
  };

  const lines = [
    ...before.map((l) => (done.length ? { ...l, onEdit: undefined } : l)),
    ...pageLines(step, `now:${step.id}`, values, view.id, asked, only).map((l, i, all) =>
      // The latest answer of this page can be taken back while the page is not yet sent.
      i === all.length - 1 && l.who === "me" && field ? { ...l, onEdit: reopen } : l,
    ),
  ];
  if (field) {
    const way = wayOf(field);
    if (way === "control") {
      lines.push(
        bot(
          `now:${step.id}:${field.id}:control`,
          <FieldInput
            field={field}
            value={values[field.id]}
            values={values}
            runId={view.id}
            view={view}
            closed={view.closed?.[field.id]}
            onChange={(v) => setValues((prev) => ({ ...prev, [field.id]: v }))}
            onBusy={setPending}
          />,
          { wide: true },
        ),
      );
    } else if (!only) {
      lines.push(bot(`now:${step.id}:${field.id}`, <FieldAsk field={field} />));
    }
    if (errors[field.id]) {
      lines.push(bot(`now:${step.id}:${field.id}:error`, errors[field.id], { tone: "error" }));
    }
  } else if (run.busy || sent) {
    lines.push(bot("sending", <Dots />));
  } else if (run.error) {
    lines.push(bot("send-error", run.error, { tone: "error" }));
  }

  let dock: ReactNode = <Idle />;
  if (sent || (!field && done.length > 0 && run.busy)) {
    dock = <Idle placeholder={t("run.working")} />;
  } else if (!field) {
    // Nothing to ask (a page that only says something), or the page did not go through.
    lines.push(
      replies(
        `now:${step.id}:go`,
        <>
          <Reply primary busy={run.busy} onClick={() => send(values)}>
            {step.cta || t("run.next")}
          </Reply>
          {reopen ? (
            <Reply onClick={reopen} disabled={run.busy}>
              {t("run.back")}
            </Reply>
          ) : null}
        </>,
      ),
    );
  } else {
    const way = wayOf(field);
    const skip =
      !field.required && field.kind !== "connection" && field.kind !== "list" ? (
        <Reply onClick={() => answer(undefined)}>{t("chat.skip")}</Reply>
      ) : null;
    if (way === "typed") {
      if (skip) {
        lines.push(replies(`now:${step.id}:${field.id}:replies`, skip));
      }
      const current = values[field.id];
      dock = (
        <Dock>
          <Composer
            key={field.id}
            initial={isEmpty(current) ? "" : String(current)}
            multiline={field.kind === "textarea"}
            placeholder={field.placeholder || (only ? field.label : t("chat.placeholder"))}
            inputProps={inputPropsOf(field)}
            busy={run.busy}
            onSend={(text) => answer(typedValue(field, text))}
          />
        </Dock>
      );
    } else if (way === "tapped") {
      lines.push(
        bot(
          `now:${step.id}:${field.id}:replies`,
          <Choice field={field} view={view} value={values[field.id]} onAnswer={answer} />,
          { bare: true },
        ),
      );
    } else {
      // The field's control stands in the thread; under it, it is sent.
      const lastOne = shown.filter((f) => !done.includes(f.id)).length === 1;
      lines.push(
        replies(
          `now:${step.id}:${field.id}:replies`,
          <>
            <Reply primary disabled={pending} onClick={() => answer(values[field.id])}>
              {lastOne && step.cta ? step.cta : t("chat.send")}
            </Reply>
            {skip}
          </>,
        ),
      );
    }
  }

  return (
    <>
      <Thread avatar={view.wizard.avatar} lines={lines} />
      {dock}
    </>
  );
}

function inputPropsOf(field: Field): React.InputHTMLAttributes<HTMLInputElement> {
  switch (field.kind) {
    case "number":
      return { inputMode: "decimal", autoComplete: "off" };
    case "email":
      return {
        type: "email",
        inputMode: "email",
        autoComplete: "email",
        autoCapitalize: "off",
        autoCorrect: "off",
        spellCheck: false,
      };
    case "url":
      return {
        inputMode: "url",
        autoComplete: "url",
        autoCapitalize: "off",
        autoCorrect: "off",
        spellCheck: false,
      };
    case "date":
      return { type: "date" };
    default:
      return textHints(field);
  }
}

/** A choice as quick replies: one tap answers; several are picked and then sent. */
function Choice({
  field,
  view,
  value,
  onAnswer,
}: {
  field: Field;
  view: RunView;
  value: unknown;
  onAnswer: (v: unknown) => void;
}) {
  const shut = new Set(view.closed?.[field.id]?.values.map(String));
  const [picked, setPicked] = useState<string[]>(Array.isArray(value) ? (value as string[]) : []);
  if (field.kind === "toggle") {
    return (
      <QuickReplies>
        <Reply on={value === false} disabled={shut.has("false")} onClick={() => onAnswer(false)}>
          {t("run.no")}
        </Reply>
        <Reply on={value === true} disabled={shut.has("true")} onClick={() => onAnswer(true)}>
          {t("run.yes")}
        </Reply>
      </QuickReplies>
    );
  }
  const options = field.options ?? [];
  if (field.kind === "multiselect") {
    return (
      <QuickReplies>
        {options.map((o) => (
          <Reply
            key={o}
            on={picked.includes(o)}
            onClick={() =>
              setPicked((now) =>
                now.includes(o)
                  ? now.filter((x) => x !== o)
                  : options.filter((x) => x === o || now.includes(x)),
              )
            }
          >
            {choiceLabel(o)}
          </Reply>
        ))}
        <Reply primary disabled={field.required && !picked.length} onClick={() => onAnswer(picked)}>
          {picked.length || field.required ? t("chat.send") : t("chat.skip")}
        </Reply>
      </QuickReplies>
    );
  }
  return (
    <QuickReplies>
      {options.map((o) => (
        <Reply key={o} on={value === o} disabled={shut.has(o)} onClick={() => onAnswer(o)}>
          {choiceLabel(o)}
        </Reply>
      ))}
      {field.required ? null : <Reply onClick={() => onAnswer(undefined)}>{t("chat.skip")}</Reply>}
    </QuickReplies>
  );
}

/** The wizard at work: what it does right now, and the pictures it looks at or has just made. */
function Working({ view }: { view: RunView }) {
  const begun = useMemo(
    () =>
      [...view.events]
        .reverse()
        .find((ev) => ev.type === "step_started" && ev.stepId === view.step?.id),
    [view.events, view.step?.id],
  );
  const started = begun ? new Date(begun.at).getTime() : Date.now();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const recent = view.events.filter(
    (ev) =>
      (ev.type === "tool" || ev.type === "info") && new Date(ev.at).getTime() >= started - 500,
  );
  const latest = recent.at(-1);
  const browsing = [...recent].reverse().find(isBrowserEvent);
  const pictures = [...new Set(recent.map((ev) => ev.asset).filter((id): id is string => !!id))];
  return (
    // As wide as the line of what it does needs, so that line does not jump with every tool;
    // the whole bubble while the browser is shown.
    <div
      className={cn("flex max-w-full flex-col gap-1", browsing ? "w-full" : "w-96")}
      data-say-text={begun?.message ?? view.step?.title ?? t("run.working")}
    >
      <div className="flex items-center gap-3">
        <Dots />
        <span className="font-medium">
          {begun?.message ?? view.step?.title ?? t("run.working")}
        </span>
        <span className="text-[0.75rem] text-ink-4 tabular-nums">
          {t("run.elapsed", { s: Math.max(0, Math.round((now - started) / 1000)) })}
        </span>
      </div>
      {latest && latest !== browsing ? (
        <div className="flex items-center gap-1.5 text-[0.8125rem] text-ink-3">
          <Sparkles className="size-3.5 shrink-0 animate-breathe text-ember" />
          <span className="truncate">{eventText(latest)}</span>
        </div>
      ) : null}
      {browsing && view.status === "running" ? (
        <BrowserLive runId={view.id} event={browsing} />
      ) : null}
      {pictures.length ? (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {pictures.slice(-6).map((id) => (
            <img
              key={id}
              src={withBase(`/api/runs/${view.id}/assets/${id}`)}
              alt=""
              className="size-14 rounded-lg bg-paper-2 object-cover ring-1 ring-border-soft"
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

const BROWSER_NOTES = new Set<RunNoteCode>([
  "opens",
  "clicks",
  "clicksOn",
  "types",
  "typesText",
  "selects",
  "scrolls",
  "presses",
  "goesBack",
  "waitsForPage",
  "fastLoop",
  "looksAtPage",
  "personDrives",
  "agentDrives",
]);

function isBrowserEvent(ev: RunEvent): boolean {
  return !!ev.note && BROWSER_NOTES.has(ev.note.code);
}

/** While the person drives, how often the seat is checked: it goes back by itself when idle. */
const SEAT_CHECK_MS = 10_000;

/**
 * The wizard's browser as it works, streamed from the run, with what it just did over it. The
 * person can take it over (the wizard's next browser action waits) and hand it back. A stream
 * that breaks off (the step let the browser go) is hidden until the next browser action.
 */
function BrowserLive({ runId, event }: { runId: string; event: RunEvent }) {
  const [brokeAt, setBrokeAt] = useState<number | null>(null);
  const [seat, setSeat] = useState<"agent" | "person">("agent");
  const [busy, setBusy] = useState(false);
  const code = event.note?.code;
  useEffect(() => {
    if (code === "personDrives") {
      setSeat("person");
    } else if (code === "agentDrives") {
      setSeat("agent");
    }
  }, [code]);
  useEffect(() => {
    const check = () =>
      api
        .get<{ seat: "agent" | "person" }>(`/api/runs/${runId}/browser/seat`)
        .then((r) => setSeat(r.seat))
        .catch(() => undefined);
    void check();
    if (seat !== "person") {
      return;
    }
    const id = setInterval(check, SEAT_CHECK_MS);
    return () => clearInterval(id);
  }, [runId, seat]);
  if (brokeAt !== null && brokeAt >= event.id) {
    return null;
  }
  const driving = seat === "person";
  const pass = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ seat: "agent" | "person" }>(`/api/runs/${runId}/browser/seat`, {
        to: driving ? "agent" : "person",
      });
      setSeat(r.seat);
    } catch {
      // The browser is gone; the stream says so.
    } finally {
      setBusy(false);
    }
  };
  return (
    <LiveBrowser
      // A new connection after a break, the same one for every action in between.
      key={brokeAt ?? 0}
      runId={runId}
      driving={driving}
      caption={eventText(event)}
      hint={t("browser.driving")}
      onBroken={() => setBrokeAt(event.id)}
      className="mt-1.5"
      action={
        <button
          type="button"
          disabled={busy}
          onClick={() => void pass()}
          className={cn(
            "flex h-8 items-center gap-1.5 rounded-full px-3 font-medium text-[0.8125rem] shadow-soft transition-colors disabled:opacity-60",
            driving
              ? "bg-primary text-primary-foreground hover:bg-primary/90"
              : "bg-card/90 text-ink ring-1 ring-border-soft backdrop-blur hover:bg-card",
          )}
        >
          {driving ? <Undo2 className="size-3.5" /> : <Hand className="size-3.5" />}
          {driving ? t("browser.handBack") : t("browser.takeOver")}
        </button>
      }
    />
  );
}

function SectionTitle({ children, end }: { children: ReactNode; end?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <h3 className="font-display font-semibold text-[1rem]">{children}</h3>
      {end}
    </div>
  );
}

function ReviewTurn({
  view,
  run,
  step,
  before,
  asked,
  onNote,
}: {
  view: RunView;
  run: Run;
  step: ReviewStep;
  before: Line[];
  /** What the person asked to change in this review so far, oldest first. */
  asked: string[];
  onNote: (note: string) => void;
}) {
  const made = view.shown.filter((x) => x.output);
  const [target, setTarget] = useState<string | null>(made.length === 1 ? made[0].step.id : null);
  const prompt = useRef<ComposerInput>(null);
  const lines: Line[] = [
    ...before,
    ...asked.map((text, i) => me(`review:${step.id}:asked:${i}`, text)),
    bot(
      `review:${step.id}`,
      <>
        <span className="font-medium">{step.title}</span>
        {step.description ? (
          <span className="mt-0.5 block text-ink-2">{step.description}</span>
        ) : null}
      </>,
      { anchor: true },
    ),
    ...made.map(({ step: s, output }) =>
      bot(
        `review:${step.id}:${s.id}`,
        <>
          <SectionTitle>{s.title}</SectionTitle>
          <OutputView
            base={`/api/runs/${view.id}`}
            step={s}
            output={output}
            // A view's "new version" button says what the change is about.
            onSurfaceAction={
              step.regenerate
                ? () => {
                    setTarget(s.id);
                    prompt.current?.focus();
                  }
                : undefined
            }
          />
        </>,
        { wide: true },
      ),
    ),
    ...view.lists.map((list) =>
      bot(
        `review:${step.id}:list:${list.def.id}`,
        <>
          <SectionTitle>{list.def.title}</SectionTitle>
          {list.def.check ? (
            <ListCheck runId={view.id} list={list} />
          ) : (
            <ListTable runId={view.id} list={list} editable />
          )}
        </>,
        { wide: true },
      ),
    ),
  ];
  if (run.error) {
    lines.push(bot("review-error", run.error, { tone: "error" }));
  }
  const regenerate = step.regenerate && made.length > 0;
  lines.push(
    replies(
      `review:${step.id}:replies`,
      <>
        <Reply primary busy={run.busy} onClick={() => void run.accept(step.id)}>
          <Check className="size-4" /> {t("run.accept")}
        </Reply>
        {regenerate && made.length > 1
          ? made.map(({ step: s }) => (
              <Reply key={s.id} on={target === s.id} onClick={() => setTarget(s.id)}>
                {s.title}
              </Reply>
            ))
          : null}
      </>,
    ),
  );
  return (
    <>
      <Thread avatar={view.wizard.avatar} lines={lines} />
      {regenerate ? (
        <Dock>
          <Composer
            multiline
            inputRef={prompt}
            busy={run.busy}
            placeholder={
              made.length > 1 && !target ? t("run.feedbackPick") : t("run.feedbackPlaceholder")
            }
            disabled={!target}
            onSend={(text) => {
              const note = text.trim();
              if (!note || !target) {
                return false;
              }
              onNote(note);
              void run.regenerate(step.id, target, note);
              return true;
            }}
          />
        </Dock>
      ) : (
        <Idle />
      )}
    </>
  );
}

function ResultTurn({
  view,
  run,
  step,
  before,
  onRestart,
}: {
  view: RunView;
  run: Run;
  step: ResultStep;
  before: Line[];
  onRestart?: () => void;
}) {
  const made = view.shown.filter((x) => x.output);
  const base = `/api/runs/${view.id}`;
  const lines: Line[] = [
    ...before,
    bot(
      `result:${step.id}`,
      <>
        <span className="font-display font-semibold text-[1.0625rem]">{step.title}</span>
        {step.message ? <span className="mt-0.5 block text-ink-2">{step.message}</span> : null}
      </>,
      { anchor: true },
    ),
    ...made.map(({ step: s, output, formats, label }) =>
      bot(
        `result:${s.id}`,
        <>
          <SectionTitle
            end={
              <DownloadButtons
                base={base}
                stepId={s.id}
                formats={formats}
                title={label ?? s.title}
              />
            }
          >
            {label ?? s.title}
          </SectionTitle>
          <OutputView base={base} step={s} output={output} />
          {output?.assets?.some((a) => a.ai) ? (
            <p className="mt-3 text-[0.75rem] text-ink-3 leading-relaxed">{t("ai.publish")}</p>
          ) : null}
        </>,
        { wide: true },
      ),
    ),
    ...view.lists.map((list) =>
      bot(
        `result:list:${list.def.id}`,
        <>
          <SectionTitle end={<ListDownloads runId={view.id} list={list} />}>
            {list.label ?? list.def.title}
          </SectionTitle>
          <ListTable runId={view.id} list={list} editable />
        </>,
        { wide: true },
      ),
    ),
  ];
  lines.push(
    replies(
      "result:replies",
      <>
        {made.length ? (
          <ShareResultButton
            runId={view.id}
            title={`${step.title} · ${view.wizard.title}`}
            initial={view.shareUrl ? { url: view.shareUrl, expiresAt: view.expiresAt } : null}
          />
        ) : null}
        {onRestart ? (
          <Reply onClick={onRestart}>
            <RotateCcw className="size-4" /> {t("run.again")}
          </Reply>
        ) : null}
        {view.canBack ? (
          <Reply onClick={() => void run.back()} disabled={run.busy}>
            {t("run.back")}
          </Reply>
        ) : null}
        {view.keeps ? (
          <span className="ml-1">
            <StoreButton runId={view.id} />
          </span>
        ) : null}
      </>,
    ),
  );
  return <Thread avatar={view.wizard.avatar} lines={lines} />;
}

/**
 * A run as a chat. `header` and `footer` frame it: the wizard's own page names the wizard
 * above, the studio's drawer has its own bar.
 */
export function ChatBody({
  runId,
  onRestart,
  onView,
  header,
  footer,
  talk = false,
  call = false,
}: {
  runId: string;
  onRestart?: () => void;
  onView?: (view: RunView | null) => void;
  header?: ReactNode;
  footer?: ReactNode;
  /** The live conversation leads: its button is the first thing offered. */
  talk?: boolean;
  /** A call: the stage with the engenty (and the camera, as a video call), the chat as the screen beside it. */
  call?: false | "audio" | "video";
}) {
  const run = useRun(runId);
  const { view } = run;
  const [page, bindPage] = useState<PageBinding | null>(null);
  const voice = useLiveVoice(runId, view, run, page);
  useEffect(() => {
    onView?.(view);
  }, [view, onView]);
  const [readAloud, setReadAloud] = useReadAloud();
  const speech = useMemo(
    () => ({
      runId,
      lang: view?.lang ?? lang,
      readAloud,
      setReadAloud,
      voice: view?.talk ? voice : null,
      talk,
      call: Boolean(call),
      bindPage,
    }),
    [runId, view?.lang, view?.talk, readAloud, setReadAloud, voice, talk, call],
  );
  useWakeLock(view?.status === "running" && !view.ask);
  useDoneSignal(view);
  // What the person asked reviews to change, by review: the runtime keeps only the latest.
  const [asked, setAsked] = useState<Record<string, string[]>>({});
  // The one the step works on right now.
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    if (view && view.status !== "running") {
      setNote(null);
    }
  }, [view]);

  let body: ReactNode;
  if (run.notFound) {
    body = <div className="py-24 text-center text-ink-3">{t("run.notFound")}</div>;
  } else if (!view) {
    body = (
      <div className="flex justify-center py-24 text-ink-4">
        <Spinner />
      </div>
    );
  } else {
    const step = view.step;
    const waiting = view.status === "waiting_input";
    const before = historyLines(
      view,
      view.canBack && waiting && !run.busy ? () => void run.back() : undefined,
    );
    if (view.status === "running" && view.ask) {
      body = (
        <>
          <Thread
            avatar={view.wizard.avatar}
            lines={[
              ...before,
              bot(`ask:${view.ask.id}`, <AskPanel runId={view.id} ask={view.ask} />, {
                wide: true,
              }),
            ]}
          />
          <Idle />
        </>
      );
    } else if (view.status === "running") {
      body = (
        <>
          <Thread
            avatar={view.wizard.avatar}
            lines={[
              ...before,
              ...(note ? [me("note", note)] : []),
              // A step at work in the browser gets the thread's width for its picture.
              bot(`working:${step?.id}`, <Working view={view} />, {
                wide: view.events.some((ev) => ev.stepId === step?.id && isBrowserEvent(ev))
                  ? "most"
                  : undefined,
              }),
            ]}
          />
          <Idle placeholder={t("run.working")} />
        </>
      );
    } else if (view.status === "failed") {
      body = (
        <>
          <Thread
            avatar={view.wizard.avatar}
            lines={[
              ...before,
              bot(
                "failed",
                <>
                  <span className="font-medium">{t("run.failed")}</span>
                  {view.error ? (
                    <span className="mt-0.5 block">
                      <LinkedText text={view.error} />
                    </span>
                  ) : null}
                </>,
                { tone: "error" },
              ),
              replies(
                "failed:replies",
                <>
                  <Reply primary busy={run.busy} onClick={() => void run.retry()}>
                    <RotateCcw className="size-4" /> {t("run.retry")}
                  </Reply>
                  {view.canBack ? (
                    <Reply onClick={() => void run.back()} disabled={run.busy}>
                      {t("run.back")}
                    </Reply>
                  ) : null}
                </>,
              ),
            ]}
          />
          <Idle />
        </>
      );
    } else if (view.status === "cancelled") {
      body = (
        <Thread
          avatar={view.wizard.avatar}
          lines={[
            ...before,
            bot("cancelled", t("run.cancelled")),
            ...(onRestart
              ? [
                  replies(
                    "cancelled:replies",
                    <Reply primary onClick={onRestart}>
                      <RotateCcw className="size-4" /> {t("run.again")}
                    </Reply>,
                  ),
                ]
              : []),
          ]}
        />
      );
    } else if (step?.type === "page") {
      body = <PageTurn key={step.id} view={view} run={run} step={step} before={before} />;
    } else if (step?.type === "review") {
      const version = view.shown.map((x) => x.output?.at ?? "").join("|");
      body = (
        <ReviewTurn
          key={`${step.id}:${version}`}
          view={view}
          run={run}
          step={step}
          before={before}
          asked={asked[step.id] ?? []}
          onNote={(text) => {
            setNote(text);
            setAsked((all) => ({ ...all, [step.id]: [...(all[step.id] ?? []), text] }));
          }}
        />
      );
    } else if (step?.type === "result") {
      body = <ResultTurn view={view} run={run} step={step} before={before} onRestart={onRestart} />;
    } else {
      body = <Thread avatar={view.wizard.avatar} lines={before} />;
    }
  }
  if (call) {
    // The stage above on a phone, on the left on a desk; the chat is the screen beside it.
    return (
      <SpeechContext.Provider value={speech}>
        <div className="flex h-full min-h-0 flex-col lg:flex-row">
          <CallStage
            voice={voice}
            view={view}
            video={call === "video"}
            className="h-[46dvh] shrink-0 lg:h-auto lg:min-h-0 lg:flex-1"
          />
          <aside className="flex min-h-0 flex-1 flex-col border-border-soft border-t lg:w-[420px] lg:flex-none lg:border-t-0 lg:border-l">
            <ChatShell footer={footer}>{body}</ChatShell>
          </aside>
        </div>
      </SpeechContext.Provider>
    );
  }
  return (
    <SpeechContext.Provider value={speech}>
      <ChatShell header={header} footer={footer}>
        {body}
      </ChatShell>
    </SpeechContext.Provider>
  );
}
