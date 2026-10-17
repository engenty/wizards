import type { BrowserAct } from "@engenty-wizards/shared/run";
import { ArrowDown, ArrowUp, CornerDownLeft, MousePointerClick } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { api, runBase, withBase } from "./env.js";
import { t } from "./i18n.js";
import { cn, Input } from "./ui.js";

/** Scrolling in the page is sent at most this often; the wheel's movement in between adds up. */
const WHEEL_EVERY_MS = 250;

/**
 * The wizard's browser, live: a picture from the run that changes as the page does. Watching,
 * it shows over the page what the wizard just did; driving, the person clicks, scrolls and
 * types in it — what they type goes into the page and no model reads it back.
 */
export function LiveBrowser({
  runId,
  driving,
  caption,
  action,
  hint,
  className,
  onBroken,
}: {
  runId: string;
  driving: boolean;
  /** What the wizard just did, over the page while watching. */
  caption?: string;
  /** A button in the corner: take over, hand back. */
  action?: ReactNode;
  /** A line over the controls while driving. */
  hint?: string;
  className?: string;
  /** The stream broke off: the run let the browser go. */
  onBroken?: () => void;
}) {
  const image = useRef<HTMLImageElement>(null);
  const controls = useRef<HTMLDivElement>(null);
  const [text, setText] = useState("");
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async (body: BrowserAct) => {
    setError(null);
    try {
      await api.post(`${runBase(runId)}/browser/act`, body);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // Taking over brings the controls under the page into view.
  useEffect(() => {
    if (driving) {
      controls.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [driving]);

  // The wheel scrolls the page, not the chat around it: a listener that may prevent that.
  useEffect(() => {
    const el = image.current;
    if (!(el && driving)) {
      return;
    }
    let pending = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      pending += e.deltaY;
      timer ??= setTimeout(() => {
        timer = null;
        const dy = Math.max(-2000, Math.min(2000, Math.round(pending)));
        pending = 0;
        if (dy) {
          void api
            .post(`${runBase(runId)}/browser/act`, { type: "scroll", dy })
            .catch(() => undefined);
        }
      }, WHEEL_EVERY_MS);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [driving, runId]);

  const click = (e: React.MouseEvent<HTMLImageElement>) => {
    if (!driving) {
      return;
    }
    const box = e.currentTarget.getBoundingClientRect();
    void act({
      type: "click",
      fx: Math.min(1, Math.max(0, (e.clientX - box.left) / box.width)),
      fy: Math.min(1, Math.max(0, (e.clientY - box.top) / box.height)),
    });
  };

  return (
    <div className={className}>
      <div
        className={cn(
          "relative aspect-[1280/900] w-full overflow-hidden rounded-xl bg-paper-2 ring-1",
          driving ? "ring-2 ring-ember" : "ring-border-soft",
        )}
      >
        <img
          ref={image}
          src={withBase(`${runBase(runId)}/browser/live`)}
          alt=""
          draggable={false}
          onClick={click}
          onError={onBroken}
          className={cn("size-full object-cover object-top", driving && "cursor-pointer")}
        />
        {action ? <div className="absolute top-2 right-2">{action}</div> : null}
        {caption && !driving ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-black/75 to-transparent px-3 pt-8 pb-2 text-[0.8125rem] text-white">
            <MousePointerClick className="size-3.5 shrink-0" />
            <span className="truncate">{caption}</span>
          </div>
        ) : null}
      </div>
      {driving ? (
        <div ref={controls} className="mt-1.5">
          {hint ? <p className="mb-1.5 text-[0.8125rem] text-ink-3">{hint}</p> : null}
          <div className="flex flex-wrap items-center gap-1.5 rounded-xl bg-card p-2 ring-1 ring-border-soft">
            <Input
              type={hidden ? "password" : "text"}
              autoComplete="off"
              value={text}
              placeholder={t("ask.typeInto")}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void act({ type: "type", text }).then(() => setText(""));
                }
              }}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="send"
              className="h-9 min-w-[9rem] flex-1 basis-full text-[0.8125rem] sm:basis-0 coarse:h-11"
            />
            <button
              type="button"
              onClick={() => setHidden((h) => !h)}
              className={cn(
                "h-9 shrink-0 rounded-md px-2.5 text-[0.75rem] coarse:h-11 coarse:px-3.5",
                hidden ? "bg-ember-veil text-ink" : "text-ink-3 hover:bg-paper-2",
              )}
            >
              {t("ask.hide")}
            </button>
            <ToolButton label="Enter" onClick={() => void act({ type: "key", key: "Enter" })}>
              <CornerDownLeft className="size-4" />
            </ToolButton>
            <ToolButton label={t("ask.up")} onClick={() => void act({ type: "scroll", dy: -500 })}>
              <ArrowUp className="size-4" />
            </ToolButton>
            <ToolButton label={t("ask.down")} onClick={() => void act({ type: "scroll", dy: 500 })}>
              <ArrowDown className="size-4" />
            </ToolButton>
          </div>
          {error ? <p className="mt-1.5 text-[0.8125rem] text-rose">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function ToolButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex size-9 shrink-0 items-center justify-center rounded-md text-ink-3 hover:bg-paper-2 hover:text-ink coarse:size-11"
    >
      {children}
    </button>
  );
}
