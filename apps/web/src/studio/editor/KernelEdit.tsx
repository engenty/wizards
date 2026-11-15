import {
  isOutlineCode,
  type OutlineCode,
  type OutlineEdit,
  type OutlineText,
} from "@engenty/wizards-shared/kernel-file";
import { Pencil, Sparkles } from "lucide-react";
import {
  createContext,
  type KeyboardEvent,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { t } from "../../lib/i18n";
import { cn } from "../../ui";

/** What a step's panel can change: the texts of one ask, and a note to the assistant. */
export interface KernelEditing {
  /** The file the panel reads, as the note names it. */
  path: string;
  /** Where a text of the ask stands in the file, by its path; nothing where it cannot be typed over. */
  at: Record<string, [number, number]>;
  /** Writes a text typed over into the file. */
  save: (at: [number, number], value: OutlineEdit) => void;
  /** Sends what a person wants changed about one element to the assistant. */
  note?: (about: string, text: string) => void;
}

export const KernelEditContext = createContext<KernelEditing | null>(null);

/**
 * The short texts a person types over where they stand. An Auftrag is not among them: it is
 * changed with the assistant or in the code, like every other value.
 */
const WORDS = /(^|\.)(title|description|working|label|placeholder)$/;
const OPTION = /^fields\.\d+\.options\.\d+$/;

/** Something the code fills in or works out: set apart from the words a person wrote. */
export const CODE =
  "box-decoration-clone rounded-md bg-cobalt-tint px-1.5 py-0.5 font-mono text-[0.75rem] text-cobalt [overflow-wrap:anywhere]";

type Parts = (string | OutlineCode)[];

/** A written-out value as a chip shows it: a text in quotes on one line, nothing as a dash. */
const said = (value: string | number | boolean) =>
  typeof value !== "string"
    ? String(value)
    : value.trim()
      ? `„${value.trim().replace(/\s*\n\s*/g, " ")}“`
      : "–";

/** A part of the chip in the page's own type: the words a person reads, apart from the code. */
function words(text: string) {
  const span = document.createElement("span");
  span.className = "font-sans text-[0.8125rem] text-ink";
  span.textContent = text;
  return span;
}

const partsOf = (value: string | OutlineText): Parts =>
  typeof value === "string" ? [value] : value.$text;

/** What stands in the element now: its words, and the code chips between them. */
function read(node: Node, out: Parts = []): Parts {
  for (const child of node.childNodes) {
    const code = child instanceof HTMLElement ? child.dataset.code : undefined;
    const add =
      code !== undefined
        ? { $code: code }
        : child.nodeType === Node.TEXT_NODE
          ? (child.textContent ?? "")
          : child.nodeName === "BR"
            ? "\n"
            : null;
    if (add === null) {
      read(child, out);
    } else if (typeof add === "string" && typeof out.at(-1) === "string") {
      out[out.length - 1] += add;
    } else if (add !== "") {
      out.push(add);
    }
  }
  return out;
}

/**
 * A text of a step, typed over where it stands: a click puts the cursor in, the ground turns to
 * an input's, and leaving it writes the text into the step's file. The code between its words
 * stays as chips. Where the text has no place in the file, it is only shown.
 */
export function Words({
  path,
  value,
  lines,
  bare,
  className,
}: {
  path: string;
  value: string | OutlineText;
  /** A text of several lines: Enter breaks the line; otherwise it ends the edit. */
  lines?: boolean;
  /** Inside a block that turns to an input's ground itself. */
  bare?: boolean;
  className?: string;
}) {
  const editing = useContext(KernelEditContext);
  const place = WORDS.test(path) || OPTION.test(path) ? editing?.at[path] : undefined;
  const el = useRef<HTMLSpanElement>(null);
  // Compared by the code alone: how a chip is drawn is not part of what a person typed.
  const shown = JSON.stringify(
    partsOf(value).map((part) => (typeof part === "string" ? part : { $code: part.$code })),
  );
  const fill = () =>
    el.current?.replaceChildren(
      ...partsOf(value).map((part) => {
        if (!isOutlineCode(part)) return document.createTextNode(part);
        const chip = document.createElement("code");
        // Not selectable: a click on a chip puts the cursor beside it, where typing works.
        chip.className = `${CODE} select-none`;
        chip.contentEditable = "false";
        chip.dataset.code = part.$code;
        // A choice between two written values reads as that: what is asked, then the one and
        // the other in words.
        if (part.$either) {
          chip.replaceChildren(
            `${part.$either.if} ? `,
            words(said(part.$either.then)),
            " : ",
            words(said(part.$either.else)),
          );
        } else {
          chip.textContent = part.$code;
        }
        return chip;
      }),
    );
  // The element's content is its own while a person types; the outline's whenever that changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `shown` is the value
  useLayoutEffect(() => {
    if (document.activeElement !== el.current) fill();
  }, [shown]);

  const leave = () => {
    const node = el.current;
    if (!node || !place || !editing) return;
    const next = read(node);
    if (JSON.stringify(next) === shown) return;
    editing.save(place, next.every((part) => typeof part === "string") ? next.join("") : next);
  };
  const key = (e: KeyboardEvent<HTMLSpanElement>) => {
    if (e.key === "Escape") {
      // Back to what the file has.
      fill();
      e.currentTarget.blur();
    } else if (e.key === "Enter" && (!lines || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.currentTarget.blur();
    }
  };
  return (
    <span
      ref={el}
      {...(place
        ? {
            contentEditable: "plaintext-only" as const,
            suppressContentEditableWarning: true,
            spellCheck: false,
            role: "textbox",
            tabIndex: 0,
            onBlur: leave,
            onKeyDown: key,
            // The ground says where the cursor is; the studio's focus outline would draw a second frame.
            style: { outline: "none" },
          }
        : {})}
      className={cn(
        "whitespace-pre-wrap",
        typeof value !== "string" && "leading-[1.9]",
        place && "cursor-text outline-none",
        place &&
          !bare &&
          "-mx-1.5 rounded-md px-1.5 transition-colors hover:bg-card/60 focus:bg-card focus:shadow-[0_0_0_2px_var(--ring)]",
        lines && "block",
        className,
      )}
    />
  );
}

/** Whether a text at this path is typed over in place: the pen on its block says so. */
export function useEditable(path: string): boolean {
  const editing = useContext(KernelEditContext);
  return Boolean((WORDS.test(path) || OPTION.test(path)) && editing?.at[path]);
}

/**
 * What a block of the panel offers on hover: the pen where its text is typed over, and a note to
 * the assistant about this element. The note opens beside the element it is about.
 */
export function BlockTools({ about, pen }: { about: string; pen?: boolean }) {
  const editing = useContext(KernelEditContext);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  if (!editing?.note && !pen) return null;
  const send = () => {
    if (!text.trim()) return;
    editing?.note?.(about, text.trim());
    setText("");
    setOpen(false);
  };
  return (
    <div
      ref={box}
      className={cn(
        "absolute top-2 right-2 flex items-center gap-0.5 transition-opacity",
        // Open, the note lies over the blocks below and their tools.
        open ? "z-20" : "z-10",
        !open && "opacity-0 group-focus-within/block:opacity-100 group-hover/block:opacity-100",
      )}
    >
      {pen ? (
        <span className="inline-flex size-7 items-center justify-center text-ink-3">
          <Pencil className="size-3.5" />
        </span>
      ) : null}
      {editing?.note ? (
        <button
          type="button"
          title={t("kernel.note.ask")}
          aria-label={t("kernel.note.ask")}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className={cn(
            "inline-flex size-7 items-center justify-center rounded-full text-ink-2 hover:bg-card hover:text-ember",
            open && "bg-card text-ember",
          )}
        >
          <Sparkles className="size-3.5" />
        </button>
      ) : null}
      {open ? (
        <div className="absolute top-full right-0 mt-1.5 flex w-[min(22rem,80vw)] flex-col gap-2 rounded-2xl bg-card p-3.5 shadow-[0_0_0_1.5px_var(--cobalt),0_12px_32px_rgb(0_0_0/0.16)]">
          <span className="truncate text-[0.75rem] text-ink-3">
            {editing?.path.split("/").pop()} › {about}
          </span>
          <textarea
            ref={(node) => node?.focus()}
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              } else if (e.key === "Escape") {
                setOpen(false);
              }
            }}
            placeholder={t("kernel.note.placeholder")}
            className="resize-none bg-transparent text-[0.9375rem] text-ink outline-none placeholder:text-ink-3"
          />
          <button
            type="button"
            onClick={send}
            disabled={!text.trim()}
            className="inline-flex items-center gap-1.5 self-end rounded-full bg-ember px-3 py-1 font-medium text-[0.8125rem] text-white disabled:opacity-40"
          >
            <Sparkles className="size-3.5" />
            {t("kernel.note.send")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
