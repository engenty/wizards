import {
  ArrowUp,
  AudioLines,
  Check,
  ChevronDown,
  ChevronRight,
  Mic,
  Paperclip,
  Plus,
  Square,
} from "lucide-react";
import { type ReactNode, type Ref, useEffect, useImperativeHandle, useRef, useState } from "react";
import { t } from "../lib/i18n";
import { useDictation, useDictationSettings, useMicrophones } from "../lib/speech";
import { FilePreview, FileTile, type PreviewFile } from "./file-preview";
import { cn, IconButton, Spinner, Switch } from "./index";

/** A clipboard picture is always "image.png"; give each its own name so two pastes both stay. */
export function pastedName(file: File, index: number): File {
  if (file.name && file.name !== "image.png") {
    return file;
  }
  const ext = file.type.split("/")[1]?.replace("jpeg", "jpg") || "png";
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
  return new File([file], `paste-${stamp}${index ? `-${index + 1}` : ""}.${ext}`, {
    type: file.type,
  });
}

/**
 * The file under a name a wizard's workspace takes (letters, digits, - _ .): umlauts spelled out,
 * everything else a dash. "Tipps des Hauses.pdf" becomes "Tipps-des-Hauses.pdf".
 */
export function workspaceFile(file: File): File {
  const ascii = (part: string) =>
    part
      .replace(/ä/g, "ae")
      .replace(/ö/g, "oe")
      .replace(/ü/g, "ue")
      .replace(/Ä/g, "Ae")
      .replace(/Ö/g, "Oe")
      .replace(/Ü/g, "Ue")
      .replace(/ß/g, "ss")
      .normalize("NFKD")
      .replace(/[^A-Za-z0-9_-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
  const dot = file.name.lastIndexOf(".");
  const stem = ascii(dot > 0 ? file.name.slice(0, dot) : file.name) || "file";
  const ext = dot > 0 ? ascii(file.name.slice(dot + 1)) : "";
  const name = ext ? `${stem}.${ext}` : stem;
  return name === file.name ? file : new File([file], name, { type: file.type });
}

export function Thumb({
  url,
  label,
  children,
}: {
  url: string;
  label: string;
  children?: ReactNode;
}) {
  return (
    <div className="group relative" title={label}>
      <img
        src={url}
        alt={label}
        width={64}
        height={64}
        className="size-16 rounded-lg bg-paper-2 object-cover ring-1 ring-border"
      />
      {children}
    </div>
  );
}

/** A file that is already somewhere (the space's files): it goes with a message by its id. */
export interface PickedFile {
  id: string;
  name: string;
  mime: string;
  /** Where it opens, to look at before it is sent. */
  url?: string;
}

/** One more entry in the plus menu: an action, a submenu of choices, or a box that is on or off. */
export type PlusItem =
  | { kind?: "action"; icon: ReactNode; label: string; onSelect: () => void }
  | {
      kind: "menu";
      icon: ReactNode;
      label: string;
      choices: PlusChoice[];
      /** What the submenu says while it has no choices. */
      empty?: string;
    }
  | {
      kind: "toggle";
      icon: ReactNode;
      label: string;
      on: boolean;
      onChange: (on: boolean) => void;
    };

/** One entry of a submenu: picked, which closes the menu, or on and off (`on` given). */
export interface PlusChoice {
  id: string;
  label: string;
  hint?: string;
  on?: boolean;
  onSelect: () => void;
}

/**
 * The model a chat answers with, as the composer chooses it: everyday work, or extra effort for
 * demanding work. `normal` and `extra` name the models, where the way lists them.
 */
export interface EffortChoice {
  on: boolean;
  onChange: (on: boolean) => void;
  normal?: string;
  extra?: string;
}

/** What a conversation around the composer can do with it: files dropped on it go in here. */
export interface ComposerHandle {
  add: (files: File[]) => void;
  /** Files picked from where they already are, e.g. the space's files. */
  pick: (files: PickedFile[]) => void;
  focus: () => void;
  /** Puts a draft into the field, e.g. a suggestion to finish before sending. */
  fill: (text: string) => void;
}

/** Taller than this the field scrolls. */
const MAX_HEIGHT = 200;

/** The keys that send a message for after the running answer: ⌘↩ on a Mac, Ctrl+↩ elsewhere. */
export const LATER_KEYS =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
    ? "⌘↩"
    : "Ctrl+↩";

/** The keys that open the file picker: ⌘U on a Mac, Ctrl+U elsewhere. */
const UPLOAD_KEYS = LATER_KEYS === "⌘↩" ? "⌘U" : "Ctrl+U";

/**
 * The field a message is written in: text (typed or spoken), files (picked, pasted or handed in
 * through `ref`), and the send button. One line, it is a pill; the buttons stay level with the
 * text, and on the last line once it grows. `floating` lifts it off the page for a composer that
 * stands at the lower edge of the window. With `onStop`, an answer under way (`busy`) does not
 * lock it: Enter sends on, ⌘↩ (Ctrl+↩) for after the answer, and an empty field offers Stop.
 * `tall`: the field starts at `lines` lines (four), with its buttons in a row below it.
 */
export function Composer({
  placeholder,
  disabled,
  busy,
  onStop,
  onSend,
  attach = true,
  floating,
  bare,
  autoFocus,
  className,
  onTalk,
  effort,
  model,
  chooser,
  buttons,
  plus,
  tall: big,
  lines = 4,
  ref,
}: {
  placeholder?: string;
  /** Typing goes on; sending waits, e.g. while the answer to the last message comes in. */
  disabled?: boolean;
  /** An answer is under way; with `onStop` sending goes on. */
  busy?: boolean;
  /** Stops the answer under way: its button stands where Send does while the field is empty. */
  onStop?: () => void;
  /**
   * False keeps the draft, e.g. when sending failed. `later`: sent with ⌘↩ (Ctrl+↩), for after
   * the answer under way. `picked`: files handed in through `ref.pick`.
   */
  onSend: (
    text: string,
    files: File[],
    later?: boolean,
    picked?: PickedFile[],
  ) => boolean | Promise<boolean>;
  attach?: boolean;
  floating?: boolean;
  /** Drawn inside a card of the caller's: no fill, ring, shadow or rounding of its own. */
  bare?: boolean;
  autoFocus?: boolean;
  className?: string;
  /** Starts a live chat: its button stands where Send does while the field is empty. */
  onTalk?: () => void;
  /** Extra effort: a box in the plus menu; on, the chat works with its more capable model. */
  effort?: ComposerEffort;
  /**
   * The model, in the plus menu: a list to pick from where the organization's policy lets people
   * pick, or one line where it names the model.
   */
  model?: ComposerModel;
  /** The same choice as a menu of its own in the row, with the models' names (Work's chats). */
  chooser?: EffortChoice;
  /** More buttons in the row, before the chooser and the mic: the developer mode's in Work. */
  buttons?: ReactNode;
  /** More entries for the plus menu, e.g. the space's files: one group each, with a line between. */
  plus?: PlusItem[][];
  tall?: boolean;
  /** With `tall`: the lines the field starts at. */
  lines?: number;
  ref?: Ref<ComposerHandle>;
}) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [picked, setPicked] = useState<PickedFile[]>([]);
  const [dropping, setDropping] = useState(false);
  const [tall, setTall] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [prefs] = useDictationSettings();
  const speech = useDictation(text, setText, { deviceId: prefs.deviceId });
  const add = (picked: File[]) =>
    setFiles((all) => [...all.filter((f) => !picked.some((p) => p.name === f.name)), ...picked]);
  useImperativeHandle(ref, () => ({
    add,
    pick: (more: PickedFile[]) =>
      setPicked((all) => [...all.filter((f) => !more.some((m) => m.id === f.id)), ...more]),
    focus: () => area.current?.focus(),
    fill: (draft: string) => {
      setText(draft);
      requestAnimationFrame(() => {
        const el = area.current;
        el?.focus();
        el?.setSelectionRange(draft.length, draft.length);
      });
    },
  }));

  // The height follows the text, typed or spoken, and the field's width. Empty, the field is one
  // line; a placeholder that wraps does not make it taller.
  useEffect(() => {
    const el = area.current;
    if (!el) {
      return;
    }
    const fit = () => {
      el.style.height = "auto";
      const one = Number.parseFloat(getComputedStyle(el).minHeight) || 0;
      el.style.height = text ? `${Math.min(el.scrollHeight, MAX_HEIGHT)}px` : "";
      setTall(Boolean(text) && el.scrollHeight > one + 1);
    };
    fit();
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      // Only a new width: the height this sets would call it again.
      if (el.clientWidth !== width) {
        width = el.clientWidth;
        fit();
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [text]);

  // Each attached file opens from a URL of its own until it is sent.
  const [urls, setUrls] = useState<Map<File, string>>(new Map());
  const [previewAt, setPreviewAt] = useState<number | null>(null);
  useEffect(() => {
    const next = new Map(files.map((f) => [f, URL.createObjectURL(f)]));
    setUrls(next);
    return () => {
      for (const url of next.values()) {
        URL.revokeObjectURL(url);
      }
    };
  }, [files]);

  const typed = Boolean(text.trim() || files.length > 0 || picked.length > 0);
  const ready = typed && !disabled;
  const submit = async (later = false) => {
    if (!ready) {
      return;
    }
    if (speech.listening) {
      speech.stop();
    }
    const draft = { text, files, picked };
    setText("");
    setFiles([]);
    setPicked([]);
    if (!(await onSend(draft.text.trim(), draft.files, later, draft.picked))) {
      setText(draft.text);
      setFiles(draft.files);
      setPicked(draft.picked);
    }
  };
  const detach = (i: number) => setFiles((all) => all.filter((_, j) => j !== i));
  const attachOpener = () => picker.current?.click();
  const plusButton = attach ? (
    <>
      {effort || model || plus?.some((group) => group.length) ? (
        <PlusMenu
          effort={effort}
          model={model}
          items={plus}
          onAttach={attachOpener}
          outlined={big}
        />
      ) : big ? (
        <button
          type="button"
          aria-label={t("editor.attach")}
          title={t("editor.attach")}
          onClick={attachOpener}
          className={OUTLINED}
        >
          <Plus className="size-4" />
        </button>
      ) : (
        <IconButton label={t("editor.attach")} onClick={attachOpener}>
          <Plus className="size-4" />
        </IconButton>
      )}
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const chosen = Array.from(e.target.files ?? []);
          e.target.value = "";
          add(chosen);
        }}
      />
    </>
  ) : null;
  const size = big ? "size-10" : "size-9";
  const action =
    busy && onStop && !typed ? (
      <button
        type="button"
        onClick={onStop}
        className={cn(
          size,
          "inline-flex shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition coarse:size-11",
        )}
        aria-label={t("composer.stop")}
        title={t("composer.stop")}
      >
        <Square className="size-3 fill-current" />
      </button>
    ) : onTalk && !(typed || speech.listening) ? (
      <button
        type="button"
        onClick={onTalk}
        disabled={disabled}
        className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-primary px-3.5 font-medium text-[0.8125rem] text-primary-foreground transition disabled:opacity-50 coarse:h-11"
        aria-label={t("assistant.talk")}
      >
        <AudioLines className="size-4" /> {t("assistant.talk")}
      </button>
    ) : (
      <button
        type="button"
        onClick={() => void submit()}
        disabled={!ready}
        className={cn(
          size,
          "inline-flex shrink-0 items-center justify-center rounded-full transition coarse:size-11",
          ready ? "bg-primary text-primary-foreground" : "bg-paper-2 text-ink-4",
        )}
        aria-label={t("composer.send")}
        title={busy && onStop ? t("composer.sendBusy", { keys: LATER_KEYS }) : undefined}
      >
        <ArrowUp className="size-4" />
      </button>
    );

  const shown: PreviewFile[] = [
    ...files.map((f) => ({ name: f.name, mime: f.type, size: f.size, url: urls.get(f) })),
    ...picked.map((f) => ({ name: f.name, mime: f.mime, url: f.url })),
  ];
  const field = (
    <textarea
      ref={area}
      rows={big ? lines : 1}
      value={text}
      autoFocus={autoFocus}
      onChange={(e) => setText(e.target.value)}
      onPaste={(e) => {
        const pasted = Array.from(e.clipboardData.files);
        if (attach && pasted.length) {
          e.preventDefault();
          add(pasted.map(pastedName));
        }
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault();
          void submit(e.metaKey || e.ctrlKey);
        }
      }}
      placeholder={
        dropping ? t("new.dropHint") : speech.listening ? t("editor.listening") : placeholder
      }
      // Tall, the field is `lines` lines of 1.5rem at least.
      style={big ? { minHeight: `${lines * 1.5}rem` } : undefined}
      className={cn(
        "max-h-[200px] resize-none bg-transparent outline-none placeholder:text-ink-4",
        big
          ? "w-full px-3 pt-2.5 pb-1 text-[1rem] leading-6"
          : "min-h-9 flex-1 py-2 text-[0.875rem] leading-5 placeholder:truncate coarse:min-h-11 coarse:py-3",
        !big && (attach ? "px-1" : "px-3"),
      )}
    />
  );

  return (
    <div className={className}>
      {/* Files dropped on the field are attached, as picked or pasted ones are. */}
      <div
        {...(attach
          ? {
              onDragOver: (e: React.DragEvent) => {
                if (e.dataTransfer.types.includes("Files")) {
                  e.preventDefault();
                  setDropping(true);
                }
              },
              onDragLeave: (e: React.DragEvent) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                  setDropping(false);
                }
              },
              onDrop: (e: React.DragEvent) => {
                setDropping(false);
                if (e.dataTransfer.files.length) {
                  e.preventDefault();
                  e.stopPropagation();
                  add(Array.from(e.dataTransfer.files).map(pastedName));
                }
              },
            }
          : {})}
        // ⌘U (Ctrl+U) picks files, wherever the focus is in the composer.
        onKeyDown={(e) => {
          if (
            attach &&
            (e.metaKey || e.ctrlKey) &&
            !(e.shiftKey || e.altKey) &&
            e.key.toLowerCase() === "u"
          ) {
            e.preventDefault();
            attachOpener();
          }
        }}
        className={cn(
          bare ? "px-2 py-3" : big ? "p-2" : "p-1",
          !bare && "bg-card ring-1 ring-border focus-within:ring-focus",
          dropping && "ring-2 ring-focus",
          !bare &&
            (big
              ? "rounded-2xl"
              : tall || files.length || picked.length
                ? "rounded-[1.375rem]"
                : "rounded-full"),
          !bare && (floating ? "shadow-overlay" : big ? "shadow-elevated" : "shadow-soft"),
        )}
      >
        {shown.length ? (
          <ul className="flex flex-wrap gap-2 px-2 pt-2 pb-1">
            {shown.map((f, i) => (
              <FileTile
                key={i < files.length ? `${f.name}-${i}` : picked[i - files.length]?.id}
                file={f}
                onOpen={() => setPreviewAt(i)}
                onRemove={() =>
                  i < files.length
                    ? detach(i)
                    : setPicked((all) => all.filter((_, j) => j !== i - files.length))
                }
              />
            ))}
          </ul>
        ) : null}
        {big ? (
          <>
            {field}
            <div className="flex items-center gap-1 px-1 pb-1">
              {plusButton}
              <span className="flex-1" />
              {buttons}
              {chooser ? <EffortMenu choice={chooser} /> : null}
              {speech.supported ? <DictationButton speech={speech} /> : null}
              {action}
            </div>
          </>
        ) : (
          // The field is as high as a button on one line, so text and buttons share a middle.
          <div className="flex items-end gap-0.5">
            {plusButton}
            {field}
            {buttons}
            {chooser ? <EffortMenu choice={chooser} /> : null}
            {speech.supported ? <DictationButton speech={speech} /> : null}
            {action}
          </div>
        )}
      </div>
      <FilePreview files={shown} at={previewAt} onAt={setPreviewAt} />
      {speech.error ? (
        <p className="mt-2 px-3 text-[0.75rem] text-rose">
          {speech.error === "denied" ? t("editor.micDenied") : speech.error}
        </p>
      ) : null}
    </div>
  );
}

/** The outlined round button of the tall composer, as on the new-wizard page. */
const OUTLINED =
  "inline-flex size-10 shrink-0 items-center justify-center rounded-full border border-border text-ink transition hover:bg-paper-2 coarse:size-11";

export type Speech = ReturnType<typeof useDictation>;

export interface ComposerEffort {
  on: boolean;
  onChange: (on: boolean) => void;
  /** The organization's policy allows no extra effort here; `hint` says up to what it does. */
  disabled?: boolean;
  hint?: string;
}

export interface ComposerModel {
  items: { id: string; label: string; note: string }[];
  value: string;
  onChange: (id: string) => void;
}

/** The model group of the plus menu: the purpose's list. */
function ModelGroup({ model }: { model: ComposerModel }) {
  return (
    <>
      <p className="px-3 pt-1.5 pb-0.5 font-medium text-[0.6875rem] text-ink-3 uppercase tracking-wide">
        {t("composer.model")}
      </p>
      {model.items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitemradio"
          aria-checked={item.id === model.value}
          onClick={() => model.onChange(item.id)}
          className={cn(
            "flex w-full items-baseline gap-2 rounded-lg px-3 py-2 text-left text-[0.875rem] hover:bg-paper-2",
            item.id === model.value && "bg-ember-tint",
          )}
        >
          <span className="flex-1">{item.label}</span>
          <span className="text-[0.75rem] text-ink-3">{item.note}</span>
          {item.id === model.value ? <Check className="size-3.5 text-ember-strong" /> : null}
        </button>
      ))}
    </>
  );
}

/**
 * The plus button with its menu: upload files (⌘U), the caller's groups of entries, and the box
 * for extra effort. An entry with choices opens them beside the menu. The menu stands fixed to
 * the window above the button, so a card around the composer does not cut it.
 */
function PlusMenu({
  effort,
  model,
  items,
  onAttach,
  outlined,
}: {
  effort?: ComposerEffort;
  model?: ComposerModel;
  items?: PlusItem[][];
  onAttach: () => void;
  outlined?: boolean;
}) {
  const [at, setAt] = useState<{ bottom: number; left: number } | null>(null);
  /** The open submenu: its entry's label and where it stands. */
  const [sub, setSub] = useState<{ label: string; top: number; left: number } | null>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const subPanel = useRef<HTMLDivElement>(null);
  const close = () => {
    setAt(null);
    setSub(null);
  };
  useEffect(() => {
    if (!at) {
      return;
    }
    const away = (e: PointerEvent) => {
      const target = e.target as Node;
      if (
        !(
          panel.current?.contains(target) ||
          subPanel.current?.contains(target) ||
          opener.current?.contains(target)
        )
      ) {
        setAt(null);
        setSub(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setAt(null);
        setSub(null);
        opener.current?.focus();
      }
    };
    const shut = () => {
      setAt(null);
      setSub(null);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", shut);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", shut);
    };
  }, [at]);
  const toggle = () => {
    const rect = opener.current?.getBoundingClientRect();
    if (at || !rect) {
      close();
      return;
    }
    setAt({ bottom: window.innerHeight - rect.top + 8, left: rect.left });
  };
  // Beside the menu where the window has room, else over it on the left.
  const openSub = (label: string, row: HTMLElement) => {
    const menu = panel.current?.getBoundingClientRect();
    const rect = row.getBoundingClientRect();
    if (!menu) {
      return;
    }
    const left =
      menu.right + 4 + SUB_WIDTH <= window.innerWidth - 16
        ? menu.right + 4
        : Math.max(16, menu.left - 4 - SUB_WIDTH);
    setSub({ label, top: rect.top - 6, left });
  };
  const row =
    "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[0.875rem] hover:bg-paper-2 [&>svg:first-child]:size-4 [&>svg:first-child]:text-ink-3";
  const open = items?.flat().find((i) => i.kind === "menu" && i.label === sub?.label);
  return (
    <>
      <button
        ref={opener}
        type="button"
        aria-label={t("composer.more")}
        title={t("composer.more")}
        aria-haspopup="menu"
        aria-expanded={Boolean(at)}
        onClick={toggle}
        className={
          outlined
            ? OUTLINED
            : "inline-flex size-9 shrink-0 items-center justify-center rounded-full text-ink-3 transition hover:bg-accent hover:text-ink coarse:size-11"
        }
      >
        <Plus className="size-4" />
      </button>
      {at ? (
        <div
          ref={panel}
          role="menu"
          style={{ bottom: at.bottom, left: at.left }}
          className="fixed z-50 w-72 max-w-[calc(100vw-2rem)] rounded-xl bg-card p-1 shadow-overlay ring-1 ring-border"
        >
          <button
            type="button"
            role="menuitem"
            onPointerEnter={() => setSub(null)}
            onClick={() => {
              close();
              onAttach();
            }}
            className={row}
          >
            <Paperclip />
            <span className="flex-1">{t("composer.upload")}</span>
            <kbd className="font-sans text-[0.75rem] text-ink-4">{UPLOAD_KEYS}</kbd>
          </button>
          {items?.map((group, g) =>
            group.length ? (
              <div key={group.map((i) => i.label).join("|")}>
                {g > 0 ? <div className="mx-2 my-1 border-border-soft border-t" /> : null}
                {group.map((item) =>
                  item.kind === "menu" ? (
                    <button
                      key={item.label}
                      type="button"
                      role="menuitem"
                      aria-haspopup="menu"
                      aria-expanded={sub?.label === item.label}
                      onPointerEnter={(e) => openSub(item.label, e.currentTarget)}
                      onClick={(e) =>
                        sub?.label === item.label
                          ? setSub(null)
                          : openSub(item.label, e.currentTarget)
                      }
                      className={cn(row, sub?.label === item.label && "bg-paper-2")}
                    >
                      {item.icon}
                      <span className="flex-1">{item.label}</span>
                      <ChevronRight className="size-4 text-ink-4" />
                    </button>
                  ) : item.kind === "toggle" ? (
                    <button
                      key={item.label}
                      type="button"
                      role="menuitemcheckbox"
                      aria-checked={item.on}
                      onPointerEnter={() => setSub(null)}
                      onClick={() => item.onChange(!item.on)}
                      className={row}
                    >
                      {item.icon}
                      <span className="flex-1">{item.label}</span>
                      {item.on ? <Check className="size-4 text-ember-strong" /> : null}
                    </button>
                  ) : (
                    <button
                      key={item.label}
                      type="button"
                      role="menuitem"
                      onPointerEnter={() => setSub(null)}
                      onClick={() => {
                        close();
                        item.onSelect();
                      }}
                      className={row}
                    >
                      {item.icon}
                      {item.label}
                    </button>
                  ),
                )}
              </div>
            ) : null,
          )}
          {model ? (
            <>
              <div className="mx-2 my-1 border-border-soft border-t" />
              <ModelGroup model={model} />
            </>
          ) : null}
          {effort ? <EffortBox effort={effort} /> : null}
        </div>
      ) : null}
      {at && sub && open?.kind === "menu" ? (
        <div
          ref={subPanel}
          role="menu"
          aria-label={open.label}
          style={{
            top: sub.top,
            left: sub.left,
            width: SUB_WIDTH,
            maxHeight: `calc(100vh - ${sub.top + 16}px)`,
          }}
          className="fixed z-50 overflow-y-auto rounded-xl bg-card p-1 shadow-overlay ring-1 ring-border"
        >
          {open.choices.length ? (
            open.choices.map((c) => (
              <button
                key={c.id}
                type="button"
                {...(c.on === undefined
                  ? { role: "menuitem" }
                  : { role: "menuitemcheckbox", "aria-checked": c.on })}
                onClick={() => {
                  if (c.on === undefined) {
                    close();
                  }
                  c.onSelect();
                }}
                className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left hover:bg-paper-2"
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[0.875rem]">{c.label}</span>
                  {c.hint ? (
                    <span className="truncate text-[0.75rem] text-ink-3">{c.hint}</span>
                  ) : null}
                </span>
                {c.on ? <Check className="size-4 shrink-0 text-ember-strong" /> : null}
              </button>
            ))
          ) : (
            <p className="px-3 py-2 text-[0.8125rem] text-ink-3">{open.empty}</p>
          )}
        </div>
      ) : null}
    </>
  );
}

/** How wide a submenu of the plus menu is, in px. */
const SUB_WIDTH = 256;

/** Extra effort, in the plus menu: on, the chat works with its more capable model. */
function EffortBox({ effort }: { effort: ComposerEffort }) {
  const on = effort.on && !effort.disabled;
  return (
    <>
      <div className="mx-2 my-1 border-border-soft border-t" />
      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={on}
        disabled={effort.disabled}
        onClick={() => effort.onChange(!effort.on)}
        className="flex w-full items-start gap-2.5 rounded-lg px-3 py-2 text-left hover:bg-paper-2 disabled:cursor-default disabled:hover:bg-transparent"
      >
        <span
          className={cn(
            "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border",
            on ? "border-primary bg-primary text-primary-foreground" : "border-input",
          )}
        >
          {on ? <Check className="size-3" strokeWidth={3} /> : null}
        </span>
        <span className="flex flex-col">
          <span className={cn("text-[0.875rem]", effort.disabled && "text-ink-3")}>
            {t("composer.extra")}
          </span>
          <span className="text-[0.75rem] text-ink-3">
            {effort.hint ?? t("composer.extraHint")}
          </span>
        </span>
      </button>
    </>
  );
}

/**
 * Everyday work or extra effort, as a menu in the composer's row: the button names the model the
 * next message goes to. The menu stands fixed to the window, at the button's right edge.
 */
function EffortMenu({ choice }: { choice: EffortChoice }) {
  const [at, setAt] = useState<{ bottom: number; right: number } | null>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!at) {
      return;
    }
    const away = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!(panel.current?.contains(target) || opener.current?.contains(target))) {
        setAt(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setAt(null);
        opener.current?.focus();
      }
    };
    const close = () => setAt(null);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
    };
  }, [at]);
  const toggle = () => {
    const rect = opener.current?.getBoundingClientRect();
    if (at || !rect) {
      setAt(null);
      return;
    }
    setAt({ bottom: window.innerHeight - rect.top + 8, right: window.innerWidth - rect.right });
  };
  const options = [
    {
      on: false,
      title: t("composer.everyday"),
      model: choice.normal,
      hint: t("composer.everydayHint"),
    },
    { on: true, title: t("composer.extra"), model: choice.extra, hint: t("composer.extraHint") },
  ];
  const current = options.find((o) => o.on === choice.on) ?? options[0];
  return (
    <>
      <button
        ref={opener}
        type="button"
        title={t("composer.effort")}
        aria-haspopup="menu"
        aria-expanded={Boolean(at)}
        onClick={toggle}
        className={cn(
          "inline-flex h-9 shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2.5 text-[0.8125rem] transition hover:bg-accent hover:text-ink coarse:h-11",
          at ? "bg-accent text-ink" : "text-ink-3",
        )}
      >
        {current.model ?? current.title}
        <ChevronDown className={cn("size-3.5 transition-transform", at && "rotate-180")} />
      </button>
      {at ? (
        <div
          ref={panel}
          role="menu"
          aria-label={t("composer.effort")}
          style={{ bottom: at.bottom, right: Math.max(16, at.right - 8) }}
          className="fixed z-50 w-72 max-w-[calc(100vw-2rem)] animate-rise rounded-xl bg-card p-1.5 shadow-overlay ring-1 ring-border-soft"
        >
          {options.map((o) => (
            <button
              key={o.title}
              type="button"
              role="menuitemradio"
              aria-checked={o.on === choice.on}
              onClick={() => {
                choice.onChange(o.on);
                setAt(null);
              }}
              className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-paper-2"
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-baseline gap-2 text-[0.875rem]">
                  {o.title}
                  {o.model ? <span className="text-[0.75rem] text-ink-3">{o.model}</span> : null}
                </span>
                <span className="text-[0.75rem] text-ink-3">{o.hint}</span>
              </span>
              {o.on === choice.on ? (
                <Check className="mt-0.5 size-4 shrink-0 text-ember-strong" />
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}

/**
 * The mic button and, beside it, its menu: which microphone, and whether the button records while
 * it is held (push to talk) or on and off with a click. `labelled`: an outlined button that says
 * what it does, where the row has the room (the new-wizard page); in a narrow row that is an
 * `@container` it keeps only the icon.
 */
export function DictationButton({ speech, labelled }: { speech: Speech; labelled?: boolean }) {
  const [prefs, setPrefs] = useDictationSettings();
  const mics = useMicrophones();
  const [menu, setMenu] = useState<{ bottom: number; left?: number; right?: number } | null>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const group = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) {
      return;
    }
    void mics.refresh();
    const away = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!(panel.current?.contains(target) || opener.current?.contains(target))) {
        setMenu(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenu(null);
        opener.current?.focus();
      }
    };
    const close = () => setMenu(null);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
    };
  }, [menu, mics.refresh]);
  const open = () => {
    const rect = opener.current?.getBoundingClientRect();
    const start = group.current?.getBoundingClientRect();
    if (rect && start) {
      // Fixed to the window: a card around the composer that clips its content does not cut it.
      // The labelled button stands at the start of its row, so its menu opens to the right.
      const bottom = window.innerHeight - rect.top + 8;
      setMenu(
        labelled ? { bottom, left: start.left } : { bottom, right: window.innerWidth - rect.right },
      );
    }
  };

  const label = speech.processing
    ? t("editor.transcribing")
    : speech.listening
      ? t("editor.voiceStop")
      : prefs.hold
        ? t("dictation.holdToTalk")
        : t("editor.voice");
  // Held: down starts, up (wherever the pointer is then) stops; Space or Enter the same way.
  const hold = prefs.hold
    ? {
        onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => {
          if (e.button !== 0) {
            return;
          }
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          speech.start();
        },
        onPointerUp: () => speech.stop(),
        onPointerCancel: () => speech.stop(),
        onKeyDown: (e: React.KeyboardEvent) => {
          if ((e.key === " " || e.key === "Enter") && !e.repeat) {
            e.preventDefault();
            speech.start();
          }
        },
        onKeyUp: (e: React.KeyboardEvent) => {
          if (e.key === " " || e.key === "Enter") {
            speech.stop();
          }
        },
      }
    : { onClick: speech.toggle };
  const choices = [
    { deviceId: "", label: t("dictation.default") },
    ...mics.devices.map((d, i) => ({
      deviceId: d.deviceId,
      label: d.label || t("dictation.mic", { n: i + 1 }),
    })),
  ];
  // A chosen microphone that is gone falls back to the default one.
  const chosen = choices.some((c) => c.deviceId === prefs.deviceId) ? prefs.deviceId : "";

  const icon = speech.processing ? (
    <Spinner className="size-4" />
  ) : speech.listening ? (
    <Square className="size-3.5 animate-pulse-dot fill-current" />
  ) : (
    <Mic className="size-4" />
  );

  return (
    <div ref={group} className="flex shrink-0 items-center">
      {labelled ? (
        <button
          type="button"
          title={label}
          aria-pressed={speech.listening}
          disabled={speech.processing}
          {...hold}
          className={cn(
            "inline-flex h-10 touch-none select-none items-center justify-center gap-2 whitespace-nowrap rounded-full border px-4 font-medium text-sm transition disabled:opacity-60 @max-sm:w-10 @max-sm:px-0 coarse:h-11 @max-sm:coarse:w-11",
            speech.listening
              ? "border-rose/40 bg-rose-tint text-rose"
              : "border-border text-ink hover:bg-paper-2",
          )}
        >
          {icon}
          <span className="@max-sm:sr-only">
            {speech.processing
              ? t("dictation.writing")
              : speech.listening
                ? t("dictation.stop")
                : t("dictation.speak")}
          </span>
        </button>
      ) : (
        <IconButton
          label={label}
          aria-pressed={speech.listening}
          disabled={speech.processing}
          {...hold}
          className={cn(
            "touch-none",
            speech.listening && "bg-rose-tint text-rose hover:bg-rose-tint hover:text-rose",
          )}
        >
          {icon}
        </IconButton>
      )}
      <button
        ref={opener}
        type="button"
        aria-label={t("dictation.settings")}
        title={t("dictation.settings")}
        aria-haspopup="menu"
        aria-expanded={Boolean(menu)}
        onClick={() => (menu ? setMenu(null) : open())}
        className={cn(
          "inline-flex h-9 w-5 shrink-0 items-center justify-center rounded-full text-ink-4 transition hover:text-ink coarse:h-11",
          labelled ? "ml-0.5" : "-ml-1.5",
          menu && "text-ink",
        )}
      >
        <ChevronDown className={cn("size-3.5 transition-transform", menu && "rotate-180")} />
      </button>
      {menu ? (
        <div
          ref={panel}
          role="menu"
          aria-label={t("dictation.settings")}
          className="fixed z-50 w-72 max-w-[calc(100vw-2rem)] animate-rise rounded-xl bg-card p-1.5 text-[0.875rem] shadow-overlay ring-1 ring-border-soft"
          style={
            menu.left === undefined
              ? { bottom: menu.bottom, right: Math.max(16, (menu.right ?? 0) - 8) }
              : { bottom: menu.bottom, left: Math.max(16, menu.left) }
          }
        >
          <p className="px-2.5 pt-1.5 pb-1 text-[0.75rem] text-ink-3">
            {t("dictation.microphone")}
          </p>
          {choices.map((c) => (
            <button
              key={c.deviceId || "default"}
              type="button"
              role="menuitemradio"
              aria-checked={c.deviceId === chosen}
              onClick={() => {
                setPrefs({ deviceId: c.deviceId });
                setMenu(null);
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-paper-2"
            >
              <span className="min-w-0 flex-1 truncate">{c.label}</span>
              {c.deviceId === chosen ? (
                <Check className="size-4 shrink-0 text-ember-strong" />
              ) : null}
            </button>
          ))}
          {mics.named ? null : (
            <button
              type="button"
              role="menuitem"
              onClick={() => void mics.allow()}
              className="flex w-full rounded-lg px-2.5 py-2 text-left text-ink-3 hover:bg-paper-2 hover:text-ink"
            >
              {t("dictation.showMics")}
            </button>
          )}
          <div className="my-1.5 h-px bg-border-soft" />
          <div className="flex items-center justify-between gap-3 px-2.5 py-1.5">
            <span>{t("dictation.hold")}</span>
            <Switch
              checked={prefs.hold}
              label={t("dictation.hold")}
              onChange={(next) => setPrefs({ hold: next })}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
