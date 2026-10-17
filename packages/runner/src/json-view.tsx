import { type AgentStep, stepShape } from "@engenty-wizards/shared/definition";
import {
  type FieldShape,
  type ListShape,
  labelOf,
  type ObjectShape,
  titleKey,
} from "@engenty-wizards/shared/shape";
import { lang, t } from "./i18n.js";
import { cn } from "./ui.js";

/**
 * A json result without a view of its own, drawn from the step's shape: things as cards (title,
 * a line about it, its short values), words as chips, ordered text as numbered lines, a yes/no
 * in its own words. A table only where entries are figures to compare across columns.
 */

type Entry = Record<string, unknown>;
type Of = ListShape["of"];

const text = (v: unknown): string =>
  v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);

const sectionLabel = "mb-1.5 font-medium text-[0.75rem] text-ink-3 uppercase tracking-[0.06em]";

/** The shape of an entry: declared, or read from the entries themselves (a table without one). */
function entryShape(of: Of | undefined, rows: Entry[]): ObjectShape {
  if (of?.kind === "object") {
    return of;
  }
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r ?? {})))];
  return {
    kind: "object",
    fields: Object.fromEntries(
      keys.map((k) => {
        const values = rows.map((r) => r?.[k]).filter((v) => v !== null && v !== undefined);
        const kind = values.every((v) => typeof v === "number")
          ? ("number" as const)
          : values.every((v) => typeof v === "boolean")
            ? ("yesno" as const)
            : ("text" as const);
        const long = kind === "text" && values.some((v) => String(v).length > 80);
        return [k, kind === "text" ? { kind, long } : { kind }];
      }),
    ),
  };
}

/** Entries that are figures: at least three numbers and more numbers than words. */
function figures(shape: ObjectShape): boolean {
  const fields = Object.values(shape.fields);
  const numbers = fields.filter((f) => f.kind === "number").length;
  return numbers >= 3 && numbers > fields.length / 2;
}

function leafText(f: FieldShape | Of, v: unknown, root: Entry): string {
  if (v === null || v === undefined || v === "") {
    return "";
  }
  switch (f.kind) {
    case "number":
      return `${typeof v === "number" ? v.toLocaleString(lang) : text(v)}${f.unit ? ` ${f.unit}` : ""}`;
    case "yesno":
      return v ? (f.yes ?? t("run.yes")) : (f.no ?? t("run.no"));
    case "ref": {
      const list = root[f.to];
      const hit = Array.isArray(list)
        ? (list as Entry[]).find((e) => e && text(e.id) === text(v))
        : undefined;
      return hit ? text(hit.title ?? hit.name ?? hit.label ?? v) : text(v);
    }
    default:
      return text(v);
  }
}

function Chips({ items }: { items: string[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((x, i) => (
        <span
          key={i}
          className="rounded-full bg-card px-2.5 py-0.5 text-[0.8125rem] text-ink-2 ring-1 ring-border-soft"
        >
          {x}
        </span>
      ))}
    </div>
  );
}

/** A list of values: short ones as chips, sentences as a list. */
function Leaves({ of, values, root }: { of: Of; values: unknown[]; root: Entry }) {
  const items = values.map((v) => leafText(of, v, root)).filter(Boolean);
  return items.every((x) => x.length <= 32) ? (
    <Chips items={items} />
  ) : (
    <ul className="flex list-disc flex-col gap-1 pl-5 text-[0.9375rem]">
      {items.map((x, i) => (
        <li key={i} className="break-words">
          {x}
        </li>
      ))}
    </ul>
  );
}

function FigureTable({ shape, rows, root }: { shape: ObjectShape; rows: Entry[]; root: Entry }) {
  const cols = Object.entries(shape.fields);
  return (
    <div className="overflow-x-auto rounded-lg ring-1 ring-border-soft">
      <table className="w-full text-[0.8125rem]">
        <thead className="bg-paper-2 text-ink-2">
          <tr>
            {cols.map(([k, f]) => (
              <th
                key={k}
                className={cn(
                  "whitespace-nowrap px-3 py-2 text-left font-medium",
                  f.kind === "number" && "text-right",
                )}
              >
                {labelOf(k, f)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-border-soft border-t">
              {cols.map(([k, f]) => (
                <td
                  key={k}
                  className={cn("px-3 py-2 tabular-nums", f.kind === "number" && "text-right")}
                >
                  {leafText(f, r?.[k], root)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Nested entries inside a card: numbered lines when they are text, else their titles. */
function Nested({ shape, rows, root }: { shape: ObjectShape; rows: Entry[]; root: Entry }) {
  const fields = Object.entries(shape.fields);
  const main = fields.find(([, f]) => f.kind === "text" && f.long)?.[0] ?? titleKey(shape);
  const rest = fields.filter(([k, f]) => k !== main && k !== "id" && f.kind !== "list");
  const ordered = Boolean(fields.find(([, f]) => f.kind === "text" && f.long));
  const List = ordered ? "ol" : "ul";
  return (
    <List className="flex flex-col gap-1.5 text-[0.875rem]">
      {rows.map((r, i) => {
        // The first value reads as the line, the rest beside it, quieter.
        const parts = [
          main ? text(r?.[main]) : "",
          ...rest.map(([k, f]) => leafText(f, r?.[k], root)),
        ].filter(Boolean);
        return (
          <li key={i} className={cn(ordered && "grid grid-cols-[1.25rem_1fr] gap-1.5")}>
            {ordered ? (
              <span className="font-semibold text-ember tabular-nums">{i + 1}</span>
            ) : null}
            <span>
              {parts[0]}
              {parts.length > 1 ? (
                <span className="text-ink-3"> · {parts.slice(1).join(" · ")}</span>
              ) : null}
            </span>
          </li>
        );
      })}
    </List>
  );
}

/**
 * Yes/no values as tags: a yes in its own words or the field's label ("Bald verbrauchen"), a no
 * only where it has words of its own ("einkaufen") — a plain no is no news.
 */
function Flags({ fields, entry }: { fields: [string, FieldShape][]; entry: Entry }) {
  const tags = fields.flatMap(([k, f]) => {
    if (f.kind !== "yesno" || entry[k] === undefined || entry[k] === null) {
      return [];
    }
    const words = entry[k] ? (f.yes ?? labelOf(k, f)) : f.no;
    return words ? [{ k, words, on: Boolean(entry[k]) }] : [];
  });
  return tags.length ? (
    <span className="flex shrink-0 flex-wrap justify-end gap-1">
      {tags.map((tag) => (
        <span
          key={tag.k}
          className={cn(
            "rounded-full px-2 py-0.5 text-[0.75rem]",
            tag.on ? "bg-second-tint text-second" : "bg-ember-tint text-ember-strong",
          )}
        >
          {tag.words}
        </span>
      ))}
    </span>
  ) : null;
}

/** Small entries (no long text, no lists): one row each, in one card. */
function EntryRows({ shape, rows, root }: { shape: ObjectShape; rows: Entry[]; root: Entry }) {
  const fields = Object.entries(shape.fields).filter(([k]) => k !== "id");
  const title = titleKey(shape);
  const flags = fields.filter(([, f]) => f.kind === "yesno");
  const metas = fields.filter(([k, f]) => k !== title && f.kind !== "yesno");
  return (
    <div className="divide-y divide-border-soft overflow-hidden rounded-xl bg-card ring-1 ring-border-soft">
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="text-[0.9375rem]">{title ? text(r?.[title]) : ""}</div>
            <div className="text-[0.8125rem] text-ink-3">
              {metas
                .map(([k, f]) => leafText(f, r?.[k], root))
                .filter(Boolean)
                .join(" · ")}
            </div>
          </div>
          <Flags fields={flags} entry={r ?? {}} />
        </div>
      ))}
    </div>
  );
}

function EntryCard({ shape, entry, root }: { shape: ObjectShape; entry: Entry; root: Entry }) {
  const fields = Object.entries(shape.fields).filter(([k]) => k !== "id");
  const title = titleKey(shape);
  const about = fields.find(([, f]) => f.kind === "text" && f.long);
  const metas = fields.filter(
    ([k, f]) =>
      k !== title &&
      k !== about?.[0] &&
      (f.kind === "number" ||
        f.kind === "choice" ||
        f.kind === "score" ||
        f.kind === "ref" ||
        (f.kind === "text" && !f.long)),
  );
  const flags = fields.filter(([, f]) => f.kind === "yesno");
  const longs = fields.filter(([k, f]) => f.kind === "text" && f.long && k !== about?.[0]);
  const lists = fields.filter(([, f]) => f.kind === "list" || f.kind === "table");
  return (
    <article className="flex flex-col gap-2 rounded-xl bg-card p-4 ring-1 ring-border-soft">
      <div className="flex items-start justify-between gap-3">
        <h4 className="text-balance font-display font-semibold text-[1.0625rem] leading-snug">
          {title ? text(entry[title]) : ""}
        </h4>
        <Flags fields={flags} entry={entry} />
      </div>
      {about ? (
        <p className="text-[0.875rem] text-ink-3 leading-relaxed">{text(entry[about[0]])}</p>
      ) : null}
      {metas.length ? (
        <div className="flex flex-wrap gap-1.5">
          {metas
            .map(([k, f]) => leafText(f, entry[k], root))
            .filter(Boolean)
            .map((m, i) => (
              <span
                key={i}
                className="rounded-full bg-paper-2 px-2 py-0.5 text-[0.75rem] text-ink-2"
              >
                {m}
              </span>
            ))}
        </div>
      ) : null}
      {longs.map(([k, f]) =>
        entry[k] ? (
          <p key={k} className="text-[0.875rem] leading-relaxed">
            <span className="text-ink-3">{labelOf(k, f)}: </span>
            {text(entry[k])}
          </p>
        ) : null,
      )}
      {lists.map(([k, f]) => {
        const v = entry[k];
        if (!Array.isArray(v) || !v.length) {
          return null;
        }
        return (
          <div key={k} className="border-border-soft border-t pt-2">
            <div className={sectionLabel}>{labelOf(k, f)}</div>
            {f.kind === "list" && f.of.kind !== "object" ? (
              <Leaves of={f.of} values={v} root={root} />
            ) : (
              <Nested
                shape={entryShape(f.kind === "list" ? f.of : undefined, v as Entry[])}
                rows={v as Entry[]}
                root={root}
              />
            )}
          </div>
        );
      })}
    </article>
  );
}

function Entries({ of, rows, root }: { of: Of | undefined; rows: Entry[]; root: Entry }) {
  const shape = entryShape(of, rows);
  if (figures(shape)) {
    return <FigureTable shape={shape} rows={rows} root={root} />;
  }
  const rich = Object.values(shape.fields).some(
    (f) => f.kind === "list" || f.kind === "table" || (f.kind === "text" && f.long),
  );
  if (!rich) {
    return <EntryRows shape={shape} rows={rows} root={root} />;
  }
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,16rem),1fr))] gap-3">
      {rows.map((r, i) => (
        <EntryCard key={i} shape={shape} entry={r ?? {}} root={root} />
      ))}
    </div>
  );
}

export function JsonView({ step, json }: { step: AgentStep; json: unknown }) {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return <pre className="text-[0.8125rem]">{JSON.stringify(json, null, 2)}</pre>;
  }
  const root = json as Entry;
  const shape = stepShape(step);
  return (
    <div className="flex flex-col gap-5">
      {Object.entries(root).map(([key, v]) => {
        const f = shape.fields[key];
        const title = f ? labelOf(key, f) : key;
        let body: React.ReactNode;
        if (Array.isArray(v) && v.length && v.every((x) => x && typeof x === "object")) {
          body = (
            <Entries of={f?.kind === "list" ? f.of : undefined} rows={v as Entry[]} root={root} />
          );
        } else if (Array.isArray(v)) {
          body = (
            <Leaves of={f?.kind === "list" ? f.of : { kind: "text" }} values={v} root={root} />
          );
        } else if (v && typeof v === "object") {
          body = (
            <pre className="overflow-auto rounded-lg bg-paper-2 p-3 text-[0.75rem]">
              {JSON.stringify(v, null, 2)}
            </pre>
          );
        } else {
          const leaf = f && f.kind !== "list" && f.kind !== "table" ? f : { kind: "text" as const };
          body = (
            <div className="whitespace-pre-wrap text-[0.9375rem] leading-relaxed">
              {leafText(leaf, v, root)}
            </div>
          );
        }
        return (
          <section key={key}>
            <div className={sectionLabel}>{title}</div>
            {body}
          </section>
        );
      })}
    </div>
  );
}
