import type { Surface, SurfaceComponent } from "@engenty-wizards/shared/surface";
import { bound } from "@engenty-wizards/shared/surface";
import { Check, ChevronRight, Clock, Lightbulb, Share2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { lang, t } from "./i18n.js";
import { cn, Dialog, Tabs as Segments } from "./ui.js";

/**
 * A surface drawn with the runner's own components: the catalog in shared/surface.ts, nothing
 * else. Unknown components render nothing; a prop that is not there shows empty.
 */

export type SurfaceAction = { action: "regenerate" | "open"; target?: unknown };

/** What the person did in a view that is kept with the run: a checklist's ticks, by component id. */
export type SurfaceState = Record<string, unknown>;

interface Ctx {
  byId: Map<string, SurfaceComponent>;
  data: Record<string, unknown>;
  assetUrl: (id: string) => string;
  onAction?: (a: SurfaceAction) => void;
  state: SurfaceState;
  setState: (id: string, value: unknown) => void;
  /** Opens an entry in a sheet, drawn by `view`. */
  open: (view: string, row: unknown) => void;
}

// A yes/no without words of its own reads as yes or no, never as true or false.
const text = (v: unknown): string =>
  v === null || v === undefined
    ? ""
    : typeof v === "boolean"
      ? t(v ? "run.yes" : "run.no")
      : typeof v === "object"
        ? JSON.stringify(v)
        : String(v);

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
};

/** A picture: an asset of the run by id, or an address. */
function src(v: unknown, assetUrl: (id: string) => string): string | null {
  const s = text(v);
  if (!s) {
    return null;
  }
  return /^(https?:|data:|\/)/.test(s) ? s : assetUrl(s);
}

function prop(c: SurfaceComponent, key: string, ctx: Ctx, row?: unknown): unknown {
  return bound((c as Record<string, unknown>)[key], ctx.data, row);
}

/** Chart points from rows: their `label` and `value`, or the columns a chart names instead. */
function points(
  v: unknown,
  labelKey: unknown,
  valueKey: unknown,
): { label: string; value: number }[] {
  const l = text(labelKey) || "label";
  const k = text(valueKey) || "value";
  return Array.isArray(v)
    ? v.map((p) => ({ label: text((p as any)?.[l]), value: num((p as any)?.[k]) }))
    : [];
}

function Children({ c, ctx, row }: { c: SurfaceComponent; ctx: Ctx; row?: unknown }) {
  const kids = c.children;
  if (!kids) {
    return null;
  }
  if (Array.isArray(kids)) {
    return (
      <>
        {kids.map((id) => (
          <Node key={id} id={id} ctx={ctx} row={row} />
        ))}
      </>
    );
  }
  const items = bound({ path: kids.path }, ctx.data, row);
  return (
    <>
      {(Array.isArray(items) ? items : []).map((item, i) => (
        <Node key={i} id={kids.componentId} ctx={ctx} row={item} />
      ))}
    </>
  );
}

const TONES: Record<string, string> = {
  success: "bg-second-tint text-second",
  warning: "bg-amber-tint text-ink-2",
  accent: "bg-ember-tint text-ember-strong",
  default: "bg-paper-2 text-ink-2",
};

const rows = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** A cell of an entry by its key; an entry that is itself a value is its own label. */
function cell(item: unknown, key: string): unknown {
  if (item === null || typeof item !== "object") {
    return key === "" ? item : undefined;
  }
  return (item as Record<string, unknown>)[key];
}

/** What an entry is called: its `labelKey`, else the usual keys, else the entry itself. */
function labelOf(item: unknown, key: string): string {
  if (item === null || typeof item !== "object") {
    return text(item);
  }
  const r = item as Record<string, unknown>;
  return text(key ? r[key] : (r.label ?? r.name ?? r.title ?? r.text));
}

/** Entries under a heading per value of a key, in `order` first, the rest as they come. */
function grouped(items: unknown[], by: string, order: string[]): [string, unknown[]][] {
  const groups = new Map<string, unknown[]>();
  for (const item of items) {
    const name = text(cell(item, by));
    groups.set(name, [...(groups.get(name) ?? []), item]);
  }
  const rank = (name: string) => {
    const i = order.indexOf(name);
    return i < 0 ? order.length : i;
  };
  return [...groups.entries()].sort((a, b) => rank(a[0]) - rank(b[0]));
}

const minutes = (n: unknown) => (n ? `${text(n)} ${lang === "de" ? "Min" : "min"}` : "");

function Metas({ items }: { items: string[] }) {
  return items.length ? (
    <div className="flex flex-wrap gap-1.5">
      {items.map((m, i) => (
        <span key={i} className="rounded-full bg-paper-2 px-2 py-0.5 text-[0.75rem] text-ink-2">
          {m}
        </span>
      ))}
    </div>
  ) : null;
}

/** `meta`: one value or a list of them, each a literal or a path. */
function metasOf(c: SurfaceComponent, ctx: Ctx, row?: unknown): string[] {
  const raw = (c as Record<string, unknown>).meta;
  return (Array.isArray(raw) ? raw : [raw])
    .map((m) => text(bound(m, ctx.data, row)))
    .filter(Boolean);
}

function TabsView({ c, ctx, row }: { c: SurfaceComponent; ctx: Ctx; row?: unknown }) {
  const [on, setOn] = useState("0");
  const tabs = rows((c as Record<string, unknown>).tabs) as Record<string, unknown>[];
  const options = tabs.map((tab, i) => {
    const count = bound(tab?.count, ctx.data, row);
    const n = Array.isArray(count) ? count.length : count;
    const label = text(bound(tab?.label, ctx.data, row));
    return {
      id: String(i),
      label: n === undefined || n === null || n === "" ? label : `${label} (${text(n)})`,
    };
  });
  const child = tabs[Number(on)]?.child;
  return (
    <div className="flex flex-col gap-4">
      <div className="sticky top-2 z-10 max-w-full self-start overflow-x-auto rounded-full">
        <Segments value={on} onChange={setOn} options={options} />
      </div>
      {typeof child === "string" ? <Node id={child} ctx={ctx} row={row} /> : null}
    </div>
  );
}

function ChecklistView({ c, ctx, row }: { c: SurfaceComponent; ctx: Ctx; row?: unknown }) {
  const p = (key: string) => prop(c, key, ctx, row);
  const [copied, setCopied] = useState(false);
  const items = rows(p("items"));
  const labelKey = text(p("labelKey"));
  const detailKey = text(p("detailKey")) || "amount";
  const noteKey = text(p("noteKey"));
  const noteFormat = text(p("noteFormat"));
  const groupKey = text(p("groupKey"));
  const order = rows(p("groupOrder")).map(text);
  const ticks = (ctx.state[c.id] ?? {}) as Record<string, boolean>;
  const keyOf = (item: unknown, i: number) => `${i}:${labelOf(item, labelKey)}`;
  const done = items.filter((item, i) => ticks[keyOf(item, i)]).length;
  const indexed = items.map((item, i) => ({ item, i }));
  const groups: [string, { item: unknown; i: number }[]][] = groupKey
    ? grouped(items, groupKey, order).map(([name]) => [
        name,
        indexed.filter(({ item }) => text(cell(item, groupKey)) === name),
      ])
    : [["", indexed]];
  const detailOf = (item: unknown) => text(cell(item, detailKey));
  const noteMap = p("noteMap");
  const noteOf = (item: unknown) => {
    const v = noteKey ? cell(item, noteKey) : undefined;
    // A yes/no says something only in words of its own: "da", "einkaufen".
    if (typeof v === "boolean") {
      const words =
        noteMap && typeof noteMap === "object"
          ? (noteMap as Record<string, unknown>)[String(v)]
          : "";
      return text(words ?? "");
    }
    const words = Array.isArray(v) ? v.map(text).join(", ") : text(v);
    return words && noteFormat ? noteFormat.replace("{}", words) : words;
  };
  const share = async () => {
    const open = groups
      .map(([name, list]) => {
        const lines = list
          .filter(({ item, i }) => !ticks[keyOf(item, i)])
          .map(
            ({ item }) =>
              `☐ ${labelOf(item, labelKey)}${detailOf(item) ? ` – ${detailOf(item)}` : ""}`,
          );
        return lines.length ? [name, ...lines].filter(Boolean).join("\n") : "";
      })
      .filter(Boolean)
      .join("\n\n");
    try {
      if (navigator.share) {
        await navigator.share({ text: open });
      } else {
        await navigator.clipboard.writeText(open);
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      }
    } catch {
      // Closed without sharing, or the clipboard refused: nothing to do.
    }
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-paper-2">
          <div
            className="h-full rounded-full bg-second transition-[width] duration-300"
            style={{ width: `${items.length ? (done / items.length) * 100 : 0}%` }}
          />
        </div>
        <span className="text-[0.8125rem] text-ink-3 tabular-nums">
          {done === items.length && items.length
            ? t("surface.allDone")
            : t("surface.done", { done, total: items.length })}
        </span>
        {p("share") === false ? null : (
          <button
            type="button"
            onClick={share}
            className="inline-flex h-8 items-center gap-1.5 rounded-full bg-paper-2 px-3 text-[0.8125rem] text-ink-2 hover:text-ink coarse:h-10"
          >
            {copied ? <Check className="size-3.5" /> : <Share2 className="size-3.5" />}
            {copied ? t("share.copied") : t("run.share")}
          </button>
        )}
      </div>
      {groups.map(([name, list]) => (
        <section key={name} className="rounded-xl bg-card px-4 py-1 ring-1 ring-border-soft">
          {name ? (
            <h4 className="pt-3 pb-1 font-semibold text-[0.6875rem] text-second uppercase tracking-[0.14em]">
              {name}
            </h4>
          ) : null}
          {list.map(({ item, i }) => {
            const key = keyOf(item, i);
            const on = Boolean(ticks[key]);
            const note = noteOf(item);
            return (
              <label
                key={key}
                className="flex cursor-pointer items-start gap-3 border-border-soft border-b border-dashed py-2.5 last:border-0"
              >
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => ctx.setState(c.id, { ...ticks, [key]: !on })}
                  className="mt-0.5 size-[1.125rem] shrink-0 accent-[var(--second)] coarse:size-6"
                />
                <span className="min-w-0 flex-1">
                  <span className={cn("text-[0.9375rem]", on && "text-ink-3 line-through")}>
                    {labelOf(item, labelKey)}
                    {detailOf(item) ? (
                      <span className="text-ink-3"> · {detailOf(item)}</span>
                    ) : null}
                  </span>
                  {note ? <span className="block text-[0.75rem] text-ink-3">{note}</span> : null}
                </span>
              </label>
            );
          })}
        </section>
      ))}
    </div>
  );
}

function Bars({ data }: { data: { label: string; value: number }[] }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div className="flex flex-col gap-1.5">
      {data.map((d, i) => (
        <div key={i} className="grid grid-cols-[minmax(0,8rem)_1fr_auto] items-center gap-2">
          <span className="truncate text-[0.8125rem] text-ink-2">{d.label}</span>
          <span className="h-2.5 rounded-full bg-paper-2">
            <span
              className="block h-full rounded-full bg-ember"
              style={{ width: `${(d.value / max) * 100}%` }}
            />
          </span>
          <span className="text-[0.8125rem] tabular-nums">{d.value.toLocaleString(lang)}</span>
        </div>
      ))}
    </div>
  );
}

function Line({ data }: { data: { label: string; value: number }[] }) {
  if (data.length < 2) {
    return <Bars data={data} />;
  }
  const w = 320;
  const h = 120;
  const max = Math.max(...data.map((d) => d.value));
  const min = Math.min(...data.map((d) => d.value));
  const span = max - min || 1;
  const xy = data.map((d, i) => [
    (i / (data.length - 1)) * (w - 8) + 4,
    h - 4 - ((d.value - min) / span) * (h - 8),
  ]);
  return (
    <figure>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full text-ember" role="img">
        <polyline
          points={xy.map(([x, y]) => `${x},${y}`).join(" ")}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinejoin="round"
        />
        {xy.map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r="3" fill="currentColor">
            <title>{`${data[i].label}: ${data[i].value}`}</title>
          </circle>
        ))}
      </svg>
      <figcaption className="mt-1 flex justify-between text-[0.75rem] text-ink-3">
        <span>{data[0].label}</span>
        <span>{data.at(-1)?.label}</span>
      </figcaption>
    </figure>
  );
}

const DONUT = [
  "var(--color-ember)",
  "var(--color-cobalt)",
  "var(--color-moss)",
  "var(--color-amber)",
  "var(--color-ink-3)",
];

function Donut({ data }: { data: { label: string; value: number }[] }) {
  const total = data.reduce((a, d) => a + Math.max(0, d.value), 0) || 1;
  let at = 0;
  const r = 40;
  const length = 2 * Math.PI * r;
  return (
    <div className="flex items-center gap-4">
      <svg viewBox="0 0 100 100" className="size-28 shrink-0 -rotate-90" role="img">
        {data.map((d, i) => {
          const part = (Math.max(0, d.value) / total) * length;
          const el = (
            <circle
              key={i}
              cx="50"
              cy="50"
              r={r}
              fill="none"
              stroke={DONUT[i % DONUT.length]}
              strokeWidth="16"
              strokeDasharray={`${part} ${length - part}`}
              strokeDashoffset={-at}
            >
              <title>{`${d.label}: ${d.value}`}</title>
            </circle>
          );
          at += part;
          return el;
        })}
      </svg>
      <ul className="flex flex-col gap-1 text-[0.8125rem]">
        {data.map((d, i) => (
          <li key={i} className="flex items-center gap-2">
            <span
              className="size-2.5 rounded-full"
              style={{ background: DONUT[i % DONUT.length] }}
            />
            <span className="text-ink-2">{d.label}</span>
            <span className="tabular-nums">{d.value.toLocaleString(lang)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Titled({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-xl bg-card p-4 ring-1 ring-border-soft">
      {title ? <div className="mb-3 font-medium text-[0.875rem]">{title}</div> : null}
      {children}
    </div>
  );
}

function Node({ id, ctx, row }: { id: string; ctx: Ctx; row?: unknown }) {
  const c = ctx.byId.get(id);
  if (!c) {
    return null;
  }
  const p = (key: string) => prop(c, key, ctx, row);
  switch (c.component) {
    case "Column":
      return (
        <div className="flex flex-col gap-4">
          <Children c={c} ctx={ctx} row={row} />
        </div>
      );
    case "Text": {
      const variant = text(p("variant")) || "body";
      return (
        <p
          className={cn(
            variant === "h3" && "font-display font-semibold text-[1.25rem] leading-tight",
            variant === "h4" && "font-semibold text-[1rem]",
            variant === "lead" && "font-display text-[1.0625rem] text-ink-2 leading-relaxed",
            variant === "body" && "text-[0.9375rem] leading-relaxed",
            variant === "muted" && "text-[0.8125rem] text-ink-3",
          )}
        >
          {text(p("text"))}
        </p>
      );
    }
    case "List":
      return (
        <div className="flex flex-col divide-y divide-border-soft overflow-hidden rounded-xl bg-card ring-1 ring-border-soft">
          <Children c={c} ctx={ctx} row={row} />
        </div>
      );
    case "Row": {
      const image = src(p("image"), ctx.assetUrl);
      const badge = text(p("badge"));
      return (
        <div className="flex items-center gap-3 px-4 py-3">
          {image ? (
            <img src={image} alt="" className="size-10 shrink-0 rounded-lg object-cover" />
          ) : null}
          <div className="min-w-0 flex-1">
            <div className="truncate text-[0.9375rem]">{text(p("title"))}</div>
            {p("subtitle") ? (
              <div className="truncate text-[0.8125rem] text-ink-3">{text(p("subtitle"))}</div>
            ) : null}
          </div>
          {p("meta") ? (
            <span className="shrink-0 text-[0.8125rem] text-ink-3 tabular-nums">
              {text(p("meta"))}
            </span>
          ) : null}
          {badge ? (
            <span
              className={cn(
                "shrink-0 rounded-full px-2 py-0.5 text-[0.75rem]",
                TONES[text(p("badgeTone"))] ?? TONES.default,
              )}
            >
              {badge}
            </span>
          ) : null}
        </div>
      );
    }
    case "DetailGrid": {
      const rows = p("rows");
      return (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-xl bg-card p-4 text-[0.875rem] ring-1 ring-border-soft">
          {(Array.isArray(rows) ? rows : []).map((r, i) => (
            <div key={i} className="contents">
              <dt className="text-ink-3">{text(bound((r as any)?.label, ctx.data, row))}</dt>
              <dd className="break-words">{text(bound((r as any)?.value, ctx.data, row))}</dd>
            </div>
          ))}
        </dl>
      );
    }
    case "Badge":
      return (
        <span
          className={cn(
            "inline-flex w-fit rounded-full px-2.5 py-0.5 text-[0.75rem]",
            TONES[text(p("tone"))] ?? TONES.default,
          )}
        >
          {text(p("label"))}
        </span>
      );
    case "Grid": {
      const columns = Math.min(4, Math.max(1, num(p("columns")) || 2));
      // The narrowest a tile gets: small tiles (figures) sit two to a phone, cards one.
      const min = Math.min(24, Math.max(6, num(p("min")) || (columns > 2 ? 9 : 12)));
      return (
        <div
          className="grid gap-3"
          style={{
            gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${min}rem), 1fr))`,
          }}
        >
          <Children c={c} ctx={ctx} row={row} />
        </div>
      );
    }
    case "Metric":
      return (
        <div className="rounded-xl bg-card p-4 ring-1 ring-border-soft">
          <div className="text-[0.75rem] text-ink-3 uppercase tracking-[0.06em]">
            {text(p("label"))}
          </div>
          <div className="mt-1 font-display font-semibold text-[1.5rem] tabular-nums">
            {text(p("value"))}
          </div>
          {p("caption") ? (
            <div className="text-[0.8125rem] text-ink-3">{text(p("caption"))}</div>
          ) : null}
        </div>
      );
    case "Table": {
      const rows = p("rows");
      const list = (Array.isArray(rows) ? rows : []) as Record<string, unknown>[];
      const declared = p("columns");
      const cols: { key: string; label: string }[] = Array.isArray(declared)
        ? declared.map((d: any) => ({ key: text(d?.key), label: text(d?.label ?? d?.key) }))
        : [...new Set(list.flatMap((r) => Object.keys(r ?? {})))].map((k) => ({
            key: k,
            label: k,
          }));
      return (
        <div className="overflow-x-auto rounded-xl ring-1 ring-border-soft">
          <table className="w-full text-[0.8125rem]">
            <thead className="bg-paper-2 text-ink-2">
              <tr>
                {cols.map((col) => (
                  <th key={col.key} className="px-3 py-2 text-left font-medium">
                    {col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {list.map((r, i) => (
                <tr key={i} className="border-border-soft border-t">
                  {cols.map((col) => (
                    <td key={col.key} className="px-3 py-2 tabular-nums">
                      {text(r?.[col.key])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case "Image": {
      const url = src(p("src"), ctx.assetUrl);
      return url ? <img src={url} alt={text(p("alt"))} className="w-full rounded-xl" /> : null;
    }
    case "BarChart":
      return (
        <Titled title={text(p("title"))}>
          <Bars data={points(p("points"), p("labelKey"), p("valueKey"))} />
        </Titled>
      );
    case "LineChart":
      return (
        <Titled title={text(p("title"))}>
          <Line data={points(p("points"), p("labelKey"), p("valueKey"))} />
        </Titled>
      );
    case "DonutChart":
      return (
        <Titled title={text(p("title"))}>
          <Donut data={points(p("slices"), p("labelKey"), p("valueKey"))} />
        </Titled>
      );
    case "Actions":
      return (
        <div className="flex flex-wrap gap-2">
          <Children c={c} ctx={ctx} row={row} />
        </div>
      );
    case "Button": {
      const action = text(p("action")) as SurfaceAction["action"];
      if (!ctx.onAction && action !== "open") {
        return null;
      }
      return (
        <button
          type="button"
          onClick={() => {
            const target = p("target");
            if (action === "open") {
              const url = src(target, ctx.assetUrl);
              if (url) {
                window.open(url, "_blank", "noopener");
              }
              return;
            }
            ctx.onAction?.({ action, target });
          }}
          className="inline-flex h-9 items-center rounded-full bg-paper-2 px-4 text-[0.875rem] text-ink-2 hover:text-ink coarse:h-11"
        >
          {text(p("label"))}
        </button>
      );
    }
    case "Tabs":
      return <TabsView c={c} ctx={ctx} row={row} />;
    case "Card": {
      const image = src(p("image"), ctx.assetUrl);
      const eyebrow = text(p("eyebrow"));
      const subtitle = text(p("subtitle"));
      return (
        <article className="overflow-hidden rounded-xl bg-card ring-1 ring-border-soft">
          {image ? <img src={image} alt="" className="aspect-[16/9] w-full object-cover" /> : null}
          <div className={cn("flex flex-col gap-1.5 px-4 py-3.5", c.children && "bg-paper-2/60")}>
            {eyebrow ? (
              <div className="font-medium text-[0.6875rem] text-ink-3 uppercase tracking-[0.14em]">
                {eyebrow}
              </div>
            ) : null}
            <h3 className="text-balance font-display font-semibold text-[1.1875rem] leading-snug">
              {text(p("title"))}
            </h3>
            {subtitle ? (
              <p className="text-[0.875rem] text-ink-3 leading-relaxed">{subtitle}</p>
            ) : null}
            <Metas items={metasOf(c, ctx, row)} />
          </div>
          {c.children ? (
            <div className="flex flex-col gap-3 border-border-soft border-t px-4 py-3.5 empty:hidden">
              <Children c={c} ctx={ctx} row={row} />
            </div>
          ) : null}
        </article>
      );
    }
    case "Fold":
      return (
        <details
          open={Boolean(p("open"))}
          className="group border-border-soft border-t pt-3 first:border-0 first:pt-0"
        >
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 font-display font-semibold text-[1rem] [&::-webkit-details-marker]:hidden">
            {text(p("title"))}
            <ChevronRight className="size-4 text-ink-3 transition-transform group-open:rotate-90 motion-reduce:transition-none" />
          </summary>
          <div className="flex flex-col gap-3 pt-3">
            <Children c={c} ctx={ctx} row={row} />
          </div>
        </details>
      );
    case "Group": {
      const kids = c.children;
      if (!kids || Array.isArray(kids)) {
        return null;
      }
      const items = rows(bound({ path: kids.path }, ctx.data, row));
      return (
        <div className="flex flex-col gap-5">
          {grouped(items, text(p("by")), rows(p("order")).map(text)).map(([name, list]) => (
            <section key={name} className="flex flex-col gap-2">
              {name ? (
                <h4 className="font-semibold text-[0.6875rem] text-second uppercase tracking-[0.14em]">
                  {name}
                </h4>
              ) : null}
              {list.map((item, i) => (
                <Node key={i} id={kids.componentId} ctx={ctx} row={item} />
              ))}
            </section>
          ))}
        </div>
      );
    }
    case "Chips": {
      const labelKey = text(p("labelKey"));
      const flagKey = text(p("flagKey"));
      const flag = text(p("flag"));
      const title = text(p("title"));
      return (
        <div className="flex flex-col gap-2">
          {title ? <div className="text-[0.8125rem] text-ink-3">{title}</div> : null}
          <div className="flex flex-wrap gap-1.5">
            {rows(p("items")).map((item, i) => {
              const flagged = Boolean(flagKey && cell(item, flagKey));
              return (
                <span
                  key={i}
                  className={cn(
                    "rounded-full px-2.5 py-1 text-[0.8125rem]",
                    flagged
                      ? "bg-amber-tint font-medium text-ink ring-1 ring-amber/60"
                      : "bg-card text-ink-2 ring-1 ring-border-soft",
                  )}
                >
                  {labelOf(item, labelKey)}
                  {flagged && flag ? ` · ${flag}` : ""}
                </span>
              );
            })}
          </div>
        </div>
      );
    }
    case "Checklist":
      return <ChecklistView c={c} ctx={ctx} row={row} />;
    case "Steps": {
      const textKey = text(p("textKey")) || "text";
      const minutesKey = text(p("minutesKey")) || "minutes";
      return (
        <ol className="flex flex-col gap-3">
          {rows(p("items")).map((item, i) => {
            const words = typeof item === "object" ? text(cell(item, textKey)) : text(item);
            const time = minutes(cell(item, minutesKey));
            return (
              <li key={i} className="grid grid-cols-[1.5rem_1fr] gap-2">
                <span className="font-display font-semibold text-[1.125rem] text-ember leading-snug">
                  {i + 1}
                </span>
                <span className="text-[0.9375rem] leading-relaxed">
                  {words}
                  {time ? (
                    <span className="ml-1.5 inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-paper-2 px-2 py-0.5 align-[1px] text-[0.75rem] text-ink-2">
                      <Clock className="size-3" />
                      {time}
                    </span>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ol>
      );
    }
    case "Link": {
      // The entry it opens: title, subtitle and meta read it; the eyebrow reads the row it sits in.
      const key = text(p("key")) || "id";
      const value = text(p("value"));
      const entry = rows(p("items")).find((item) => text(cell(item, key)) === value);
      const view = (c as Record<string, unknown>).view;
      if (entry === undefined) {
        return null;
      }
      const at = (k: string) => bound((c as Record<string, unknown>)[k], ctx.data, entry);
      const eyebrow = text(p("eyebrow"));
      const meta = metasOf(c, ctx, entry);
      return (
        <button
          type="button"
          onClick={() => typeof view === "string" && ctx.open(view, entry)}
          className={cn(
            "group flex w-full items-center gap-3 text-left",
            text(p("look")) === "card"
              ? "rounded-xl bg-card p-4 ring-1 ring-border-soft hover:ring-ink-4"
              : "-mx-2 w-[calc(100%+1rem)] rounded-lg px-2 py-2 hover:bg-paper-2/70 coarse:py-3",
          )}
        >
          <span className="min-w-0 flex-1">
            {eyebrow ? (
              <span className="block font-semibold text-[0.6875rem] text-second uppercase tracking-[0.14em]">
                {eyebrow}
              </span>
            ) : null}
            <span className="block font-display font-semibold text-[1rem] leading-snug group-hover:text-ember">
              {text(at("title"))}
            </span>
            {at("subtitle") ? (
              <span className="block text-[0.8125rem] text-ink-3">{text(at("subtitle"))}</span>
            ) : null}
            {meta.length ? (
              <span className="mt-0.5 flex items-center gap-1 text-[0.75rem] text-ink-3">
                <Clock className="size-3" />
                {meta.join(" · ")}
              </span>
            ) : null}
          </span>
          <ChevronRight className="size-4 shrink-0 text-ink-3" />
        </button>
      );
    }
    case "Callout": {
      const tone = text(p("tone")) || "tip";
      const title = text(p("title"));
      return (
        <div
          className={cn(
            "flex gap-2.5 rounded-xl px-4 py-3 text-[0.875rem] leading-relaxed",
            tone === "tip" && "bg-second-tint",
            tone === "note" && "bg-paper-2",
            tone === "warning" && "bg-amber-tint",
          )}
        >
          <Lightbulb
            className={cn("mt-0.5 size-4 shrink-0", tone === "tip" ? "text-second" : "text-ink-3")}
          />
          <p>
            {title ? <b className="font-semibold">{title} </b> : null}
            {text(p("text"))}
          </p>
        </div>
      );
    }
  }
  return null;
}

export function SurfaceView({
  surface,
  assetUrl,
  onAction,
  initial,
  onState,
}: {
  surface: Surface;
  assetUrl: (id: string) => string;
  onAction?: (a: SurfaceAction) => void;
  /** What the person did in the view last time (kept with the run). */
  initial?: SurfaceState;
  /** Keeps what the person did; without it, it lasts as long as the page. */
  onState?: (next: SurfaceState) => void;
}) {
  const [state, setState] = useState<SurfaceState>(initial ?? {});
  const [sheet, setSheet] = useState<{ view: string; row: unknown } | null>(null);
  const ctx: Ctx = {
    byId: new Map(surface.components.map((c) => [c.id, c])),
    data: surface.data,
    assetUrl,
    onAction,
    state,
    setState: (id, value) => {
      const next = { ...state, [id]: value };
      setState(next);
      onState?.(next);
    },
    open: (view, row) => setSheet({ view, row }),
  };
  return (
    <>
      <Node id="root" ctx={ctx} />
      <Dialog open={sheet !== null} onClose={() => setSheet(null)} height="tall">
        {sheet ? (
          <div className="flex flex-col gap-4">
            <Node id={sheet.view} ctx={ctx} row={sheet.row} />
            <button
              type="button"
              onClick={() => setSheet(null)}
              className="h-10 self-center rounded-full bg-paper-2 px-5 text-[0.875rem] text-ink-2 hover:text-ink"
            >
              {t("surface.close")}
            </button>
          </div>
        ) : null}
      </Dialog>
    </>
  );
}
