import { Eraser, Highlighter, Square, Undo2 } from "lucide-react";
import { domToPng } from "modern-screenshot";
import { type PointerEvent, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { withBase } from "../lib/base";
import { t } from "../lib/i18n";
import { Button, Dialog, Input, Label, Spinner, Switch, Textarea } from "../ui";
import { keptLines, masked } from "./log";

/**
 * "Report a problem" (docs/plans/wizards-admin.md in the Manage repository): the run page and the
 * studio offer it, at once when something broke. The dialog shows everything that would go – the
 * person's words, a screenshot with what they typed into the fields covered, the error, the log
 * lines with addresses and numbers replaced, the page's address – and sends only what they leave
 * in. On the screenshot they mark with a pen or cover more with black boxes.
 */

export interface ReportContext {
  where: "run" | "studio" | "page";
  runId?: string | null;
  error?: { message: string; stack?: string } | null;
}

let opened: ReportContext | null = null;
const listeners = new Set<() => void>();
const tell = () => {
  for (const l of listeners) {
    l();
  }
};

/** Opens the dialog from anywhere: a button, the crash page. */
export function openReport(context: ReportContext) {
  opened = context;
  tell();
}

const closeReport = () => {
  opened = null;
  tell();
};

const useOpened = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => opened,
  );

/** A field's own value never shows on the screenshot: the clone carries dots in its place. */
function coverFields(node: Node) {
  if (node instanceof HTMLInputElement) {
    if (
      !["button", "submit", "checkbox", "radio", "range", "color", "hidden"].includes(node.type)
    ) {
      const dots = node.value ? "•".repeat(Math.min(12, node.value.length)) : "";
      node.setAttribute("value", dots);
      node.value = dots;
    }
  } else if (node instanceof HTMLTextAreaElement) {
    const dots = node.value ? "•".repeat(Math.min(24, node.value.length)) : "";
    node.textContent = dots;
    node.value = dots;
  } else if (
    node instanceof HTMLElement &&
    (node.isContentEditable || node.dataset.private !== undefined)
  ) {
    node.style.filter = "blur(6px)";
  }
}

async function screenshot(): Promise<string | null> {
  try {
    return await domToPng(document.body, {
      scale: Math.min(2, window.devicePixelRatio || 1),
      width: window.innerWidth,
      height: window.innerHeight,
      style: { transform: `translateY(-${window.scrollY}px)` },
      backgroundColor: getComputedStyle(document.body).backgroundColor || "#fff",
      onCloneEachNode: coverFields,
      filter: (el) => !(el instanceof HTMLElement && el.dataset.reportSkip !== undefined),
    });
  } catch (err) {
    console.warn("[report] no screenshot:", (err as Error).message);
    return null;
  }
}

type Mark =
  | { tool: "pen"; points: [number, number][] }
  | { tool: "cover"; from: [number, number]; to: [number, number] };

/** The screenshot on the canvas, the marks over it. */
function draw(c: HTMLCanvasElement | null, img: HTMLImageElement | null, all: Mark[]) {
  if (!c || !img) {
    return;
  }
  const g = c.getContext("2d");
  if (!g) {
    return;
  }
  g.drawImage(img, 0, 0, c.width, c.height);
  for (const m of all) {
    if (m.tool === "pen") {
      g.strokeStyle = "#e11d48";
      g.lineWidth = Math.max(3, c.width / 300);
      g.lineCap = "round";
      g.lineJoin = "round";
      g.beginPath();
      for (const [i, [x, y]] of m.points.entries()) {
        if (i) {
          g.lineTo(x, y);
        } else {
          g.moveTo(x, y);
        }
      }
      g.stroke();
    } else {
      g.fillStyle = "#000";
      const [x1, y1] = m.from;
      const [x2, y2] = m.to;
      g.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
    }
  }
}

/** The screenshot with the person's marks: a red pen, black boxes. */
function Annotate({ src, onChange }: { src: string; onChange: (png: string) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const image = useRef<HTMLImageElement | null>(null);
  const [tool, setTool] = useState<"pen" | "cover">("pen");
  const [marks, setMarks] = useState<Mark[]>([]);
  const drawing = useRef<Mark | null>(null);

  const paint = (all: Mark[]) => draw(canvas.current, image.current, all);

  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      image.current = img;
      const c = canvas.current;
      if (c) {
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        draw(c, img, []);
      }
    };
    img.src = src;
  }, [src]);

  const at = (e: PointerEvent<HTMLCanvasElement>): [number, number] => {
    const c = canvas.current!;
    const r = c.getBoundingClientRect();
    return [
      ((e.clientX - r.left) / r.width) * c.width,
      ((e.clientY - r.top) / r.height) * c.height,
    ];
  };
  const done = (next: Mark[]) => {
    setMarks(next);
    paint(next);
    onChange(canvas.current!.toDataURL("image/png"));
  };

  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-1.5">
        <Button
          size="sm"
          variant={tool === "pen" ? "quiet" : "ghost"}
          onClick={() => setTool("pen")}
        >
          <Highlighter className="size-4" /> {t("report.pen")}
        </Button>
        <Button
          size="sm"
          variant={tool === "cover" ? "quiet" : "ghost"}
          onClick={() => setTool("cover")}
        >
          <Square className="size-4 fill-current" /> {t("report.cover")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!marks.length}
          onClick={() => done(marks.slice(0, -1))}
        >
          <Undo2 className="size-4" /> {t("report.undo")}
        </Button>
        {marks.length ? (
          <Button size="sm" variant="ghost" onClick={() => done([])} aria-label="Clear">
            <Eraser className="size-4" />
          </Button>
        ) : null}
      </div>
      <canvas
        ref={canvas}
        className="w-full cursor-crosshair touch-none rounded-lg border border-border"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          const p = at(e);
          drawing.current = tool === "pen" ? { tool, points: [p] } : { tool, from: p, to: p };
        }}
        onPointerMove={(e) => {
          const m = drawing.current;
          if (!m) {
            return;
          }
          const p = at(e);
          if (m.tool === "pen") {
            m.points.push(p);
          } else {
            m.to = p;
          }
          paint([...marks, m]);
        }}
        onPointerUp={() => {
          const m = drawing.current;
          drawing.current = null;
          if (m) {
            done([...marks, m]);
          }
        }}
      />
    </div>
  );
}

/** The dialog, mounted once at the page's root; `openReport` opens it. */
export function ReportHost() {
  const context = useOpened();
  const [shot, setShot] = useState<string | null>(null);
  const [marked, setMarked] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [withShot, setWithShot] = useState(true);
  const [withLogs, setWithLogs] = useState(true);
  const [comment, setComment] = useState("");
  const [contact, setContact] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "failed">("idle");
  const logs = keptLines().map(masked);
  const url = masked(window.location.href);

  useEffect(() => {
    if (!context) {
      return;
    }
    setState("idle");
    setComment("");
    setMarked(null);
    setCapturing(true);
    // The dialog is not open yet while the page is captured: it shows what the person saw.
    void screenshot().then((png) => {
      setShot(png);
      setWithShot(Boolean(png));
      setCapturing(false);
    });
  }, [context]);

  if (!context) {
    return null;
  }
  if (capturing) {
    return (
      <div
        data-report-skip
        className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center"
      >
        <span className="flex items-center gap-2 rounded-full bg-ink px-4 py-2 text-paper text-sm">
          <Spinner className="size-4" /> {t("report.capturing")}
        </span>
      </div>
    );
  }
  const send = async () => {
    setState("sending");
    try {
      const res = await fetch(withBase("/api/bug-reports"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          where: context.where,
          url: window.location.href.split("?")[0],
          runId: context.runId ?? null,
          comment: comment.trim() || null,
          error: context.error
            ? {
                message: masked(context.error.message),
                stack: context.error.stack ? masked(context.error.stack) : undefined,
              }
            : null,
          logs: withLogs ? logs : [],
          screenshot: withShot ? (marked ?? shot) : null,
          contact: contact.trim() || null,
        }),
      });
      setState(res.ok ? "sent" : "failed");
    } catch {
      setState("failed");
    }
  };
  return (
    <Dialog open onClose={closeReport} title={t("report.title")} wide height="tall">
      <div className="grid gap-5" data-report-skip>
        {state === "sent" ? (
          <div className="py-10 text-center">
            <p className="font-display font-semibold text-lg">{t("report.sent")}</p>
            <Button className="mt-6" onClick={closeReport}>
              OK
            </Button>
          </div>
        ) : (
          <>
            <p className="text-ink-3 text-sm">{t("report.lead")}</p>
            <div>
              <Label hint={t("report.whatHint")}>{t("report.what")}</Label>
              <Textarea
                data-autofocus
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                rows={3}
              />
            </div>
            <div>
              <div className="mb-2 flex items-center justify-between gap-3">
                <Label hint={t("report.screenshotHint")}>{t("report.screenshot")}</Label>
                <Switch
                  checked={withShot}
                  disabled={!shot}
                  onChange={setWithShot}
                  label={t("report.screenshot")}
                />
              </div>
              {shot ? (
                withShot ? (
                  <Annotate src={shot} onChange={setMarked} />
                ) : null
              ) : (
                <p className="text-ink-3 text-sm">{t("report.noShot")}</p>
              )}
            </div>
            {context.error ? (
              <div>
                <Label>{t("report.error")}</Label>
                <pre className="max-h-32 overflow-auto rounded-lg bg-paper-2 p-3 text-xs">
                  {masked(context.error.message)}
                </pre>
              </div>
            ) : null}
            <div>
              <div className="mb-2 flex items-center justify-between gap-3">
                <Label hint={t("report.logsHint")}>
                  {t("report.logs", { count: logs.length })}
                </Label>
                <Switch
                  checked={withLogs}
                  disabled={!logs.length}
                  onChange={setWithLogs}
                  label={t("report.logs", { count: logs.length })}
                />
              </div>
              {withLogs && logs.length ? (
                <pre className="max-h-40 overflow-auto rounded-lg bg-paper-2 p-3 text-xs">
                  {logs.join("\n")}
                </pre>
              ) : null}
            </div>
            <div>
              <Label>{t("report.page")}</Label>
              <p className="break-all font-mono text-ink-3 text-xs">
                {url}
                <br />
                {navigator.userAgent}
              </p>
            </div>
            <div>
              <Label>{t("report.contact")}</Label>
              <Input type="email" value={contact} onChange={(e) => setContact(e.target.value)} />
            </div>
            {state === "failed" ? <p className="text-rose text-sm">{t("report.failed")}</p> : null}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={closeReport}>
                {t("report.cancel")}
              </Button>
              <Button onClick={() => void send()} busy={state === "sending"}>
                {state === "sending" ? t("report.sending") : t("report.send")}
              </Button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
