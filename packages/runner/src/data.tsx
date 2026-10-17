import { type AgentStep, stepShape } from "@engenty-wizards/shared/definition";
import type { StepOutput } from "@engenty-wizards/shared/run";
import {
  type FieldShape,
  type ListShape,
  labelOf,
  type ObjectShape,
  shapeJsonSchema,
  titleKey,
} from "@engenty-wizards/shared/shape";
import {
  Braces,
  Check,
  ChevronRight,
  Copy,
  Database,
  Download,
  Link2,
  MoreVertical,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { api, runBase } from "./env.js";
import { t } from "./i18n.js";
import { Button, cn, Dialog, Tabs } from "./ui.js";

/**
 * A json step's data, shown and edited by its schema: lists of flat entries are tables as in
 * Space → Data; entries that hold lists of their own are cards that open; lists of words are
 * chips; a link to another list shows that entry's title. Ansicht · Bearbeiten · JSON.
 */

type Path = (string | number)[];
export type DataMode = "view" | "edit" | "json";
type Shape = FieldShape | ListShape["of"];
type Entry = Record<string, unknown>;

interface Ctx {
  root: Entry;
  shape: ObjectShape;
  edit: boolean;
  /** Prefix of the ids entries get, so two editors on one page do not meet. */
  scope: string;
  set: (path: Path, value: unknown) => void;
  open: (id: string) => void;
}

const cellField =
  "w-full min-w-0 rounded-md bg-transparent px-2 py-1.5 text-[0.875rem] outline-none transition placeholder:text-ink-4 hover:bg-accent focus:bg-paper focus:ring-1 focus:ring-ring";

const caption = "font-medium text-[0.6875rem] text-ink-3 uppercase tracking-[0.08em]";

const isEntry = (v: unknown): v is Entry =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v);

function setIn(value: unknown, path: Path, next: unknown): unknown {
  if (!path.length) {
    return next;
  }
  const [head, ...rest] = path;
  if (Array.isArray(value)) {
    const copy = [...value];
    copy[head as number] = setIn(copy[head as number], rest, next);
    return copy;
  }
  const obj = (value ?? {}) as Entry;
  return { ...obj, [head]: setIn(obj[head], rest, next) };
}

/** A table's rows as entries of text fields: its columns, or the keys its rows have. */
function tableShape(columns: string[] | undefined, rows: unknown[]): ObjectShape {
  const keys = columns?.length
    ? columns
    : [...new Set(rows.filter(isEntry).flatMap((r) => Object.keys(r)))];
  return { kind: "object", fields: Object.fromEntries(keys.map((k) => [k, { kind: "text" }])) };
}

/** Fields that fit in a table cell: no lists of entries, no long text. */
const flat = (s: Shape) =>
  s.kind !== "object" &&
  s.kind !== "table" &&
  !(s.kind === "list" && s.of.kind === "object") &&
  !(s.kind === "text" && s.long);

const isTable = (s: ObjectShape) => Object.values(s.fields).every(flat);

/** Entries without lists of their own but with long text: numbered rows (steps of a recipe). */
const isRows = (s: ObjectShape) =>
  Object.values(s.fields).every(
    (f) => f.kind !== "table" && !(f.kind === "list" && f.of.kind === "object"),
  );

/** An entry's name: its first short text. */
function titleOf(shape: ObjectShape, entry: Entry): string {
  const key = titleKey(shape);
  return key ? String(entry[key] ?? "") : "";
}

function Words({ text }: { text: string }) {
  return <span className="whitespace-pre-wrap">{text}</span>;
}

/** One value by its kind, shown or edited in place. */
function Value({
  shape,
  value,
  path,
  ctx,
  cell,
}: {
  shape: Shape;
  value: unknown;
  path: Path;
  ctx: Ctx;
  cell?: boolean;
}) {
  switch (shape.kind) {
    case "text":
      if (!ctx.edit) {
        return <Words text={value === null || value === undefined ? "" : String(value)} />;
      }
      return shape.long ? (
        <textarea
          className={cn(cellField, "field-sizing-content max-h-60 resize-none")}
          value={String(value ?? "")}
          onChange={(e) => ctx.set(path, e.target.value)}
        />
      ) : (
        <input
          className={cellField}
          value={String(value ?? "")}
          onChange={(e) => ctx.set(path, e.target.value)}
        />
      );
    case "number":
      return ctx.edit ? (
        <span className="flex items-center gap-1">
          <input
            type="number"
            className={cn(cellField, "text-right tabular-nums", cell && "w-20")}
            value={value === undefined || value === null ? "" : Number(value)}
            onChange={(e) => ctx.set(path, e.target.value === "" ? null : Number(e.target.value))}
          />
          {shape.unit ? <span className="text-[0.8125rem] text-ink-3">{shape.unit}</span> : null}
        </span>
      ) : (
        <span className="tabular-nums">
          {value === null || value === undefined
            ? ""
            : `${value}${shape.unit ? ` ${shape.unit}` : ""}`}
        </span>
      );
    case "yesno": {
      const word = value ? (shape.yes ?? t("data.yes")) : (shape.no ?? t("data.no"));
      return ctx.edit ? (
        <label className="flex items-center gap-2 px-2 py-1.5 text-[0.8125rem] text-ink-2">
          <input
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => ctx.set(path, e.target.checked)}
            className="size-4 accent-[var(--second)]"
          />
          {word}
        </label>
      ) : (
        <span
          className={cn(
            "inline-flex rounded-full px-2 py-0.5 text-[0.75rem]",
            value ? "bg-second-tint text-second" : "bg-paper-2 text-ink-3",
          )}
        >
          {word}
        </span>
      );
    }
    case "choice":
    case "score":
      return ctx.edit ? (
        <select
          className={cellField}
          value={String(value ?? "")}
          onChange={(e) => ctx.set(path, e.target.value)}
        >
          {[...new Set([String(value ?? ""), ...shape.options])].map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : (
        <span>{String(value ?? "")}</span>
      );
    case "ref": {
      const target = ctx.shape.fields[shape.to];
      const fields: ObjectShape =
        target?.kind === "list" && target.of.kind === "object"
          ? target.of
          : { kind: "object", fields: {} };
      const list = (Array.isArray(ctx.root[shape.to]) ? ctx.root[shape.to] : []) as unknown[];
      const entries = list.filter(isEntry);
      const hit = entries.find((e) => e.id === value);
      if (ctx.edit) {
        return (
          <select
            className={cellField}
            value={String(value ?? "")}
            onChange={(e) => ctx.set(path, e.target.value)}
          >
            {hit ? null : <option value={String(value ?? "")}>{String(value ?? "")}</option>}
            {entries.map((e) => (
              <option key={String(e.id)} value={String(e.id)}>
                {titleOf(fields, e) || String(e.id)}
              </option>
            ))}
          </select>
        );
      }
      return hit ? (
        <button
          type="button"
          onClick={() => ctx.open(String(hit.id))}
          className="inline-flex items-center gap-1 text-left text-ember-strong hover:underline"
        >
          <Link2 className="size-3.5 shrink-0" />
          {titleOf(fields, hit) || String(hit.id)}
        </button>
      ) : (
        <span className="text-rose">{t("data.missing", { id: String(value ?? "") })}</span>
      );
    }
    case "table": {
      const rows = Array.isArray(value) ? value : [];
      return (
        <EntryTable shape={tableShape(shape.columns, rows)} value={rows} path={path} ctx={ctx} />
      );
    }
    case "list":
      if (shape.of.kind === "object") {
        const of = shape.of;
        const Entries = isTable(of) ? EntryTable : isRows(of) ? EntryRows : EntryCards;
        return <Entries shape={of} value={value} path={path} ctx={ctx} />;
      }
      return <Chips value={value} path={path} ctx={ctx} />;
    case "object":
      return <Form shape={shape} value={value} path={path} ctx={ctx} />;
  }
}

function Chips({ value, path, ctx }: { value: unknown; path: Path; ctx: Ctx }) {
  const items = Array.isArray(value) ? value.map(String) : [];
  const [draft, setDraft] = useState("");
  return (
    <span className="flex flex-wrap items-center gap-1">
      {items.map((item, i) => (
        <span
          key={`${item}-${i}`}
          className="inline-flex items-center gap-1 rounded-full bg-paper-2 px-2 py-0.5 text-[0.75rem]"
        >
          {item}
          {ctx.edit ? (
            <button
              type="button"
              aria-label={t("data.remove")}
              onClick={() =>
                ctx.set(
                  path,
                  items.filter((_, j) => j !== i),
                )
              }
              className="text-ink-3 hover:text-ink"
            >
              <X className="size-3" />
            </button>
          ) : null}
        </span>
      ))}
      {ctx.edit ? (
        <input
          className="w-20 rounded-full bg-transparent px-2 py-0.5 text-[0.75rem] outline-none ring-1 ring-border-soft focus:ring-ring"
          placeholder="+"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && draft.trim()) {
              e.preventDefault();
              ctx.set(path, [...items, draft.trim()]);
              setDraft("");
            }
          }}
        />
      ) : null}
    </span>
  );
}

interface EntriesProps {
  shape: ObjectShape;
  value: unknown;
  path: Path;
  ctx: Ctx;
}

const entriesIn = (value: unknown) => (Array.isArray(value) ? value : []).filter(isEntry);

/** A new entry: an id where the entries have one, so a link can point at it. */
const fresh = (shape: ObjectShape): Entry =>
  shape.fields.id ? { id: `n${Date.now().toString(36)}` } : {};

/** Flat entries: a table as in Space → Data. */
function EntryTable({ shape, value, path, ctx }: EntriesProps) {
  const rows = entriesIn(value);
  const cols = Object.entries(shape.fields);
  return (
    <div className="overflow-x-auto rounded-lg ring-1 ring-border-soft">
      <table className="w-full border-collapse text-[0.8125rem]">
        <thead className="bg-paper-2 text-ink-2">
          <tr>
            {cols.map(([key, f]) => (
              <th key={key} className="whitespace-nowrap px-3 py-2 text-left font-medium">
                {labelOf(key, f)}
              </th>
            ))}
            {ctx.edit ? <th className="w-8" /> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="group border-border-soft border-t">
              {cols.map(([key, f]) => (
                <td key={key} className={cn("align-top", ctx.edit ? "p-0.5" : "px-3 py-2")}>
                  <Value shape={f} value={row[key]} path={[...path, i, key]} ctx={ctx} cell />
                </td>
              ))}
              {ctx.edit ? (
                <td className="p-0.5 align-middle">
                  <RemoveButton
                    onClick={() =>
                      ctx.set(
                        path,
                        rows.filter((_, j) => j !== i),
                      )
                    }
                  />
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
      {ctx.edit ? (
        <AddButton what={shape.label} onClick={() => ctx.set(path, [...rows, fresh(shape)])} />
      ) : null}
    </div>
  );
}

/** Entries with long text and no lists: numbered rows, the long text first, the rest beside it. */
function EntryRows({ shape, value, path, ctx }: EntriesProps) {
  const rows = entriesIn(value);
  const fields = Object.entries(shape.fields);
  const main = fields.filter(([, f]) => f.kind === "text" && f.long);
  const rest = fields.filter(([, f]) => !(f.kind === "text" && f.long));
  return (
    <div className="overflow-hidden rounded-lg ring-1 ring-border-soft">
      <ol>
        {rows.map((row, i) => (
          <li
            key={i}
            className="grid grid-cols-[1.75rem_1fr_auto] items-start gap-2 border-border-soft border-t px-3 py-2 first:border-0"
          >
            <span className="pt-1.5 font-display font-semibold text-ember-strong tabular-nums">
              {i + 1}
            </span>
            <div className={cn("flex min-w-0 flex-col", !ctx.edit && "pt-1")}>
              {main.map(([key, f]) => (
                <Value key={key} shape={f} value={row[key]} path={[...path, i, key]} ctx={ctx} />
              ))}
            </div>
            <div
              className={cn(
                "flex items-center gap-2 text-[0.8125rem] text-ink-3",
                !ctx.edit && "pt-1",
              )}
            >
              {rest.map(([key, f]) => (
                <Value
                  key={key}
                  shape={f}
                  value={row[key]}
                  path={[...path, i, key]}
                  ctx={ctx}
                  cell
                />
              ))}
              {ctx.edit ? (
                <RemoveButton
                  onClick={() =>
                    ctx.set(
                      path,
                      rows.filter((_, j) => j !== i),
                    )
                  }
                />
              ) : null}
            </div>
          </li>
        ))}
      </ol>
      {ctx.edit ? (
        <AddButton what={shape.label} onClick={() => ctx.set(path, [...rows, fresh(shape)])} />
      ) : null}
    </div>
  );
}

/** Entries that hold lists of their own: one card each, opened to show and edit everything. */
function EntryCards({ shape, value, path, ctx }: EntriesProps) {
  const entries = entriesIn(value);
  const fields = Object.entries(shape.fields);
  // The summary line: every short value but the title, then how many each list holds.
  const title = titleKey(shape);
  const short = fields.filter(
    ([key, f]) =>
      key !== title &&
      key !== "id" &&
      ((f.kind === "text" && !f.long) || f.kind === "number" || f.kind === "choice"),
  );
  const lists = fields.filter(([, f]) => f.kind === "list" && f.of.kind === "object");
  return (
    <div className="flex flex-col gap-2">
      {entries.map((entry, i) => {
        const id = typeof entry.id === "string" ? entry.id : undefined;
        return (
          <details
            key={i}
            id={id ? `${ctx.scope}-${id}` : undefined}
            className="group rounded-xl bg-card ring-1 ring-border-soft open:ring-ink-4/40"
          >
            <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
              <ChevronRight className="size-4 shrink-0 text-ink-3 transition-transform group-open:rotate-90" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-[0.9375rem]">
                  {titleOf(shape, entry) || `${shape.label ?? ""} ${i + 1}`.trim()}
                </span>
                <span className="flex flex-wrap gap-x-2 text-[0.75rem] text-ink-3">
                  {short.map(([key, f]) =>
                    entry[key] === undefined || entry[key] === "" ? null : (
                      <span key={key}>
                        {f.kind === "number" && f.unit
                          ? `${entry[key]} ${f.unit}`
                          : String(entry[key])}
                      </span>
                    ),
                  )}
                  {lists.map(([key, f]) => (
                    <span key={key}>
                      {Array.isArray(entry[key]) ? (entry[key] as unknown[]).length : 0}{" "}
                      {labelOf(key, f)}
                    </span>
                  ))}
                </span>
              </span>
              {ctx.edit ? (
                <RemoveButton
                  onClick={() =>
                    ctx.set(
                      path,
                      entries.filter((_, j) => j !== i),
                    )
                  }
                />
              ) : null}
            </summary>
            <div className="border-border-soft border-t px-4 py-4">
              <Form shape={shape} value={entry} path={[...path, i]} ctx={ctx} />
            </div>
          </details>
        );
      })}
      {ctx.edit ? (
        <AddButton what={shape.label} onClick={() => ctx.set(path, [...entries, fresh(shape)])} />
      ) : null}
    </div>
  );
}

/** An entry's fields: short ones side by side, long text and lists across the width. */
function Form({ shape, value, path, ctx }: EntriesProps) {
  const obj = isEntry(value) ? value : {};
  const wide = (f: Shape) =>
    f.kind === "list" ||
    f.kind === "object" ||
    f.kind === "table" ||
    (f.kind === "text" && Boolean(f.long));
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-x-4 gap-y-4">
      {Object.entries(shape.fields).map(([key, f]) => (
        <Field
          key={key}
          title={labelOf(key, f)}
          wide={wide(f)}
          count={Array.isArray(obj[key]) ? (obj[key] as unknown[]).length : null}
        >
          <Value shape={f} value={obj[key]} path={[...path, key]} ctx={ctx} />
        </Field>
      ))}
    </div>
  );
}

function Field({
  title,
  wide,
  count,
  children,
}: {
  title: string;
  wide: boolean;
  count: number | null;
  children: ReactNode;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5 text-[0.875rem]", wide && "col-span-full")}>
      <span className={caption}>
        {title}
        {count !== null ? <span className="ml-1 text-ink-4">{count}</span> : null}
      </span>
      {children}
    </div>
  );
}

function RemoveButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={t("data.remove")}
      onClick={(e) => {
        e.preventDefault();
        onClick();
      }}
      className="grid size-7 place-items-center rounded-md text-ink-3 hover:bg-accent hover:text-rose"
    >
      <Trash2 className="size-3.5" />
    </button>
  );
}

function AddButton({ what, onClick }: { what?: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-1.5 border-border-soft border-t px-3 py-2 text-[0.8125rem] text-ink-3 hover:bg-accent hover:text-ink"
    >
      <Plus className="size-3.5" /> {t("data.add", { what: what ?? "" }).trim()}
    </button>
  );
}

/**
 * The data of one step: a bar with the parts to jump to and Ansicht · Bearbeiten · JSON, then
 * the parts. `mode` and `onMode` hold the bar's choice from outside where given.
 */
export function DataEditor({
  shape,
  value,
  onChange,
  mode: held,
  onMode,
  modes = ["view", "edit", "json"],
  start,
}: {
  shape: ObjectShape;
  value: Entry;
  onChange?: (next: Entry) => void;
  mode?: DataMode;
  onMode?: (mode: DataMode) => void;
  /** The modes offered; without `onChange` there is no edit. */
  modes?: DataMode[];
  /** The mode it opens in. */
  start?: DataMode;
}) {
  const offered = onChange ? modes : modes.filter((m) => m !== "edit");
  const [own, setOwn] = useState<DataMode>(
    start && offered.includes(start) ? start : (offered[0] ?? "view"),
  );
  const mode = held ?? own;
  const setMode = onMode ?? setOwn;
  const scope = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const ctx: Ctx = {
    root: value,
    shape,
    edit: mode === "edit" && Boolean(onChange),
    scope,
    set: (path, next) => onChange?.(setIn(value, path, next) as Entry),
    open: (id) => {
      const el = document.getElementById(`${scope}-${id}`) as HTMLDetailsElement | null;
      if (el) {
        el.open = true;
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    },
  };
  const parts = Object.entries(shape.fields);
  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-border-soft border-b px-3 py-2">
        <div className="flex min-w-0 flex-wrap gap-1">
          {parts.length > 1
            ? parts.map(([key, f]) => (
                <a
                  key={key}
                  href={`#${scope}-part-${key}`}
                  className="rounded-full px-2.5 py-1 text-[0.8125rem] text-ink-2 hover:bg-accent"
                >
                  {labelOf(key, f)}
                  {Array.isArray(value[key]) ? (
                    <span className="ml-1 text-ink-4 tabular-nums">
                      {(value[key] as unknown[]).length}
                    </span>
                  ) : null}
                </a>
              ))
            : null}
        </div>
        {offered.length > 1 ? (
          <Tabs<DataMode>
            value={mode}
            onChange={setMode}
            label={t("data.modes")}
            options={offered.map((id) => ({ id, label: t(`data.${id}`) }))}
          />
        ) : null}
      </div>
      {mode === "json" ? (
        <pre className="max-h-[36rem] overflow-auto p-4 font-mono text-[0.75rem] text-ink-2 leading-relaxed">
          {JSON.stringify(value, null, 2)}
        </pre>
      ) : (
        <div className="flex flex-col gap-7 p-4 sm:p-5">
          {parts.map(([key, f]) => (
            <section
              key={key}
              id={`${scope}-part-${key}`}
              className="flex scroll-mt-4 flex-col gap-2"
            >
              <h3 className="flex items-baseline gap-2 font-display font-semibold text-[1rem]">
                {labelOf(key, f)}
                {Array.isArray(value[key]) ? (
                  <span className="font-normal font-sans text-[0.8125rem] text-ink-4 tabular-nums">
                    {(value[key] as unknown[]).length}
                  </span>
                ) : null}
              </h3>
              <div className="text-[0.9375rem] leading-relaxed">
                <Value shape={f} value={value[key]} path={[key]} ctx={ctx} />
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

/** A ⋮ menu of a step's output: a few entries for whoever builds or keeps the wizard. */
export function DataMenu({
  items,
}: {
  items: { label: string; icon: ReactNode; onClick: () => void }[];
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) {
      return;
    }
    const outside = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label={t("data.menu")}
        title={t("data.menu")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "grid size-8 place-items-center rounded-full text-ink-3 transition hover:bg-accent hover:text-ink coarse:size-11",
          open && "bg-accent text-ink",
        )}
      >
        <MoreVertical className="size-4" />
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute top-full right-0 z-50 mt-1 w-60 animate-rise rounded-xl bg-card p-1.5 shadow-overlay ring-1 ring-border-soft"
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-[0.875rem] text-ink-2 transition hover:bg-accent hover:text-ink"
              onClick={() => {
                setOpen(false);
                item.onClick();
              }}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** A file name from a title: "Menüplan" → "menueplan". */
function fileName(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/ä/g, "ae")
      .replace(/ö/g, "oe")
      .replace(/ü/g, "ue")
      .replace(/ß/g, "ss")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "output"
  );
}

/** The JSON Schema (draft 2020-12) a json step's data has: shown, copied or downloaded. */
export function JsonSchemaDialog({
  shape,
  title,
  open,
  onClose,
}: {
  shape: ObjectShape;
  title: string;
  open: boolean;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const text = open ? JSON.stringify(shapeJsonSchema(shape, title), null, 2) : "";
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: "application/schema+json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${fileName(title)}.schema.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`${t("data.schema")} · ${title}`}
      wide
      height="tall"
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3">
        <pre className="min-h-0 flex-1 overflow-auto rounded-lg bg-paper-2 p-3 font-mono text-[0.75rem] text-ink-2 leading-relaxed">
          {text}
        </pre>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(text);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
            className="inline-flex h-8 items-center gap-1.5 rounded-full bg-paper-2 px-3 text-[0.8125rem] text-ink-2 hover:text-ink coarse:h-11 coarse:px-4"
          >
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            {copied ? t("share.copied") : t("data.copy")}
          </button>
          <button
            type="button"
            onClick={download}
            className="inline-flex h-8 items-center gap-1.5 rounded-full bg-paper-2 px-3 text-[0.8125rem] text-ink-2 hover:text-ink coarse:h-11 coarse:px-4"
          >
            <Download className="size-3.5" /> {t("data.download")}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

/** A json step whose data can be edited by its shape: not one run per entry, not a tool's answer. */
export function editableData(step: { type: string }): step is AgentStep {
  const s = step as AgentStep;
  return s.type === "agent" && s.output.format === "json" && !s.each && !s.call;
}

/**
 * A json step's output in the studio: its ⋮ menu (the data to view and edit, the JSON Schema)
 * goes into the header, the data takes the place of the view while it is open. Saved edits go
 * to the run like a review's do, checked against the step's schema.
 */
export function StudioData({
  runId,
  step,
  output,
  header,
  children,
}: {
  runId: string;
  step: AgentStep;
  output: StepOutput;
  header: (menu: ReactNode) => ReactNode;
  children: ReactNode;
}) {
  const shape = stepShape(step);
  const [open, setOpen] = useState(false);
  const [schema, setSchema] = useState(false);
  const [draft, setDraft] = useState<Entry | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const value = draft ?? (isEntry(output.json) ? output.json : {});
  const save = async () => {
    if (!draft) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.put(`${runBase(runId)}/outputs/${step.id}`, { json: draft });
      setDraft(null);
      setOpen(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const menu = (
    <DataMenu
      items={[
        {
          label: t(open ? "data.close" : "data.open"),
          icon: <Database className="size-4 shrink-0" />,
          onClick: () => {
            setOpen((o) => !o);
            setDraft(null);
          },
        },
        {
          label: t("data.schema"),
          icon: <Braces className="size-4 shrink-0" />,
          onClick: () => setSchema(true),
        },
      ]}
    />
  );
  return (
    <>
      {header(menu)}
      {open ? (
        <div className="overflow-hidden rounded-xl bg-card ring-1 ring-border-soft">
          <DataEditor shape={shape} value={value} onChange={setDraft} />
          {draft ? (
            <div className="flex items-center justify-end gap-2 border-border-soft border-t px-3 py-2">
              {error ? <span className="mr-auto text-[0.8125rem] text-rose">{error}</span> : null}
              <Button variant="ghost" size="sm" onClick={() => setDraft(null)}>
                {t("common.cancel")}
              </Button>
              <Button size="sm" busy={saving} onClick={() => void save()}>
                {t("data.save")}
              </Button>
            </div>
          ) : null}
        </div>
      ) : (
        children
      )}
      <JsonSchemaDialog
        shape={shape}
        title={step.title}
        open={schema}
        onClose={() => setSchema(false)}
      />
    </>
  );
}
