import {
  type FieldShape,
  type ListShape,
  labelOf,
  type ObjectShape,
  titleKey,
} from "@engenty-wizards/shared/shape";

/**
 * Downloads of a step with `output.schema`, read by its shape: labels for keys, an entry a `ref`
 * points at by its title, yes/no in the step's words.
 */

type Shape = FieldShape | ListShape["of"];
type Entry = Record<string, unknown>;

const isEntry = (v: unknown): v is Entry =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** A value that fits in a cell or a line: no lists of entries, no objects. */
const flat = (s: Shape) =>
  s.kind !== "object" && s.kind !== "table" && !(s.kind === "list" && s.of.kind === "object");

/** An entry's title: its first short text. */
function titleOf(shape: ObjectShape, entry: Entry): string {
  const key = titleKey(shape);
  return key ? String(entry[key] ?? "") : "";
}

/** A flat value as words. */
function words(s: Shape, value: unknown, root: ObjectShape, data: Entry): string {
  if (value === null || value === undefined) {
    return "";
  }
  switch (s.kind) {
    case "yesno":
      return value ? (s.yes ?? "✓") : (s.no ?? "–");
    case "number":
      return `${value}${s.unit ? ` ${s.unit}` : ""}`;
    case "ref": {
      const target = root.fields[s.to];
      const list = Array.isArray(data[s.to]) ? (data[s.to] as unknown[]) : [];
      const hit = list.find((e) => isEntry(e) && e.id === value);
      return target?.kind === "list" && target.of.kind === "object" && isEntry(hit)
        ? titleOf(target.of, hit) || String(value)
        : String(value);
    }
    case "list":
      return Array.isArray(value) ? value.map((v) => words(s.of, v, root, data)).join(", ") : "";
    default:
      return typeof value === "object" ? JSON.stringify(value) : String(value);
  }
}

/** One row of a sheet: flat values by label; a list of entries as their titles. */
function rowOf(shape: ObjectShape, entry: Entry, root: ObjectShape, data: Entry): Entry {
  const row: Entry = {};
  for (const [k, f] of Object.entries(shape.fields)) {
    const v = entry[k];
    if (f.kind === "list" && f.of.kind === "object") {
      const of = f.of;
      row[labelOf(k, f)] = Array.isArray(v)
        ? v
            .map((e) => (isEntry(e) ? titleOf(of, e) : ""))
            .filter(Boolean)
            .join("; ")
        : "";
    } else if (f.kind === "number" && typeof v === "number") {
      row[labelOf(k, f)] = v;
    } else if (flat(f)) {
      row[labelOf(k, f)] = words(f, v, root, data);
    }
  }
  return row;
}

/** One sheet per top-level list, named by its label. */
export function shapedTables(shape: ObjectShape, data: Entry): { name: string; rows: Entry[] }[] {
  const out: { name: string; rows: Entry[] }[] = [];
  for (const [k, f] of Object.entries(shape.fields)) {
    const value = Array.isArray(data[k]) ? (data[k] as unknown[]) : [];
    if (f.kind !== "list" || !value.length) {
      continue;
    }
    const of = f.of;
    const rows =
      of.kind === "object"
        ? value.filter(isEntry).map((e) => rowOf(of, e, shape, data))
        : value.map((v) => ({ [labelOf(k, f)]: words(of, v, shape, data) }));
    out.push({ name: labelOf(k, f), rows });
  }
  return out;
}

/** The rows of the first top-level list whose entries are flat: what a CSV holds. */
export function shapedCsvRows(shape: ObjectShape, data: Entry): Entry[] | null {
  for (const [k, f] of Object.entries(shape.fields)) {
    if (
      f.kind === "list" &&
      f.of.kind === "object" &&
      Object.values(f.of.fields).every(flat) &&
      Array.isArray(data[k])
    ) {
      const of = f.of;
      return (data[k] as unknown[]).filter(isEntry).map((e) => rowOf(of, e, shape, data));
    }
  }
  return null;
}

const cellText = (v: unknown) =>
  String(v ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\n/g, " ");

/** The tree as Markdown: a heading per part and per entry with lists of its own, tables for flat entries. */
export function shapedMarkdown(shape: ObjectShape, data: Entry): string {
  return objectMarkdown(shape, data, 2, shape, data);
}

const h = (n: number) => "#".repeat(Math.min(6, n));

function objectMarkdown(
  shape: ObjectShape,
  value: Entry,
  depth: number,
  root: ObjectShape,
  data: Entry,
): string {
  const parts: string[] = [];
  const short: string[] = [];
  // An entry under its title as a heading says neither the title nor its id again.
  const skip = shape === root ? [] : ["id", titleKey(shape)];
  for (const [k, f] of Object.entries(shape.fields)) {
    const v = value[k];
    const label = labelOf(k, f);
    if (v === undefined || v === null || v === "" || skip.includes(k)) {
      continue;
    }
    if (f.kind === "text" && f.long) {
      parts.push(`${h(depth)} ${label}\n\n${String(v)}`);
    } else if (f.kind === "list" && Array.isArray(v)) {
      parts.push(`${h(depth)} ${label}\n\n${listMarkdown(f, v, depth + 1, root, data)}`);
    } else if (flat(f)) {
      short.push(`**${label}:** ${words(f, v, root, data)}`);
    }
  }
  return [short.join("  \n"), ...parts].filter(Boolean).join("\n\n");
}

function listMarkdown(
  f: ListShape,
  value: unknown[],
  depth: number,
  root: ObjectShape,
  data: Entry,
): string {
  const of = f.of;
  if (of.kind !== "object") {
    return value.map((v) => `- ${words(of, v, root, data)}`).join("\n");
  }
  const entries = value.filter(isEntry);
  if (Object.values(of.fields).every(flat)) {
    const cols = Object.entries(of.fields);
    return [
      `| ${cols.map(([c, s]) => cellText(labelOf(c, s))).join(" | ")} |`,
      `| ${cols.map(() => "---").join(" | ")} |`,
      ...entries.map(
        (e) => `| ${cols.map(([c, s]) => cellText(words(s, e[c], root, data))).join(" | ")} |`,
      ),
    ].join("\n");
  }
  return entries
    .map((e, i) => {
      const title = titleOf(of, e) || `${of.label ?? f.label ?? ""} ${i + 1}`.trim();
      return `${h(depth)} ${title}\n\n${objectMarkdown(of, e, depth + 1, root, data)}`;
    })
    .join("\n\n");
}
