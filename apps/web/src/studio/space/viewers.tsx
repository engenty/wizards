// A file as it is: a PDF page by page (pdf.js), a workbook or CSV with its sheets (SheetJS), HTML
// in a sandboxed frame, a picture, text in CodeMirror. Loaded with the first file opened; nothing
// here knows where the file lives, so Dateien can show its files the same way. The workbook
// reading is peer-it's (packages/docs-ui/src/csv.ts).

import { EditorView } from "@codemirror/view";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { lang, t } from "../../lib/i18n";
import { cn, Spinner } from "../../ui";
import { CodeEditor } from "../../ui/code-editor";
import type { ViewerKind } from "./viewers-kind";

const BlockEditor = lazy(() =>
  import("./blocks/BlockEditor").then((m) => ({ default: m.BlockEditor })),
);

/** Larger files are not read here: the original opens in its own tab. */
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_TEXT = 2 * 1024 * 1024;

async function load(url: string, max: number): Promise<ArrayBuffer> {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`);
  }
  if (Number(res.headers.get("content-length") ?? 0) > max) {
    throw new TooLarge();
  }
  const bytes = await res.arrayBuffer();
  if (bytes.byteLength > max) {
    throw new TooLarge();
  }
  return bytes;
}

class TooLarge extends Error {}

/** What a viewer reads, with its loading and failing. */
function useLoaded<T>(read: () => Promise<T>, key: string) {
  const [state, setState] = useState<{ value?: T; error?: string }>({});
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key stands for what is read
  useEffect(() => {
    let live = true;
    setState({});
    read().then(
      (value) => live && setState({ value }),
      (err: unknown) =>
        live && setState({ error: err instanceof TooLarge ? t("viewer.tooLarge") : String(err) }),
    );
    return () => {
      live = false;
    };
  }, [key]);
  return state;
}

const frame = "h-[70dvh] w-full rounded-b-xl";

function Waiting() {
  return (
    <div className="flex h-40 items-center justify-center text-ink-3">
      <Spinner />
    </div>
  );
}

function Failed({ error }: { error: string }) {
  return <p className="px-4 py-8 text-center text-[0.875rem] text-ink-3">{error}</p>;
}

export function Viewer({
  kind,
  url,
  name,
  page,
  plain,
}: {
  kind: ViewerKind;
  url: string;
  name: string;
  /** Where to open: a PDF's page, a workbook's sheet (from 1). */
  page?: number;
  /** A Markdown file only read, without its switch to the Markdown: it stands on the page. */
  plain?: boolean;
}) {
  switch (kind) {
    case "pdf":
      return <PdfView url={url} page={page} />;
    case "image":
      return <img src={url} alt="" className="mx-auto max-h-[70dvh] object-contain p-4" />;
    case "sheet":
      return <SheetView url={url} name={name} sheet={page} />;
    case "html":
      return <HtmlView url={url} name={name} />;
    case "text":
      return /\.(md|markdown)$/i.test(name) ? (
        <MarkdownView url={url} name={name} plain={plain} />
      ) : (
        <TextView url={url} name={name} />
      );
  }
}

// --- PDF ------------------------------------------------------------------------------------------

type PdfDoc = import("pdfjs-dist").PDFDocumentProxy;

async function openPdf(url: string): Promise<PdfDoc> {
  const [pdfjs, worker] = await Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  return pdfjs.getDocument({ data: new Uint8Array(await load(url, MAX_BYTES)) }).promise;
}

/** A PDF page by page, as wide as the frame; a page is drawn when it comes near. */
function PdfView({ url, page }: { url: string; page?: number }) {
  const { value: doc, error } = useLoaded(() => openPdf(url), url);
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [ratio, setRatio] = useState(Math.SQRT2); // A4 until the first page says otherwise
  const [current, setCurrent] = useState(page ?? 1);

  useEffect(() => {
    const el = box.current;
    if (!el) {
      return;
    }
    const measure = () => setWidth(el.clientWidth - 32);
    measure();
    const seen = new ResizeObserver(measure);
    seen.observe(el);
    return () => seen.disconnect();
  }, []);

  useEffect(() => {
    void doc?.getPage(1).then((p) => {
      const v = p.getViewport({ scale: 1 });
      setRatio(v.height / v.width);
    });
    return () => {
      void doc?.loadingTask.destroy();
    };
  }, [doc]);

  // Opens at the page a search found, once the pages have their heights.
  useEffect(() => {
    if (!doc || !width || !page || page < 2) {
      return;
    }
    box.current?.querySelector(`[data-page="${page}"]`)?.scrollIntoView({ block: "start" });
  }, [doc, width, page]);

  return (
    <div className="relative">
      <div
        ref={box}
        className={cn(frame, "overflow-y-auto bg-paper-2")}
        onScroll={(e) => {
          const el = e.currentTarget;
          const pageHeight = width * ratio + 16;
          setCurrent(Math.min(doc?.numPages ?? 1, Math.floor(el.scrollTop / pageHeight + 0.5) + 1));
        }}
      >
        {error ? (
          <Failed error={error} />
        ) : !doc || !width ? (
          <Waiting />
        ) : (
          <div className="flex flex-col items-center gap-4 p-4">
            {Array.from({ length: doc.numPages }, (_, i) => (
              <PdfPage
                key={i + 1}
                doc={doc}
                n={i + 1}
                width={width}
                height={width * ratio}
                root={box.current}
              />
            ))}
          </div>
        )}
      </div>
      {doc && doc.numPages > 1 ? (
        <span className="pointer-events-none absolute right-4 bottom-3 rounded-full bg-ink/70 px-2.5 py-1 text-[0.75rem] text-paper tabular-nums">
          {t("viewer.pageOf", {
            n: current.toLocaleString(lang),
            total: doc.numPages.toLocaleString(lang),
          })}
        </span>
      ) : null}
    </div>
  );
}

function PdfPage({
  doc,
  n,
  width,
  height,
  root,
}: {
  doc: PdfDoc;
  n: number;
  width: number;
  height: number;
  root: HTMLElement | null;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = canvas.current;
    if (!el) {
      return;
    }
    const seen = new IntersectionObserver(([entry]) => setNear(Boolean(entry?.isIntersecting)), {
      root,
      rootMargin: "800px 0px",
    });
    seen.observe(el);
    return () => seen.disconnect();
  }, [root]);
  useEffect(() => {
    const el = canvas.current;
    if (!near || !el) {
      return;
    }
    let task: { cancel: () => void } | null = null;
    void doc.getPage(n).then((p) => {
      const base = p.getViewport({ scale: 1 });
      const scale = (width / base.width) * (window.devicePixelRatio || 1);
      const viewport = p.getViewport({ scale });
      el.width = Math.floor(viewport.width);
      el.height = Math.floor(viewport.height);
      const render = p.render({ canvas: el, viewport });
      task = render;
      render.promise.catch(() => undefined);
    });
    return () => task?.cancel();
  }, [near, doc, n, width]);
  return (
    <canvas
      ref={canvas}
      data-page={n}
      style={{ width, height }}
      className="shrink-0 bg-white shadow-[var(--shadow-ember-soft)]"
    />
  );
}

// --- workbooks and CSV ----------------------------------------------------------------------------

interface Sheet {
  name: string;
  /** Every row as the text the spreadsheet shows; no header. */
  rows: string[][];
}

/**
 * The sheets of a workbook (or the one of a CSV), each cell as the text the spreadsheet shows. A
 * formula without a computed result shows as the formula.
 */
async function readSheets(url: string, name: string): Promise<Sheet[]> {
  const [XLSX, bytes] = await Promise.all([import("xlsx"), load(url, MAX_BYTES)]);
  const text = /\.(csv|tsv)$/i.test(name);
  const book = text
    ? XLSX.read(new TextDecoder().decode(bytes), { type: "string", dense: true, raw: true })
    : XLSX.read(bytes, {
        type: "array",
        cellDates: true,
        dense: true,
        dateNF: "yyyy-mm-dd",
        // Keeps formula cells without a computed value (type "z").
        sheetStubs: true,
      });
  return book.SheetNames.map((sheetName) => {
    const sheet = book.Sheets[sheetName];
    const ref = sheet?.["!ref"];
    if (!sheet || !ref) {
      return { name: sheetName, rows: [] };
    }
    const range = XLSX.utils.decode_range(ref);
    const data = sheet["!data"] ?? [];
    const rows: string[][] = [];
    for (let r = range.s.r; r <= range.e.r; r++) {
      const row: string[] = [];
      for (let c = range.s.c; c <= range.e.c; c++) {
        const cell = data[r]?.[c];
        row.push(
          !cell
            ? ""
            : cell.t === "z"
              ? cell.f
                ? `=${cell.f}`
                : ""
              : (cell.w ?? String(cell.v ?? "")),
        );
      }
      rows.push(row);
    }
    while (rows.length && rows[rows.length - 1]?.every((v) => v === "")) {
      rows.pop();
    }
    const wide = Math.max(0, ...rows.map((r) => r.findLastIndex((v) => v !== "") + 1));
    return { name: sheetName, rows: rows.map((r) => r.slice(0, wide)) };
  });
}

/** Column letters as a spreadsheet names them: A … Z, AA … */
function columnName(n: number) {
  let out = "";
  let i = n;
  do {
    out = String.fromCharCode(65 + (i % 26)) + out;
    i = Math.floor(i / 26) - 1;
  } while (i >= 0);
  return out;
}

const SHOWN_ROWS = 1000;

function SheetView({ url, name, sheet }: { url: string; name: string; sheet?: number }) {
  const { value: sheets, error } = useLoaded(() => readSheets(url, name), url);
  const [tab, setTab] = useState(Math.max(0, (sheet ?? 1) - 1));
  if (error) {
    return <Failed error={error} />;
  }
  if (!sheets) {
    return <Waiting />;
  }
  const shown = sheets[tab] ?? sheets[0];
  // A CSV's first line names its columns; a workbook's sheet is shown with letters.
  const csv = /\.(csv|tsv)$/i.test(name);
  const head = csv ? (shown?.rows[0] ?? []) : null;
  const body = (csv ? shown?.rows.slice(1) : shown?.rows) ?? [];
  const width = Math.max(head?.length ?? 0, ...body.map((r) => r.length));
  return (
    <div className="flex flex-col">
      {sheets.length > 1 ? (
        <div className="flex gap-1 overflow-x-auto border-border-soft border-b px-2 py-1.5">
          {sheets.map((s, i) => (
            <button
              key={s.name}
              type="button"
              aria-pressed={i === tab}
              onClick={() => setTab(i)}
              className={cn(
                "shrink-0 rounded-md px-2.5 py-1 text-[0.8125rem] transition",
                i === tab ? "bg-paper-2 font-medium text-ink" : "text-ink-3 hover:text-ink",
              )}
            >
              {s.name}
            </button>
          ))}
        </div>
      ) : null}
      <div className="max-h-[70dvh] overflow-auto">
        <table className="border-separate border-spacing-0 text-[0.8125rem]">
          <thead className="sticky top-0 z-[1] bg-card">
            <tr>
              <th className="sticky left-0 z-[1] border-border-soft border-r border-b bg-card px-2 py-1" />
              {Array.from({ length: width }, (_, c) => (
                <th
                  key={c}
                  className="whitespace-nowrap border-border-soft border-r border-b px-2 py-1 text-left font-medium text-ink-3"
                >
                  {head ? head[c] : columnName(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.slice(0, SHOWN_ROWS).map((row, r) => (
              <tr key={r}>
                <td className="sticky left-0 border-border-soft border-r border-b bg-card px-2 py-1 text-right text-ink-4 tabular-nums">
                  {r + (csv ? 2 : 1)}
                </td>
                {Array.from({ length: width }, (_, c) => (
                  <td
                    key={c}
                    className="max-w-80 truncate whitespace-nowrap border-border-soft border-r border-b px-2 py-1 text-ink-2"
                    title={row[c] && row[c].length > 40 ? row[c] : undefined}
                  >
                    {row[c]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {body.length > SHOWN_ROWS ? (
          <p className="px-3 py-2 text-[0.8125rem] text-ink-3">
            {t("viewer.moreRows", { n: body.length - SHOWN_ROWS })}
          </p>
        ) : null}
      </div>
    </div>
  );
}

// --- HTML and text --------------------------------------------------------------------------------

const decode = async (url: string, max: number) => new TextDecoder().decode(await load(url, max));

/** HTML in a frame of its own origin: its scripts run, but reach nothing of the studio. */
function HtmlView({ url, name }: { url: string; name: string }) {
  const { value: html, error } = useLoaded(() => decode(url, MAX_TEXT), url);
  if (error) {
    return <Failed error={error} />;
  }
  if (html === undefined) {
    return <Waiting />;
  }
  return (
    <iframe
      srcDoc={html}
      title={name}
      sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      className={cn(frame, "bg-white")}
    />
  );
}

// --- Markdown -------------------------------------------------------------------------------------

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** A Markdown file's front matter as label and value, one per `key: value` line, and the rest. */
function splitFrontMatter(text: string): { props: [string, string][]; body: string } {
  const match = text.match(FRONT_MATTER);
  if (!match) {
    return { props: [], body: text };
  }
  const props = match[1]
    .split(/\r?\n/)
    .map((line) => line.match(/^([\w.-]+):\s*(.*)$/))
    .filter((m): m is RegExpMatchArray => Boolean(m))
    .map((m): [string, string] => [m[1], m[2].replace(/^["']|["']$/g, "")]);
  return { props, body: text.slice(match[0].length) };
}

const isExternal = (href: string) => /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//");

/**
 * A Markdown file as it reads, as peer-it shows one: the block editor without editing, its front
 * matter as properties above it; „Markdown“ shows the file as it is.
 */
function MarkdownView({ url, name, plain }: { url: string; name: string; plain?: boolean }) {
  const { value: text, error } = useLoaded(() => decode(url, MAX_TEXT), url);
  const [source, setSource] = useState(false);
  if (error) {
    return <Failed error={error} />;
  }
  if (text === undefined) {
    return <Waiting />;
  }
  const { props, body } = splitFrontMatter(text);
  const tab = (on: boolean, label: string, pick: () => void) => (
    <button
      type="button"
      aria-pressed={on}
      onClick={pick}
      className={cn(
        "rounded-md px-2.5 py-1 text-[0.8125rem] transition",
        on ? "bg-paper-2 font-medium text-ink" : "text-ink-3 hover:text-ink",
      )}
    >
      {label}
    </button>
  );
  return (
    <div className="flex flex-col">
      {plain ? null : (
        <div className="flex items-center gap-1 border-border-soft border-b px-2 py-1.5">
          {tab(!source, t("viewer.read"), () => setSource(false))}
          {tab(source, t("blocks.markdown"), () => setSource(true))}
        </div>
      )}
      {source ? (
        <TextView url={url} name={name} />
      ) : (
        <div className="flex flex-col">
          {props.length ? (
            <dl
              className={cn(
                "grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-[0.8125rem]",
                plain ? "px-1 pb-2" : "border-border-soft border-b px-5 py-3",
              )}
            >
              {props.map(([key, value]) => (
                <div key={key} className="contents">
                  <dt className="text-ink-3">{key}</dt>
                  <dd className="min-w-0 break-words text-ink-2">{value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          <Suspense fallback={<Waiting />}>
            <BlockEditor
              text={body}
              onChange={() => undefined}
              readOnly
              targets={[]}
              resolve={(src) => (isExternal(src) ? src : new URL(src, url).href)}
              onOpen={(href) => {
                if (isExternal(href)) {
                  window.open(href, "_blank", "noopener");
                }
              }}
              ariaLabel={name}
            />
          </Suspense>
        </div>
      )}
    </div>
  );
}

function TextView({ url, name }: { url: string; name: string }) {
  const { value: text, error } = useLoaded(() => decode(url, MAX_TEXT), url);
  if (error) {
    return <Failed error={error} />;
  }
  if (text === undefined) {
    return <Waiting />;
  }
  return (
    <CodeEditor
      value={text}
      onChange={() => undefined}
      readOnly
      extensions={[EditorView.editable.of(false)]}
      language={/\.json$/i.test(name) ? "json" : "markdown"}
      ariaLabel={name}
      className="max-h-[70dvh] overflow-auto sm:[&_.cm-content]:py-4 sm:[&_.cm-line]:px-4"
    />
  );
}
