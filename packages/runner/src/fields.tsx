import {
  type CardOption,
  type Field,
  itemsTotals,
  MAX_FILES,
  type ModelClass,
  slotDayText,
  slotTime,
} from "@engenty-wizards/shared/definition";
import { formatMoney } from "@engenty-wizards/shared/numbers";
import type { ClosedChoice, RunView } from "@engenty-wizards/shared/run";
import {
  Camera,
  Film,
  GripVertical,
  ImagePlus,
  Paperclip,
  Plus,
  ScanLine,
  Trash2,
  Video,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { CameraDialog, canRecordClips, shrinkImage } from "./camera";
import { canUseMedia, isTouch } from "./device";
import { api, runBase, withBase } from "./env.js";
import { choiceLabel, lang, t } from "./i18n.js";
import { LocationField } from "./location";
import { ScanDialog } from "./scan";
import { SignatureField } from "./signature";
import { ConnectionField, ListTable } from "./store";
import { cn, IconButton, Input, Label, Segmented, Select, Swatch, Switch, Textarea } from "./ui.js";
import { VoiceField } from "./voice";

export type Values = Record<string, unknown>;

function ItemsField({
  field,
  value,
  values,
  onChange,
}: {
  field: Field;
  value: unknown;
  values: Values;
  onChange: (v: unknown) => void;
}) {
  const cols = field.columns ?? [];
  const rows = (Array.isArray(value) && value.length ? value : [{}]) as Record<string, unknown>[];
  const totals = itemsTotals(field, rows, values);
  const set = (i: number, col: string, v: string) => {
    const next = rows.map((r, j) => (j === i ? { ...r, [col]: v } : r));
    onChange(next);
  };
  const grid = cols
    .map((c) => (c.kind === "text" && c === cols[0] ? "minmax(0,3fr)" : "minmax(0,1fr)"))
    .join(" ");
  return (
    <div className="rounded-xl bg-card p-2 ring-1 ring-input">
      <div
        className="hidden gap-2 px-2 pt-1 pb-2 text-[0.75rem] text-ink-3 sm:grid"
        style={{ gridTemplateColumns: `${grid} 36px` }}
      >
        {cols.map((c) => (
          <div key={c.id} className={c.kind === "text" ? "" : "text-right"}>
            {c.label}
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-2">
        {rows.map((row, i) => (
          // A phone shows each row as a card: the first column across, the rest side by side
          // under their labels. From tablet width up it is one table row.
          <div
            key={i}
            className="grid grid-cols-6 gap-2 rounded-lg bg-paper p-2 sm:bg-transparent sm:p-0 sm:[grid-template-columns:var(--cols)]"
            style={{ "--cols": `${grid} 36px` } as React.CSSProperties}
          >
            {cols.map((c, ci) => (
              <label
                key={c.id}
                className={cn(
                  "flex min-w-0 flex-col gap-1 sm:col-span-1",
                  ci === 0 ? "col-span-5" : cols.length - 1 <= 2 ? "col-span-3" : "col-span-2",
                )}
              >
                <span className="px-0.5 text-[0.6875rem] text-ink-3 sm:hidden">{c.label}</span>
                <input
                  aria-label={c.label}
                  placeholder={c.label}
                  inputMode={c.kind === "text" ? "text" : "decimal"}
                  autoComplete="off"
                  value={String(row[c.id] ?? "")}
                  onChange={(e) => set(i, c.id, e.target.value)}
                  className={cn(
                    "h-11 w-full min-w-0 rounded-md border border-transparent bg-paper-2 px-2.5 text-[0.875rem] outline-none placeholder:text-transparent focus:border-focus focus:bg-card sm:placeholder:text-ink-4",
                    c.kind !== "text" && "text-right tabular-nums",
                  )}
                />
              </label>
            ))}
            <IconButton
              label={t("list.delete")}
              onClick={() => onChange(rows.filter((_, j) => j !== i))}
              className="order-first col-start-6 row-start-1 size-11 justify-self-end self-end sm:order-none sm:col-start-auto sm:row-start-auto"
            >
              <Trash2 className="size-4" />
            </IconButton>
          </div>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-end justify-between gap-3 px-2 pb-1">
        <button
          type="button"
          onClick={() => onChange([...rows, {}])}
          className="inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-[0.8125rem] text-ink-2 hover:bg-accent coarse:h-11"
        >
          <Plus className="size-4" /> {t("run.addRow")}
        </button>
        <div className="text-right text-[0.8125rem] tabular-nums">
          <div className="text-ink-3">
            {t("run.net")} {formatMoney(totals.net, totals.currency, lang)}
          </div>
          {totals.vatRate ? (
            <div className="text-ink-3">
              {t("run.vat", { r: totals.vatRate })} {formatMoney(totals.vat, totals.currency, lang)}
            </div>
          ) : null}
          <div className="font-semibold text-[0.9375rem] text-ink">
            {t("run.total")} {formatMoney(totals.gross, totals.currency, lang)}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Whether a paste belongs to typing somewhere rather than to an upload field. */
function typingTarget(el: Element | null): boolean {
  return Boolean(el?.closest("input, textarea, [contenteditable='true']"));
}

function UploadField({
  field,
  value,
  runId,
  onChange,
  onBusy,
}: {
  field: Field;
  value: unknown;
  runId: string;
  onChange: (v: unknown) => void;
  onBusy?: (busy: boolean) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const nativeCamera = useRef<HTMLInputElement>(null);
  const nativeVideo = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [names, setNames] = useState<Record<string, { name: string; mime: string }>>({});
  const [error, setError] = useState<string | null>(null);
  const [camera, setCamera] = useState(false);
  const [over, setOver] = useState(false);
  // The file being dragged to another place in the list. The ref is what the pointer handlers
  // read: a move can arrive before the state has rendered.
  const [dragging, setDragging] = useState<string | null>(null);
  const drag = useRef<string | null>(null);
  const grab = (id: string | null) => {
    drag.current = id;
    setDragging(id);
  };
  const image = field.kind === "image";
  const multiple = Boolean(field.multiple);
  const most = multiple ? (field.max ?? MAX_FILES) : 1;
  const withCamera = image || Boolean(field.camera) || Boolean(field.video);
  const clips = !image && Boolean(field.video);
  const ids = Array.isArray(value)
    ? (value as string[])
    : typeof value === "string" && value
      ? [value]
      : [];
  // The list as it is now, not as it was when an upload started: several can finish in a row.
  const current = useRef(ids);
  current.current = ids;
  const room = ids.length < most;

  const add = async (files: File[]) => {
    // Several picked at once arrive in whatever order the file dialog likes; by name, pictures
    // from a camera are in the order they were taken.
    const wanted = (image ? files.filter((f) => f.type.startsWith("image/")) : files).sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true }),
    );
    if (!wanted.length) {
      return;
    }
    const free = most - (multiple ? current.current.length : 0);
    setBusy(true);
    onBusy?.(true);
    setError(wanted.length > free && multiple ? t("run.maxFiles", { n: most }) : null);
    try {
      for (const raw of wanted.slice(0, Math.max(0, free))) {
        const file = await shrinkImage(raw);
        const ref = await api.upload<{ id: string; name: string; mime: string }>(
          `${runBase(runId)}/uploads`,
          file,
        );
        setNames((n) => ({ ...n, [ref.id]: { name: ref.name, mime: ref.mime } }));
        const next = multiple ? [...current.current, ref.id] : ref.id;
        current.current = multiple ? (next as string[]) : [ref.id];
        onChange(next);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      onBusy?.(false);
    }
  };
  const adding = useRef(add);
  adding.current = add;
  const remove = (id: string) => {
    const left = ids.filter((x) => x !== id);
    onChange(multiple ? left : undefined);
  };
  // The order is part of the answer (the rooms of a tour, the pages of a document).
  const move = (id: string, to: number) => {
    const from = current.current.indexOf(id);
    const at = Math.min(current.current.length - 1, Math.max(0, to));
    if (from < 0 || from === at) {
      return;
    }
    const next = current.current.filter((x) => x !== id);
    next.splice(at, 0, id);
    current.current = next;
    onChange(next);
  };
  const sortable = multiple && ids.length > 1;

  // A screenshot or a copied picture is pasted straight in: into the field the pointer is on,
  // or the page's only upload field. Typing in a text field keeps its own paste.
  useEffect(() => {
    if (!room) {
      return;
    }
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []);
      const el = root.current;
      if (!files.length || !el || typingTarget(document.activeElement)) {
        return;
      }
      const fields = document.querySelectorAll("[data-upload-field]");
      if (el.matches(":hover") || el.contains(document.activeElement) || fields.length === 1) {
        e.preventDefault();
        void adding.current(files);
      }
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [room]);

  const tile = cn(
    "flex flex-col items-center justify-center gap-2 rounded-xl border border-input border-dashed bg-card px-3 text-[0.875rem] text-ink-3 transition hover:border-ember hover:text-ink",
    ids.length ? "py-4" : "py-8",
  );
  return (
    <div
      ref={root}
      data-upload-field=""
      onDragOver={(e) => {
        if (room) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        if (room) {
          e.preventDefault();
          void add(Array.from(e.dataTransfer.files));
        }
      }}
    >
      {ids.length ? (
        <div className="mb-2 flex flex-col gap-2">
          {ids.map((id, index) => {
            const known = names[id];
            const mime = known?.mime ?? (image ? "image/" : "");
            return (
              <div
                key={id}
                data-file-id={id}
                className={cn(
                  "flex items-center gap-3 rounded-xl bg-card p-2 ring-1 ring-input transition-shadow",
                  dragging === id && "relative z-10 shadow-elevated ring-2 ring-ember",
                )}
              >
                {sortable ? (
                  <button
                    type="button"
                    aria-label={t("run.moveFile", { n: index + 1 })}
                    title={t("run.moveFileHint")}
                    className={cn(
                      "-mr-1 flex h-14 w-9 shrink-0 touch-none flex-col items-center justify-center gap-0.5 rounded-lg text-ink-3 hover:bg-paper-2 hover:text-ink",
                      dragging === id ? "cursor-grabbing" : "cursor-grab",
                    )}
                    onPointerDown={(e) => {
                      try {
                        e.currentTarget.setPointerCapture(e.pointerId);
                      } catch {
                        // Without capture the drag still works while the pointer stays on the list.
                      }
                      grab(id);
                    }}
                    onPointerMove={(e) => {
                      if (drag.current !== id) {
                        return;
                      }
                      // The row under the pointer gives its place to the one being dragged.
                      const row = document
                        .elementFromPoint(e.clientX, e.clientY)
                        ?.closest("[data-file-id]");
                      const other = row?.getAttribute("data-file-id");
                      if (other && other !== id && root.current?.contains(row ?? null)) {
                        move(id, current.current.indexOf(other));
                      }
                    }}
                    onPointerUp={() => grab(null)}
                    onPointerCancel={() => grab(null)}
                    onKeyDown={(e) => {
                      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                        e.preventDefault();
                        move(id, index + (e.key === "ArrowUp" ? -1 : 1));
                      }
                    }}
                  >
                    <span className="font-medium text-[0.75rem] tabular-nums">{index + 1}</span>
                    <GripVertical className="size-4" />
                  </button>
                ) : null}
                {mime.startsWith("image/") ? (
                  <img
                    src={withBase(`${runBase(runId)}/assets/${id}`)}
                    alt=""
                    className="size-14 rounded-lg object-cover"
                  />
                ) : (
                  <div className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-paper-2">
                    {mime.startsWith("video/") ? (
                      <Film className="size-5 text-ink-3" />
                    ) : (
                      <Paperclip className="size-5 text-ink-3" />
                    )}
                  </div>
                )}
                <div className="min-w-0 flex-1 truncate text-[0.875rem]">{known?.name ?? "✓"}</div>
                <IconButton label={t("run.removeFile")} onClick={() => remove(id)}>
                  <X className="size-4" />
                </IconButton>
              </div>
            );
          })}
        </div>
      ) : null}
      {room ? (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => picker.current?.click()}
            className={cn(tile, "min-w-[9rem] flex-1 px-4", over && "border-ember text-ink")}
          >
            {image ? <ImagePlus className="size-6" /> : <Paperclip className="size-6" />}
            {busy
              ? t("run.uploading")
              : ids.length
                ? t("run.uploadMore")
                : t(isTouch ? "run.uploadTouch" : "run.upload")}
          </button>
          {withCamera ? (
            <button
              type="button"
              onClick={() => (canUseMedia ? setCamera(true) : nativeCamera.current?.click())}
              className={cn(tile, "w-28")}
            >
              <Camera className="size-6" />
              {t("run.camera")}
            </button>
          ) : null}
          {/* Where the browser cannot record a clip itself, the phone's camera app does. */}
          {clips && !(canUseMedia && canRecordClips) ? (
            <button
              type="button"
              onClick={() => nativeVideo.current?.click()}
              className={cn(tile, "w-28")}
            >
              <Video className="size-6" />
              {t("camera.video")}
            </button>
          ) : null}
        </div>
      ) : null}
      <input
        ref={picker}
        type="file"
        hidden
        multiple={multiple}
        accept={image ? "image/*" : undefined}
        onChange={(e) => {
          void add(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />
      <input
        ref={nativeCamera}
        type="file"
        hidden
        accept="image/*"
        capture="environment"
        onChange={(e) => {
          void add(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />
      {clips ? (
        <input
          ref={nativeVideo}
          type="file"
          hidden
          accept="video/*"
          capture="environment"
          onChange={(e) => {
            void add(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
      ) : null}
      <CameraDialog
        open={camera}
        multiple={multiple}
        video={clips}
        onClose={() => setCamera(false)}
        onCapture={(file) => add([file])}
        onNative={() => nativeCamera.current?.click()}
      />
      {multiple && (field.min || field.max) ? (
        <div className="mt-2 text-[0.8125rem] text-ink-3 tabular-nums">
          {field.min && ids.length < field.min
            ? t("run.filesMin", { n: ids.length, min: field.min })
            : field.max
              ? t("run.filesOf", { n: ids.length, max: field.max })
              : null}
        </div>
      ) : null}
      {error ? <div className="mt-2 text-[0.8125rem] text-rose">{error}</div> : null}
    </div>
  );
}

/**
 * What the keyboard should offer for a short text: a label that asks for a phone number gets the
 * number pad, a name gets the person's own from autofill. Guessed from the field's id and label.
 */
export function textHints(field: Field): React.InputHTMLAttributes<HTMLInputElement> {
  const key = `${field.id} ${field.label}`.toLowerCase();
  if (/telefon|phone|handy|mobil(?!it)|\btel\b|rückruf/.test(key)) {
    return { type: "tel", inputMode: "tel", autoComplete: "tel" };
  }
  if (/\bplz\b|postleitzahl|postal|zip/.test(key)) {
    return { inputMode: "numeric", autoComplete: "postal-code" };
  }
  if (/iban/.test(key)) {
    return { autoCapitalize: "characters", autoCorrect: "off", spellCheck: false };
  }
  if (/vorname|first.?name/.test(key)) {
    return { autoComplete: "given-name", autoCapitalize: "words" };
  }
  if (/nachname|last.?name|surname/.test(key)) {
    return { autoComplete: "family-name", autoCapitalize: "words" };
  }
  if (/firma|unternehmen|company|organi[sz]ation/.test(key)) {
    return { autoComplete: "organization", autoCapitalize: "words" };
  }
  if (/straße|strasse|street|anschrift|adresse|address/.test(key)) {
    return { autoComplete: "street-address", autoCapitalize: "words" };
  }
  if (/\b(ort|stadt|city|town)\b/.test(key)) {
    return { autoComplete: "address-level2", autoCapitalize: "words" };
  }
  if (/\bname\b|ansprechp/.test(key)) {
    return { autoComplete: "name", autoCapitalize: "words" };
  }
  return { autoCapitalize: "sentences" };
}

/** A short text that can also be filled by pointing the camera at a QR code or barcode. */
function ScanInput({
  field,
  value,
  onChange,
}: {
  field: Field;
  value: string;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex gap-2">
      <Input
        value={value}
        placeholder={field.placeholder}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex h-11 shrink-0 items-center gap-2 rounded-lg border border-input bg-card px-3.5 font-medium text-[0.875rem] text-ink-2 transition hover:border-ember hover:text-ink"
      >
        <ScanLine className="size-4" /> {t("scan.button")}
      </button>
      <ScanDialog open={open} onClose={() => setOpen(false)} onResult={onChange} />
    </div>
  );
}

/** How many days of offered times show before "Show later times". */
const SLOT_DAYS = 4;

/** Offered times by calendar day, in their own offset (the business's clock), earliest first. */
function slotDays(options: string[]) {
  const days = new Map<string, { label: string; times: { value: string; time: string }[] }>();
  const sorted = options
    .map((value) => ({ value, slot: slotTime(value) }))
    .filter((o) => o.slot)
    .sort((a, b) => Date.parse(a.value) - Date.parse(b.value));
  for (const { value, slot } of sorted) {
    if (!slot) {
      continue;
    }
    const day = days.get(slot.day) ?? { label: slotDayText(value, lang), times: [] };
    day.times.push({ value, time: slot.time });
    days.set(slot.day, day);
  }
  return [...days.values()];
}

/**
 * One appointment time from those offered: a small heading per day, the times under it as
 * chips. The chips are one group of radio buttons — the arrow keys move between the times shown.
 */
function SlotField({
  name,
  label,
  options,
  value,
  onChange,
  disabled,
}: {
  name: string;
  label: string;
  options: string[];
  value: string;
  onChange: (v: string) => void;
  disabled: Set<string>;
}) {
  const days = slotDays(options);
  const chosenDay = days.findIndex((d) => d.times.some((tm) => tm.value === value));
  const [all, setAll] = useState(chosenDay >= SLOT_DAYS);
  if (!days.length) {
    return <p className="text-[0.875rem] text-ink-3">{t("slot.none")}</p>;
  }
  const shown = all ? days : days.slice(0, SLOT_DAYS);
  return (
    <div className="flex flex-col gap-4">
      <fieldset className="flex min-w-0 flex-col gap-4">
        <legend className="sr-only">{label}</legend>
        {shown.map((day) => (
          <div key={day.label}>
            <div className="mb-2 font-medium text-[0.75rem] text-ink-3">{day.label}</div>
            <div className="flex flex-wrap gap-2">
              {day.times.map((tm) => (
                <label key={tm.value} className="relative">
                  <input
                    type="radio"
                    name={`slot-${name}`}
                    value={tm.value}
                    checked={tm.value === value}
                    disabled={disabled.has(tm.value)}
                    aria-label={`${day.label}, ${tm.time}`}
                    onChange={() => onChange(tm.value)}
                    className="peer sr-only"
                  />
                  <span
                    className={cn(
                      "inline-flex h-10 cursor-pointer items-center rounded-full border px-4 text-sm tabular-nums transition coarse:h-11",
                      "border-input bg-card text-ink-2 hover:border-ink-4 hover:text-ink",
                      "peer-checked:border-ember peer-checked:bg-ember-tint peer-checked:text-ink",
                      "peer-disabled:pointer-events-none peer-disabled:line-through peer-disabled:opacity-60",
                      "peer-focus-visible:outline-[1.5px] peer-focus-visible:outline-offset-2 peer-focus-visible:outline-(--focus-line) peer-focus-visible:outline-solid",
                    )}
                  >
                    {tm.time}
                  </span>
                </label>
              ))}
            </div>
          </div>
        ))}
      </fieldset>
      {days.length > shown.length ? (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="self-start text-[0.8125rem] text-ink-3 underline-offset-4 transition hover:text-ink hover:underline coarse:min-h-11"
        >
          {t("slot.later")}
        </button>
      ) : null}
    </div>
  );
}

/**
 * Choices drawn as cards: a picture, the title, a line under it, a price, and a page to open.
 * One or several of them, as the field is a select or a multiselect.
 */
function CardChoice({
  cards,
  value,
  multi,
  runId,
  onChange,
  disabled,
}: {
  cards: CardOption[];
  value: unknown;
  multi: boolean;
  runId: string;
  onChange: (v: unknown) => void;
  disabled: Set<string>;
}) {
  const picked = new Set<string>(
    multi
      ? Array.isArray(value)
        ? value.map(String)
        : []
      : value === undefined || value === null || value === ""
        ? []
        : [String(value)],
  );
  const toggle = (v: string) => {
    if (multi) {
      onChange(picked.has(v) ? [...picked].filter((x) => x !== v) : [...picked, v]);
    } else {
      onChange(picked.has(v) ? "" : v);
    }
  };
  const image = (src: string) =>
    /^(https?:|data:|\/)/.test(src) ? src : withBase(`/api/runs/${runId}/assets/${src}`);
  return (
    <div
      className="grid gap-3"
      style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 10.5rem), 1fr))" }}
    >
      {cards.map((c) => {
        const on = picked.has(c.value);
        const shut = disabled.has(c.value);
        return (
          <div
            key={c.value}
            className={cn(
              "flex flex-col overflow-hidden rounded-xl bg-card ring-1 ring-border-soft transition",
              on && "ring-2 ring-ember",
              shut && "opacity-50",
            )}
          >
            {c.image ? (
              <img src={image(c.image)} alt="" className="aspect-square w-full object-cover" />
            ) : null}
            <div className="flex flex-1 flex-col gap-1 p-3">
              <div className="font-medium text-[0.9375rem] leading-snug">{c.label}</div>
              {c.subtitle ? (
                <div className="text-[0.8125rem] text-ink-3 leading-snug">{c.subtitle}</div>
              ) : null}
              {c.meta ? (
                <div className="mt-auto pt-1 font-display font-semibold text-[0.9375rem] tabular-nums">
                  {c.meta}
                </div>
              ) : null}
              <div className="mt-2 flex flex-wrap gap-1.5">
                <button
                  type="button"
                  aria-pressed={on}
                  disabled={shut}
                  onClick={() => toggle(c.value)}
                  className={cn(
                    "inline-flex h-9 flex-1 items-center justify-center rounded-full px-3 text-[0.8125rem] transition coarse:h-11",
                    on ? "bg-ember text-ember-on" : "bg-paper-2 text-ink-2 hover:text-ink",
                  )}
                >
                  {on ? t("cards.picked") : t("cards.pick")}
                </button>
                {c.link ? (
                  <a
                    href={c.link}
                    target="_blank"
                    rel="noopener"
                    className="inline-flex h-9 items-center rounded-full px-3 text-[0.8125rem] text-ink-2 ring-1 ring-border-soft hover:text-ink coarse:h-11"
                  >
                    {t("cards.open")}
                  </a>
                ) : null}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function FieldInput({
  field,
  value,
  values,
  runId,
  view,
  onChange,
  onBusy,
  error,
  closed,
}: {
  field: Field;
  value: unknown;
  values: Values;
  runId: string;
  /** Answers that lead to a step this app has no model for: shown, not to be picked. */
  closed?: ClosedChoice;
  /** The run as the server sees it: connections, stored lists and card choices come from there. */
  view?: Pick<RunView, "connections" | "lists" | "cards">;
  onChange: (v: unknown) => void;
  /** The field is uploading or recording: the page waits with going on. */
  onBusy?: (busy: boolean) => void;
  error?: string;
}) {
  const str = value === undefined || value === null ? "" : String(value);
  const shut = new Set(closed?.values.map(String));
  let control: React.ReactNode;
  switch (field.kind) {
    case "textarea":
      control = (
        <Textarea
          value={str}
          placeholder={field.placeholder}
          autoCapitalize="sentences"
          enterKeyHint="enter"
          onChange={(e) => onChange(e.target.value)}
        />
      );
      break;
    case "number":
      control = (
        <Input
          inputMode="decimal"
          autoComplete="off"
          value={str}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      );
      break;
    case "select": {
      const options = field.options ?? [];
      const cards = view?.cards?.[field.id];
      control = cards?.length ? (
        <CardChoice
          cards={cards}
          value={value}
          multi={false}
          runId={runId}
          onChange={onChange}
          disabled={shut}
        />
      ) : options.length <= 5 && options.every((o) => o.length <= 28) ? (
        <Segmented
          value={str}
          options={options}
          onChange={onChange}
          disabled={[...shut]}
          label={choiceLabel}
        />
      ) : (
        <Select
          value={str}
          placeholder="—"
          onChange={onChange}
          options={options.map((o) => ({ value: o, label: choiceLabel(o), disabled: shut.has(o) }))}
        />
      );
      break;
    }
    case "slot":
      control = (
        <SlotField
          name={field.id}
          label={field.label}
          options={field.options ?? []}
          value={str}
          onChange={onChange}
          disabled={shut}
        />
      );
      break;
    case "multiselect": {
      const cards = view?.cards?.[field.id];
      control = cards?.length ? (
        <CardChoice
          cards={cards}
          value={value}
          multi
          runId={runId}
          onChange={onChange}
          disabled={shut}
        />
      ) : (
        <Segmented
          multi
          value={Array.isArray(value) ? (value as string[]) : []}
          options={field.options ?? []}
          onChange={onChange}
          label={choiceLabel}
        />
      );
      break;
    }
    case "date":
      control = (
        <Input
          type="date"
          value={str}
          onChange={(e) => onChange(e.target.value)}
          className="w-full sm:w-56"
        />
      );
      break;
    case "email":
      control = (
        <Input
          type="email"
          inputMode="email"
          autoComplete="email"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          value={str}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      );
      break;
    case "url":
      control = (
        <Input
          type="url"
          inputMode="url"
          autoComplete="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          value={str}
          placeholder={field.placeholder ?? "https://"}
          onChange={(e) => onChange(e.target.value)}
        />
      );
      break;
    case "toggle":
      control = (
        <Switch
          checked={value === true}
          onChange={onChange}
          label={field.label}
          disabled={shut.has(String(value !== true))}
        />
      );
      break;
    case "color":
      control = (
        <div className="flex items-center gap-3">
          <Swatch value={str || "#e0531b"} onChange={(e) => onChange(e.target.value)} />
          <Input
            value={str}
            placeholder="#e0531b"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => onChange(e.target.value)}
            className="w-36"
          />
        </div>
      );
      break;
    case "image":
    case "file":
      control = (
        <UploadField
          field={field}
          value={value}
          runId={runId}
          onChange={onChange}
          onBusy={onBusy}
        />
      );
      break;
    case "items":
      control = <ItemsField field={field} value={value} values={values} onChange={onChange} />;
      break;
    case "connection":
      control = (
        <ConnectionField
          runId={runId}
          connection={view?.connections.find((c) => c.id === field.connection)}
        />
      );
      break;
    case "list": {
      const list = view?.lists.find((l) => l.def.id === field.list);
      control = list ? <ListTable runId={runId} list={list} editable /> : null;
      break;
    }
    case "location":
      control = (
        <LocationField
          value={value}
          runId={runId}
          placeholder={field.placeholder}
          onChange={onChange}
          onBusy={onBusy}
        />
      );
      break;
    case "audio":
      // Nothing here can listen to it: the reason below stands in for the recorder.
      control = closed ? null : (
        <VoiceField value={value} runId={runId} onChange={onChange} onBusy={onBusy} />
      );
      break;
    case "signature":
      control = (
        <SignatureField label={field.label} value={value} runId={runId} onChange={onChange} />
      );
      break;
    default:
      control = field.scan ? (
        <ScanInput field={field} value={str} onChange={onChange} />
      ) : (
        <Input
          {...textHints(field)}
          value={str}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
  return (
    <div>
      {field.kind === "toggle" ? (
        <div className="flex items-start justify-between gap-6">
          <Label hint={field.help}>{field.label}</Label>
          {control}
        </div>
      ) : (
        <>
          <Label hint={field.help} required={field.required}>
            {field.label}
          </Label>
          {control}
        </>
      )}
      {closed ? (
        <div className="mt-1.5 text-[0.8125rem] text-ink-3">
          {t("run.closed", {
            list: closed.classes.map((c) => t(`run.cls.${groupOf(c)}`)).join(", "),
          })}
        </div>
      ) : null}
      {error ? <div className="mt-1.5 text-[0.8125rem] text-rose">{error}</div> : null}
    </div>
  );
}

/**
 * What a model class is called where a person reads that it is missing. A standalone site
 * names its groups directly, "account" among them: what only an engenty account would do.
 */
type ClassGroup = "text" | "image" | "video" | "speech" | "audio" | "account";

function groupOf(cls: string): ClassGroup {
  if (cls in CLASS_GROUP) {
    return CLASS_GROUP[cls as ModelClass];
  }
  return cls === "account" ? "account" : "text";
}

const CLASS_GROUP: Record<ModelClass, Exclude<ClassGroup, "account">> = {
  classifier: "text",
  standard: "text",
  high: "text",
  highest: "text",
  image: "image",
  video: "video",
  speech: "speech",
  audio: "audio",
};
