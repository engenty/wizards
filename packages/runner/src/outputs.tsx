import type { Format, Step } from "@engenty/wizards-shared/definition";
import { stepShape } from "@engenty/wizards-shared/definition";
import type { StepOutput } from "@engenty/wizards-shared/run";
import { labelOf } from "@engenty/wizards-shared/shape";
import DOMPurify from "dompurify";
import { Check, Copy, Download, FileText, Maximize2, Printer, Share } from "lucide-react";
import { marked } from "marked";
import { useEffect, useMemo, useRef, useState } from "react";
import { canShareFiles } from "./device";
import { appCall, appCan, appDownload, asset, standalone, withBase } from "./env.js";
import { t } from "./i18n.js";
import { JsonView } from "./json-view.js";
import { type Written, writePdf } from "./pdf.js";
import { type SurfaceAction, SurfaceView } from "./surface";
import { cn, Spinner, Textarea } from "./ui.js";

export function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(text, { async: false }) as string),
    [text],
  );
  return (
    // biome-ignore lint/security/noDangerouslySetInnerHtml: model output, sanitised by DOMPurify above
    <div className={cn("prose-zen", className)} dangerouslySetInnerHTML={{ __html: html }} />
  );
}

/**
 * Generated HTML in a sandboxed frame: scripts run (scrubbers, tabs, animations) but in an opaque
 * origin with no network. The frame is mounted only once its HTML is there — Chrome paints a
 * sandboxed frame whose content changes after mount blank. `page` is the layout width; the frame
 * is scaled to fit.
 */
export function HtmlFrame({
  src,
  page,
  height,
  fit,
  flow,
  state,
  onState,
}: {
  src: string;
  /** Layout width in CSS px; null = the frame's own width. */
  page: number | null;
  height: number;
  /** Scale up as well as down, so a fixed-size widget fills the width. */
  fit?: boolean;
  /**
   * A widget laid out as part of the page: as wide as the page, as tall as its content says
   * (`height` until it does), never scaled. It may keep a state and share text.
   */
  flow?: boolean;
  /** What the widget kept last time (`wizard.state`). */
  state?: Record<string, unknown>;
  onState?: (state: Record<string, unknown>) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [tall, setTall] = useState(height);
  // The state the frame started with: later saves must not reload it.
  const [initial] = useState(() => state ?? {});
  const keep = useRef(onState);
  keep.current = onState;
  useEffect(() => {
    const listen = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) {
        return;
      }
      const msg = e.data as { wizard?: string; height?: unknown; state?: unknown; text?: unknown };
      if (msg?.wizard === "height" && typeof msg.height === "number") {
        setTall(Math.min(20_000, Math.max(120, Math.ceil(msg.height))));
      } else if (msg?.wizard === "state" && msg.state && typeof msg.state === "object") {
        keep.current?.(msg.state as Record<string, unknown>);
      } else if (msg?.wizard === "share" && typeof msg.text === "string") {
        const text = msg.text.slice(0, 10_000);
        if (navigator.share) {
          navigator.share({ text }).catch(() => undefined);
        } else {
          navigator.clipboard?.writeText(text).catch(() => undefined);
        }
      }
    };
    window.addEventListener("message", listen);
    return () => window.removeEventListener("message", listen);
  }, []);
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = wrap.current;
    if (!el) {
      return;
    }
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const [html, setHtml] = useState<{ src: string; text: string } | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(src, { credentials: "include" })
      .then((r) => (r.ok ? r.text() : ""))
      .then((text) => alive && setHtml({ src, text }));
    return () => {
      alive = false;
    };
  }, [src]);
  const layout = flow ? width || 360 : (page ?? Math.max(width, 900));
  const scale = flow ? 1 : width ? (fit ? width / layout : Math.min(1, width / layout)) : 1;
  const shown = flow ? tall : height;
  // The kept state goes in ahead of the widget's own scripts, so `wizard.state` is there at once.
  const doc =
    flow && html
      ? `<script>window.__WIZARD_STATE=${JSON.stringify(initial).replace(/</g, "\\u003c")}</script>${html.text}`
      : html?.text;
  return (
    <div
      ref={wrap}
      className={cn(
        "relative overflow-hidden",
        !flow && "rounded-lg bg-white ring-1 ring-border-soft",
      )}
      style={{ height: shown * scale }}
    >
      {html?.src === src ? (
        <iframe
          ref={frame}
          key={src}
          title={t("output.preview")}
          srcDoc={doc}
          sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
          className="absolute top-0 left-0 origin-top-left border-0"
          style={{ width: layout, height: shown, transform: `scale(${scale})` }}
        />
      ) : (
        <div className="absolute inset-0 animate-pulse bg-paper-2" />
      )}
      {flow ? null : (
        <a
          href={src}
          target="_blank"
          rel="noreferrer"
          className="absolute top-3 right-3 inline-flex size-9 items-center justify-center rounded-full bg-card/90 text-ink-2 shadow-soft ring-1 ring-border-soft backdrop-blur hover:text-ink coarse:size-11"
          aria-label={t("run.openFull")}
        >
          <Maximize2 className="size-4" />
        </a>
      )}
    </div>
  );
}

/**
 * Where the artwork sits inside the Commission's icon files (the half-transparent variants):
 * each leaves clear space around its shape, and the label is laid out by the shape.
 */
const AI_ICONS = {
  disc: { file: "ai", box: 566.93, x: 89.28, y: 100.72, w: 365.49, h: 365.49 },
  generated: { file: "ai-generated", box: 1789.84, x: 207.3, y: 144.36, w: 1384.24, h: 266.41 },
  edited: { file: "ai-modified", box: 1700.79, x: 231.11, y: 144.36, w: 1230.56, h: 266.41 },
} as const;

/** One of the icons, scaled so that its shape is `size` px high, with the shape at the box's corner. */
function AiIcon({
  icon,
  tone,
  size,
  className,
}: {
  icon: keyof typeof AI_ICONS;
  tone: "white" | "black";
  size: number;
  className?: string;
}) {
  const art = AI_ICONS[icon];
  const scale = size / art.h;
  return (
    <img
      src={asset(`ai-labels/${art.file}-${tone}.svg`)}
      alt=""
      draggable={false}
      className={cn("pointer-events-none absolute max-w-none select-none", className)}
      style={{
        width: art.box * scale,
        height: 566.93 * scale,
        left: -art.x * scale,
        top: -art.y * scale,
      }}
    />
  );
}

/**
 * The EU's label on media a model made or changed: the round "AI" alone, and on hover, on focus
 * and on a tap the long form — "AI GENERATED" or "AI MODIFIED". It lies over the picture in the
 * interface and is not part of the file; the file says the same in its metadata.
 */
export function AiBadge({
  ai,
  className,
}: {
  ai: "generated" | "edited" | undefined;
  /** Where on the media it sits; default: bottom left. "static" sets it into the text flow. */
  className?: string;
}) {
  // A phone has no hover: a tap opens the label and the next one closes it.
  const [open, setOpen] = useState(false);
  if (!ai) {
    return null;
  }
  // Small, and of glass: the icon's ground is half transparent, the picture behind it blurred.
  const size = 18;
  const long = AI_ICONS[ai];
  const inline = className === "static";
  const shown = "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100";
  const hidden = "opacity-100 group-hover:opacity-0 group-focus-visible:opacity-0";
  // Over a picture the white label reads on anything; in the text it follows the theme.
  const tones = inline
    ? ([
        ["black", "dark:hidden"],
        ["white", "hidden dark:block"],
      ] as const)
    : ([["white", ""]] as const);
  return (
    <button
      type="button"
      aria-label={t(ai === "edited" ? "ai.modified" : "ai.generated")}
      aria-expanded={open}
      data-open={open}
      onClick={() => setOpen((v) => !v)}
      className={cn(
        "group block cursor-default overflow-hidden rounded-full backdrop-blur-md transition-[width] duration-200",
        "w-[var(--ai-disc)] hover:w-[var(--ai-long)] focus-visible:w-[var(--ai-long)] data-[open=true]:w-[var(--ai-long)]",
        inline
          ? "relative"
          : cn("absolute shadow-[0_1px_3px_rgba(0,0,0,0.25)]", className ?? "bottom-2 left-2"),
      )}
      style={
        {
          height: size,
          "--ai-disc": `${size}px`,
          "--ai-long": `${(long.w / long.h) * size}px`,
        } as React.CSSProperties
      }
    >
      {tones.map(([tone, theme]) => (
        <span key={tone} className={theme}>
          <AiIcon
            icon="disc"
            tone={tone}
            size={size}
            className={cn("transition-opacity duration-200", open ? "opacity-0" : hidden)}
          />
          <AiIcon
            icon={ai}
            tone={tone}
            size={size}
            className={cn("transition-opacity duration-200", open ? "opacity-100" : shown)}
          />
        </span>
      ))}
    </button>
  );
}

/** What people read for a key of a step's output: its label in the step's shape. */
function labelFor(step: Step, key: string): string {
  const f = step.type === "agent" ? stepShape(step).fields[key] : undefined;
  return f ? labelOf(key, f) : key;
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
      className="inline-flex h-8 items-center gap-1.5 rounded-full bg-paper-2 px-3 text-[0.8125rem] text-ink-2 hover:text-ink coarse:h-11 coarse:px-4"
    >
      {done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {done ? t("share.copied") : t("run.copy")}
    </button>
  );
}

/** One step's result: the right preview for what it produced. */
export function OutputView({
  base,
  step,
  output,
  editable,
  draft,
  onDraft,
  picked,
  onPick,
  onSurfaceAction,
  onView,
}: {
  /** `/api/runs/<id>` or `/api/shares/<token>` — where the output's files are served. */
  base: string;
  step: Step;
  output: StepOutput | null;
  editable?: boolean;
  draft?: string;
  onDraft?: (text: string) => void;
  /** Several results: the ones picked to be made again (from 0), and the tap that picks one. */
  picked?: number[];
  onPick?: (index: number) => void;
  /** A surface's buttons: "regenerate" where the review allows it. */
  onSurfaceAction?: (a: SurfaceAction) => void;
  /** Keeps what the person did in the view (ticks, a widget's state) with the run. */
  onView?: (state: Record<string, unknown>) => void;
}) {
  if (!output) {
    return null;
  }
  const assetUrl = (id: string) => withBase(`${base}/assets/${id}`);
  // A view from the catalog stands for the step's data.
  if (output.surface) {
    return (
      <SurfaceView
        surface={output.surface}
        assetUrl={assetUrl}
        onAction={onSurfaceAction}
        initial={output.view}
        onState={onView}
      />
    );
  }
  if (step.type === "widget" || step.type === "film") {
    const film = output.assets?.find((a) => a.kind === "video");
    if (film) {
      const poster = output.assets?.find((a) => a.kind === "poster");
      const tall =
        step.type === "film"
          ? step.format === "9:16"
          : (step.size?.height ?? 0) > (step.size?.width ?? 1);
      const video = (
        <div className={cn("relative mx-auto", tall ? "w-fit" : "w-full")}>
          {/* biome-ignore lint/a11y/useMediaCaption: the film's captions are part of the picture */}
          <video
            src={assetUrl(film.id)}
            poster={poster ? assetUrl(poster.id) : undefined}
            controls
            playsInline
            className={cn(
              "rounded-lg bg-black ring-1 ring-border-soft",
              tall ? "max-h-[76vh]" : "w-full",
            )}
          />
          <AiBadge ai={film.ai} className="top-2 right-2" />
        </div>
      );
      // A film step's text is the client's own word on what it made or changed — or why not.
      return step.type === "film" && output.text ? (
        <div className="flex flex-col gap-4">
          {video}
          <Markdown text={output.text} className="text-[0.875rem] text-ink-2" />
        </div>
      ) : (
        video
      );
    }
    if (step.type === "film") {
      return null;
    }
    const html = output.assets?.find((a) => a.mime === "text/html");
    const size = step.size ?? { width: 1280, height: 720 };
    return html ? (
      <HtmlFrame
        src={assetUrl(html.id)}
        page={size.width}
        height={size.height}
        fit
        flow={step.layout === "page"}
        state={output.view}
        onState={onView}
      />
    ) : null;
  }
  if (step.type === "generate") {
    const asset = output.assets?.[0];
    if (!asset) {
      return null;
    }
    if (step.asset === "voice") {
      return (
        <div className="flex flex-col gap-3">
          {/* biome-ignore lint/a11y/useMediaCaption: what is said stands right below */}
          <audio src={assetUrl(asset.id)} controls className="w-full" />
          <AiBadge ai={asset.ai} className="static" />
          {output.text ? (
            <p className="text-[0.875rem] text-ink-2 leading-relaxed">{output.text}</p>
          ) : null}
        </div>
      );
    }
    const several = (output.assets?.length ?? 0) > 1;
    if (several && (step.asset === "image" || step.asset === "video")) {
      const tall = step.options?.aspectRatio === "9:16" || step.options?.aspectRatio === "2:3";
      return (
        <div className={cn("grid gap-3", tall ? "grid-cols-2 sm:grid-cols-3" : "sm:grid-cols-2")}>
          {output.assets?.map((a, i) => {
            const on = picked?.includes(i);
            return (
              <figure
                key={a.id}
                className={cn(
                  "relative overflow-hidden rounded-lg bg-paper-2 ring-1 ring-border-soft",
                  on && "ring-2 ring-ember",
                )}
              >
                {step.asset === "image" ? (
                  <img src={assetUrl(a.id)} alt={`${step.title} ${i + 1}`} className="w-full" />
                ) : (
                  // biome-ignore lint/a11y/useMediaCaption: generated clips have no caption track to offer
                  <video src={assetUrl(a.id)} controls playsInline loop className="w-full" />
                )}
                {onPick ? (
                  <button
                    type="button"
                    aria-pressed={on}
                    onClick={() => onPick(i)}
                    className={cn(
                      "absolute top-2 left-2 inline-flex h-8 items-center gap-1.5 rounded-full px-3 font-medium text-[0.75rem] shadow-soft backdrop-blur coarse:h-11",
                      on ? "bg-ember text-ember-on" : "bg-card/90 text-ink-2 hover:text-ink",
                    )}
                  >
                    {on ? <Check className="size-3.5" /> : null}
                    {t(on ? "run.pickedItem" : "run.pickItem", { n: i + 1 })}
                  </button>
                ) : (
                  <span className="absolute top-2 left-2 rounded-full bg-card/90 px-2.5 py-1 font-medium text-[0.75rem] text-ink-2">
                    {i + 1}
                  </span>
                )}
                <AiBadge
                  ai={a.ai}
                  className={step.asset === "image" ? "bottom-2 left-2" : "top-2 right-2"}
                />
              </figure>
            );
          })}
        </div>
      );
    }
    if (step.asset === "image") {
      return (
        <div className="relative">
          <img
            src={assetUrl(asset.id)}
            alt={step.title}
            className="w-full rounded-lg bg-paper-2 ring-1 ring-border-soft"
          />
          <AiBadge ai={asset.ai} />
        </div>
      );
    }
    if (step.asset === "video") {
      const tall = step.options?.aspectRatio === "9:16";
      return (
        <div className={cn("relative mx-auto", tall ? "w-fit" : "w-full")}>
          {/* biome-ignore lint/a11y/useMediaCaption: generated clips have no caption track to offer */}
          <video
            src={assetUrl(asset.id)}
            controls
            playsInline
            loop
            className={cn(
              "rounded-lg bg-black ring-1 ring-border-soft",
              tall ? "max-h-[70vh]" : "w-full",
            )}
          />
          <AiBadge ai={asset.ai} className="top-2 left-2" />
        </div>
      );
    }
    return step.asset === "document" ? (
      <HtmlFrame src={assetUrl(asset.id)} page={820} height={1100} />
    ) : (
      <HtmlFrame src={assetUrl(asset.id)} page={null} height={760} />
    );
  }
  if (step.type === "agent") {
    const images =
      output.assets?.filter((a) => a.kind !== "file" && a.mime.startsWith("image/")) ?? [];
    const files = output.assets?.filter((a) => a.kind === "file") ?? [];
    return (
      <div className="flex flex-col gap-4">
        {step.output.format === "json" && output.json !== undefined ? (
          <JsonView step={step} json={output.json} />
        ) : editable ? (
          <Textarea
            value={draft ?? output.text ?? ""}
            onChange={(e) => onDraft?.(e.target.value)}
            minRows={4}
            maxRows={24}
          />
        ) : step.output.format === "markdown" ? (
          <Markdown text={output.text ?? ""} />
        ) : (
          <div className="whitespace-pre-wrap text-[1rem] leading-relaxed">{output.text}</div>
        )}
        {images.map((img) => (
          <div key={img.id} className="relative">
            <img
              src={assetUrl(img.id)}
              alt=""
              className="w-full rounded-lg ring-1 ring-border-soft"
            />
            <AiBadge ai={img.ai} />
          </div>
        ))}
        {files.length ? (
          <ul className="overflow-hidden rounded-lg ring-1 ring-border-soft">
            {files.map((f) => (
              <li key={f.id} className="border-border-soft border-b last:border-0">
                <a
                  href={assetUrl(f.id)}
                  download={f.name}
                  onClick={(e) => appDownload(e, assetUrl(f.id), f.name)}
                  className="flex items-center gap-2 px-3 py-2 text-[0.8125rem] hover:bg-paper-2 coarse:min-h-11"
                >
                  <FileText className="size-3.5 shrink-0 text-ink-3" />
                  <span className="min-w-0 flex-1 truncate">{f.name}</span>
                </a>
              </li>
            ))}
          </ul>
        ) : null}
        {step.output.format !== "json" && !editable && output.text ? (
          <div>
            <CopyButton text={output.text} />
          </div>
        ) : null}
      </div>
    );
  }
  return null;
}

/** A download format as a person reads it. */
export const FORMAT_LABEL: Record<Format, string> = {
  png: "PNG",
  mp4: "MP4",
  mp3: "MP3",
  pdf: "PDF",
  docx: "Word",
  html: "HTML",
  md: "Markdown",
  txt: "Text",
  csv: "CSV",
  xlsx: "Excel",
  json: "JSON",
  zip: "ZIP",
};

/** The file's name as the server sends it, for the share sheet and "Save to Files". */
function downloadName(res: Response, fallback: string): string {
  const header = res.headers.get("content-disposition") ?? "";
  return header.match(/filename="([^"]+)"/)?.[1] ?? fallback;
}

/** A file made in the browser, saved as a download would be. */
function saveFile(file: File) {
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Hands a result to the phone's share sheet as a file — Mail, WhatsApp, "Save to Files", "Open
 * in …". The file is fetched first (or made here); when that took longer than the browser lets
 * a tap wait, a second tap sends it.
 */
function ShareFileButton({
  url,
  format,
  title,
  make,
}: {
  url: string;
  format: Format;
  title?: string;
  /** The file made in the browser instead of fetched: a written output's PDF on a site. */
  make?: () => Promise<File>;
}) {
  const [state, setState] = useState<"idle" | "busy" | "ready">("idle");
  const file = useRef<File | null>(null);
  const share = async () => {
    if (appCan("share") && !make) {
      // The app fetches the file itself and opens the native share sheet with it.
      setState("busy");
      await appCall("share", { url: new URL(url, location.href).href, title }).catch(
        () => undefined,
      );
      setState("idle");
      return;
    }
    try {
      if (!file.current) {
        setState("busy");
        if (make) {
          file.current = await make();
        } else {
          const res = await fetch(url, { credentials: "include" });
          if (!res.ok) {
            throw new Error(String(res.status));
          }
          const blob = await res.blob();
          file.current = new File([blob], downloadName(res, `download.${format}`), {
            type: blob.type.split(";")[0],
          });
        }
      }
      const data = { files: [file.current], title };
      if (!navigator.canShare(data)) {
        // A type the share sheet does not take: it is downloaded instead.
        if (make) {
          saveFile(file.current);
        } else {
          location.href = url;
        }
        setState("idle");
        return;
      }
      await navigator.share(data);
      setState("idle");
    } catch (err) {
      // Fetched, but the tap is too long ago for the browser: the next tap shares at once.
      setState(file.current && (err as DOMException).name === "NotAllowedError" ? "ready" : "idle");
    }
  };
  return (
    <button
      type="button"
      onClick={() => void share()}
      disabled={state === "busy"}
      aria-label={t("run.shareFile")}
      title={t("run.shareFile")}
      className={cn(
        "inline-flex h-9 items-center gap-1.5 rounded-full px-3 font-medium text-[0.8125rem] transition coarse:h-11 coarse:px-4",
        state === "ready"
          ? "bg-ember-tint text-ink ring-1 ring-ember"
          : "bg-paper-2 text-ink-2 hover:bg-paper-3 hover:text-ink",
      )}
    >
      {state === "busy" ? <Spinner className="size-3.5" /> : <Share className="size-3.5" />}
      {state === "ready" ? t("run.shareNow") : t("run.share")}
    </button>
  );
}

const SHARES_FILES = appCan("share") || canShareFiles();

export function DownloadButtons({
  base,
  stepId,
  formats,
  title,
  step,
  output,
  foot,
}: {
  base: string;
  stepId: string;
  formats: Format[];
  /** Named in the share sheet. */
  title?: string;
  /** The step and its output: on a standalone host a written output's PDF is made here. */
  step?: Step;
  output?: StepOutput;
  /** The foot of a PDF made here: the wizard, the date. */
  foot?: string;
}) {
  const href = (f: Format) => withBase(`${base}/steps/${stepId}/download?format=${f}`);
  const [busy, setBusy] = useState(false);
  const made = useRef<File | null>(null);
  // The server of a standalone host writes no PDF: a written output's PDF is made in the browser.
  const written: Written | null =
    standalone() && step?.type === "agent" && output && (output.text || output.json !== undefined)
      ? {
          title: title ?? step.title,
          text: output.text,
          json: step.output.format === "json" ? output.json : undefined,
          label: (key) => labelFor(step, key),
          foot,
        }
      : null;
  const makePdf = async () => {
    if (!written) {
      throw new Error("nothing written");
    }
    made.current ??= await writePdf(written);
    return made.current;
  };
  const savePdf = async () => {
    setBusy(true);
    try {
      saveFile(await makePdf());
    } catch (err) {
      console.warn(`pdf: ${(err as Error).message}`);
      // Without the library (offline, a blocked script): the page to print stands in.
      if (formats.includes("html")) {
        window.open(href("html"), "_blank", "noopener");
      }
    } finally {
      setBusy(false);
    }
  };
  const look = (i: number) =>
    cn(
      "inline-flex h-9 items-center gap-1.5 rounded-full px-3.5 font-medium text-[0.8125rem] transition coarse:h-11 coarse:px-4",
      i === 0
        ? "bg-primary text-primary-foreground hover:brightness-105"
        : "bg-paper-2 text-ink-2 hover:bg-paper-3 hover:text-ink",
    );
  const inBrowser = (f: Format) => f === "pdf" && written !== null;
  return (
    <div className="flex flex-wrap gap-2">
      {formats.map((f, i) =>
        inBrowser(f) ? (
          <button
            key={f}
            type="button"
            onClick={() => void savePdf()}
            disabled={busy}
            className={look(i)}
          >
            {busy ? (
              <Spinner className="size-3.5" />
            ) : i === 0 ? (
              <Download className="size-3.5" />
            ) : null}
            {FORMAT_LABEL[f]}
          </button>
        ) : f === "html" && standalone() ? (
          // On a site the HTML of a result is a page to print, opened beside the run.
          <a key={f} href={href(f)} target="_blank" rel="noopener" className={look(i)}>
            {i === 0 ? <Printer className="size-3.5" /> : null}
            {t("run.print")}
          </a>
        ) : (
          <a key={f} href={href(f)} onClick={(e) => appDownload(e, href(f))} className={look(i)}>
            {i === 0 ? <Download className="size-3.5" /> : null}
            {FORMAT_LABEL[f]}
          </a>
        ),
      )}
      {SHARES_FILES && formats.length ? (
        <ShareFileButton
          key={href(formats[0])}
          url={href(formats[0])}
          format={formats[0]}
          title={title}
          make={inBrowser(formats[0]) ? makePdf : undefined}
        />
      ) : null}
    </div>
  );
}
