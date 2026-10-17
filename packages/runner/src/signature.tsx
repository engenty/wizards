import { Eraser, PenLine, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, runBase, withBase } from "./env.js";
import { t } from "./i18n.js";
import { Button, Dialog, IconButton } from "./ui.js";

type Point = { x: number; y: number };
/** Strokes in pad units: x from 0 to 1, y from 0 to 1 — they survive a rotated phone. */
type Strokes = Point[][];

const INK = "#1d1a17";
/** The kept picture: wide like a signature line, sharp enough for print. */
const OUT = { width: 1200, height: 480 };

function draw(ctx: CanvasRenderingContext2D, strokes: Strokes, w: number, h: number, pen: number) {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = INK;
  ctx.fillStyle = INK;
  ctx.lineWidth = pen;
  for (const stroke of strokes) {
    if (stroke.length === 1) {
      ctx.beginPath();
      ctx.arc(stroke[0].x * w, stroke[0].y * h, pen / 2, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    ctx.beginPath();
    ctx.moveTo(stroke[0].x * w, stroke[0].y * h);
    // Curves through the midpoints: a finger's jittery samples become one smooth line.
    for (let i = 1; i < stroke.length - 1; i++) {
      const a = stroke[i];
      const b = stroke[i + 1];
      ctx.quadraticCurveTo(a.x * w, a.y * h, ((a.x + b.x) / 2) * w, ((a.y + b.y) / 2) * h);
    }
    const last = stroke[stroke.length - 1];
    ctx.lineTo(last.x * w, last.y * h);
    ctx.stroke();
  }
}

function Pad({ strokes, onStrokes }: { strokes: Strokes; onStrokes: (s: Strokes) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const current = useRef<Point[] | null>(null);
  const all = useRef(strokes);
  all.current = strokes;

  const paint = () => {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx) {
      return;
    }
    const ratio = window.devicePixelRatio || 1;
    const w = Math.round(el.clientWidth * ratio);
    const h = Math.round(el.clientHeight * ratio);
    if (el.width !== w || el.height !== h) {
      el.width = w;
      el.height = h;
    }
    ctx.clearRect(0, 0, w, h);
    const live = current.current ? [...all.current, current.current] : all.current;
    draw(ctx, live, w, h, 2.4 * ratio);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: repaints whenever the strokes change
  useEffect(() => {
    paint();
    const el = canvas.current;
    if (!el) {
      return;
    }
    const ro = new ResizeObserver(paint);
    ro.observe(el);
    return () => ro.disconnect();
  }, [strokes]);

  const at = (e: React.PointerEvent<HTMLCanvasElement>): Point => {
    const box = e.currentTarget.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - box.left) / box.width)),
      y: Math.min(1, Math.max(0, (e.clientY - box.top) / box.height)),
    };
  };

  return (
    <div className="relative overflow-hidden rounded-xl bg-white ring-1 ring-input">
      <canvas
        ref={canvas}
        aria-label={t("sign.pad")}
        className="block aspect-[5/2] w-full cursor-crosshair touch-none select-none"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          current.current = [at(e)];
          paint();
        }}
        onPointerMove={(e) => {
          if (current.current) {
            current.current.push(at(e));
            paint();
          }
        }}
        onPointerUp={() => {
          if (current.current) {
            const done = current.current;
            current.current = null;
            onStrokes([...all.current, done]);
          }
        }}
        onPointerCancel={() => {
          current.current = null;
          paint();
        }}
      />
      {/* The line to sign on. */}
      <div className="pointer-events-none absolute inset-x-6 bottom-[22%] border-[#1d1a17]/25 border-b" />
      {strokes.length ? null : (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[#1d1a17]/40 text-[0.875rem]">
          {t("sign.hint")}
        </div>
      )}
    </div>
  );
}

async function picture(strokes: Strokes): Promise<File | null> {
  const canvas = document.createElement("canvas");
  canvas.width = OUT.width;
  canvas.height = OUT.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return null;
  }
  // Clear ground, dark ink: the signature sits on any paper it is placed on.
  draw(ctx, strokes, OUT.width, OUT.height, 7);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
  return blob ? new File([blob], "unterschrift.png", { type: "image/png" }) : null;
}

/** A signature drawn with the finger, a pen or the mouse; kept as a picture. */
export function SignatureField({
  label,
  value,
  runId,
  onChange,
}: {
  label: string;
  value: unknown;
  runId: string;
  onChange: (v: string | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const [strokes, setStrokes] = useState<Strokes>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = typeof value === "string" && value ? value : null;

  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      const file = await picture(strokes);
      if (!file) {
        return;
      }
      const ref = await api.upload<{ id: string }>(`${runBase(runId)}/uploads`, file);
      onChange(ref.id);
      setOpen(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      {id ? (
        <div className="flex items-center gap-3 rounded-xl bg-card p-2 ring-1 ring-input">
          <button
            type="button"
            onClick={() => {
              setStrokes([]);
              setOpen(true);
            }}
            className="min-w-0 flex-1 rounded-lg bg-white px-3"
            aria-label={t("sign.again")}
          >
            <img
              src={withBase(`${runBase(runId)}/assets/${id}`)}
              alt={label}
              className="mx-auto h-20 object-contain"
            />
          </button>
          <IconButton label={t("sign.remove")} onClick={() => onChange(undefined)}>
            <X className="size-4" />
          </IconButton>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => {
            setStrokes([]);
            setOpen(true);
          }}
          className="flex w-full flex-col items-center justify-center gap-2 rounded-xl border border-input border-dashed bg-card px-4 py-7 text-[0.875rem] text-ink-3 transition hover:border-ember hover:text-ink"
        >
          <PenLine className="size-6" />
          {t("sign.open")}
        </button>
      )}
      <Dialog open={open} onClose={() => setOpen(false)} title={label} wide>
        <Pad strokes={strokes} onStrokes={setStrokes} />
        {error ? <p className="mt-2 text-[0.8125rem] text-rose">{error}</p> : null}
        <div className="mt-5 flex items-center justify-between gap-3">
          <Button variant="ghost" disabled={!strokes.length || busy} onClick={() => setStrokes([])}>
            <Eraser className="size-4" /> {t("sign.clear")}
          </Button>
          <Button busy={busy} disabled={!strokes.length} onClick={() => void accept()}>
            {t("sign.accept")}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
