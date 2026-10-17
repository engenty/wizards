import { ListOrdered, Maximize2, MessagesSquare, Minimize2, X } from "lucide-react";
import { type ReactNode, useCallback, useState } from "react";
import { t } from "../lib/i18n";
import { cn, IconButton } from "../ui";

const WIDTH_KEY = "wizards.runDrawer.width";
const WIDE_KEY = "wizards.runDrawer.wide";
const LOOK_KEY = "wizards.runDrawer.look";
const WIDTH_DEFAULT = 680;
const WIDTH_MIN = 400;

/** Room the page keeps beside the drawer, so a click there still closes it. */
const widthMax = () => Math.max(WIDTH_MIN, window.innerWidth - 120);

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // only lasts this page then
  }
}

/** The drawer's width, dragged at its left edge, and whether it fills the window; remembered per browser. */
function useDrawerWidth() {
  const [width, setWidth] = useState(() => {
    const n = Number(stored(WIDTH_KEY));
    return n ? Math.min(Math.max(n, WIDTH_MIN), widthMax()) : WIDTH_DEFAULT;
  });
  const [wide, setWide] = useState(() => stored(WIDE_KEY) === "1");
  const set = useCallback((next: number) => {
    const w = Math.round(Math.min(Math.max(next, WIDTH_MIN), widthMax()));
    setWidth(w);
    store(WIDTH_KEY, String(w));
  }, []);
  const toggleWide = () => {
    setWide(!wide);
    store(WIDE_KEY, wide ? "0" : "1");
  };
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const move = (ev: PointerEvent) => set(startW + startX - ev.clientX);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 64 : 16;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      set(width + step);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      set(width - step);
    }
  };
  return {
    width,
    wide,
    toggleWide,
    onPointerDown,
    onKeyDown,
    reset: () => set(WIDTH_DEFAULT),
  };
}

/** How a test run is shown: page by page, or as a chat; remembered per browser. */
export type RunLook = "steps" | "chat";

export function useRunLook(): [RunLook, (look: RunLook) => void] {
  const [look, setLook] = useState<RunLook>(() => (stored(LOOK_KEY) === "chat" ? "chat" : "steps"));
  return [
    look,
    (next) => {
      setLook(next);
      store(LOOK_KEY, next);
    },
  ];
}

/** The switch between the two, for the drawer's bar. */
export function LookSwitch({
  look,
  onChange,
}: {
  look: RunLook;
  onChange: (look: RunLook) => void;
}) {
  const ways = [
    { id: "steps", label: t("chat.steps"), Icon: ListOrdered },
    { id: "chat", label: t("chat.chat"), Icon: MessagesSquare },
  ] as const;
  return (
    <fieldset
      aria-label={t("chat.view")}
      className="m-0 flex min-w-0 rounded-full border-0 bg-paper-2 p-0.5"
    >
      {ways.map(({ id, label, Icon }) => (
        <button
          key={id}
          type="button"
          aria-pressed={look === id}
          title={label}
          onClick={() => onChange(id)}
          className={cn(
            "inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 font-medium text-[0.75rem] transition coarse:h-9",
            look === id ? "bg-card text-ink shadow-soft" : "text-ink-3 hover:text-ink",
          )}
        >
          <Icon className="size-3.5" />
          <span className="max-sm:hidden">{label}</span>
        </button>
      ))}
    </fieldset>
  );
}

/**
 * A run opened beside the page: dragged wider or narrower at its left edge, or filling the
 * browser window with the expand button. `header` is what the bar shows before its buttons.
 */
export function RunDrawer({
  header,
  actions,
  onClose,
  children,
}: {
  header: ReactNode;
  actions?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const drawer = useDrawerWidth();
  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-[oklch(20%_0.01_60/0.22)] backdrop-blur-[1px]"
      onClick={onClose}
    >
      <div
        className={cn(
          "relative flex h-full w-full animate-rise flex-col bg-background shadow-overlay",
          !drawer.wide && "sm:w-[var(--drawer)]",
        )}
        style={{ "--drawer": `${drawer.width}px` } as React.CSSProperties}
        onClick={(e) => e.stopPropagation()}
      >
        {drawer.wide ? null : (
          // biome-ignore lint/a11y/useSemanticElements: a draggable splitter has no element of its own
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={t("editor.resize")}
            aria-valuenow={drawer.width}
            tabIndex={0}
            title={t("editor.resize")}
            onPointerDown={drawer.onPointerDown}
            onKeyDown={drawer.onKeyDown}
            onDoubleClick={drawer.reset}
            className="group -left-2.5 absolute inset-y-0 z-10 hidden w-5 cursor-col-resize outline-none sm:block"
          >
            <span className="-translate-y-1/2 absolute top-1/2 left-[7px] h-12 w-1.5 rounded-full bg-ink-4/40 transition group-hover:bg-ember/70 group-focus-visible:bg-ember group-active:h-16 group-active:bg-ember" />
          </div>
        )}
        {/* On a phone with the keyboard up the bar goes: the field gets its room. */}
        <div className="kb-hide flex h-14 shrink-0 items-center gap-3 px-4">
          <div className="flex min-w-0 flex-1 items-center gap-3">{header}</div>
          <div className="flex items-center gap-1">
            {actions}
            <IconButton
              label={t(drawer.wide ? "runDrawer.shrink" : "runDrawer.expand")}
              onClick={drawer.toggleWide}
              className="max-sm:hidden"
            >
              {drawer.wide ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
            </IconButton>
            <IconButton label={t("editor.close")} onClick={onClose}>
              <X className="size-5" />
            </IconButton>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}
