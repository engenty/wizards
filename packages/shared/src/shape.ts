// SPDX-License-Identifier: FSL-1.1-MIT OR MIT
import { z } from "zod";

/**
 * What a step's json output holds. `output.schema` writes it as a subset of JSON Schema
 * (`ObjectSchema`): strings, numbers, booleans, arrays and objects, with `title`, `description`,
 * `enum`, and `x-` keys of wizards' own: `x-long`, `x-unit`, `x-yes`/`x-no`, `x-ref`. It reads as
 * a shape (`ObjectShape`, `shapeOfSchema`) in kinds: text, a number, yes/no, a choice, an entry of
 * another list by its id (`ref`), and lists — of these or of objects (entries) with lists of their
 * own — every one with a label. The runtime builds the model's JSON Schema from the shape, the
 * admin shows and edits the data by it, downloads and views read it.
 *
 * `output.fields`, the short form, compiles to the same shape (`shapeOfFields`); two kinds exist
 * only there: `score` (a decision's levels) and `table` (rows of text or numbers, columns named
 * or picked by the model).
 */

/** Objects nest at most this deep, the step's own object counted. */
export const MAX_SHAPE_DEPTH = 4;
/** At most this many keys in all objects together. */
export const MAX_SHAPE_KEYS = 100;

interface Named {
  /** What people read: a column's head, a part's title, "add …". Without one, the key. */
  label?: string;
  /** What the model is to put there. */
  description?: string;
}

export type TextShape = Named & { kind: "text"; long?: boolean };
export type NumberShape = Named & { kind: "number"; unit?: string };
export type YesNoShape = Named & { kind: "yesno"; yes?: string; no?: string };
export type ChoiceShape = Named & { kind: "choice"; options: string[] };
/** An entry of a top-level list of the same output, by its `id`. */
export type RefShape = Named & { kind: "ref"; to: string };
export type LeafShape = TextShape | NumberShape | YesNoShape | ChoiceShape | RefShape;
export type ListShape = Named & { kind: "list"; of: LeafShape | ObjectShape };
export interface ObjectShape extends Named {
  kind: "object";
  fields: Record<string, FieldShape>;
}
/** `fields` only: a decision's levels, lowest first. */
export type ScoreShape = Named & { kind: "score"; options: string[] };
/** `fields` only: rows of text or numbers; without columns the model picks them. */
export type TableShape = Named & { kind: "table"; columns?: string[] };
export type FieldShape = LeafShape | ListShape | ScoreShape | TableShape;

interface Titled {
  /** What people read: a column's head, a part's title, "add …". Without one, the key. */
  title?: string;
  /** What the model is to put there. */
  description?: string;
}

/** Text; with `enum` one of its values, with `x-ref` the id of an entry of a top-level array. */
export type StringSchema = Titled & {
  type: "string";
  enum?: string[];
  /** Paragraphs, not a line. */
  "x-long"?: boolean;
  /** The key of a top-level array of objects whose entries have an `id`. */
  "x-ref"?: string;
};
export type NumberSchema = Titled & { type: "number" /** "min", "€" */; "x-unit"?: string };
/** `x-yes` / `x-no`: the words people read for true and false. */
export type BooleanSchema = Titled & { type: "boolean"; "x-yes"?: string; "x-no"?: string };
export type LeafSchema = StringSchema | NumberSchema | BooleanSchema;
export type ArraySchema = Titled & { type: "array"; items: LeafSchema | ObjectSchema };
export interface ObjectSchema extends Titled {
  type: "object";
  properties: Record<string, LeafSchema | ArraySchema>;
  /** Every key: a model fills each one. Left out, it means the same. */
  required?: string[];
  additionalProperties?: false;
}

const key = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/, "keys are letters, digits and _ and start with a letter");

const titled = {
  title: z.string().min(1).optional(),
  description: z.string().optional(),
};

const leaves = [
  z
    .object({
      type: z.literal("string"),
      ...titled,
      enum: z.array(z.string().min(1)).min(2).max(40).optional(),
      "x-long": z.boolean().optional(),
      "x-ref": key.optional(),
    })
    .refine((s) => !(s.enum && s["x-ref"]), {
      message: 'A string has "enum" or "x-ref", not both.',
    }),
  z.object({ type: z.literal("number"), ...titled, "x-unit": z.string().optional() }),
  z.object({
    type: z.literal("boolean"),
    ...titled,
    "x-yes": z.string().optional(),
    "x-no": z.string().optional(),
  }),
] as const;

const LEAF_TYPES = "string, number, boolean";

/**
 * The schema of an object `depth` deep, built level by level instead of recursively: JSON Schema
 * of the definition takes no $ref, and the depth is part of the schema. Objects are the items of
 * arrays (and the step's own); a property holding one object would only add a level.
 */
function objectAt(depth: number): z.ZodObject {
  const deeper: z.ZodObject | undefined = depth < MAX_SHAPE_DEPTH ? objectAt(depth + 1) : undefined;
  const items = deeper
    ? z.discriminatedUnion("type", [...leaves, deeper], {
        error: `An array holds ${LEAF_TYPES} or object.`,
      })
    : z.discriminatedUnion("type", [...leaves], {
        error: `An array this deep holds ${LEAF_TYPES}: objects nest at most ${MAX_SHAPE_DEPTH} deep.`,
      });
  const array = z.object({ type: z.literal("array"), ...titled, items });
  const property = z.discriminatedUnion("type", [...leaves, array], {
    error: `"type" is one of ${LEAF_TYPES}, array.`,
  });
  return z.object({
    type: z.literal("object"),
    ...titled,
    properties: z
      .record(key, property)
      .refine((p) => Object.keys(p).length > 0, { message: "An object has properties." }),
    required: z.array(key).optional(),
    additionalProperties: z.literal(false).optional(),
  });
}

/** Every object of a schema with where it sits, the schema's own first. */
function objectsOf(schema: ObjectSchema, at: (string | number)[] = []) {
  const out: { schema: ObjectSchema; at: (string | number)[] }[] = [{ schema, at }];
  for (const [k, p] of Object.entries(schema.properties)) {
    if (p.type === "array" && p.items.type === "object") {
      out.push(...objectsOf(p.items, [...at, "properties", k, "items"]));
    }
  }
  return out;
}

/** The array an `x-ref` points into: a top-level array of objects with an `id`. Null when fine. */
function refProblem(root: ObjectSchema, to: string): string | null {
  const target = root.properties[to];
  if (target?.type !== "array" || target.items.type !== "object") {
    return `"x-ref" to "${to}": that is no array of objects at the top of the schema.`;
  }
  return target.items.properties.id?.type === "string"
    ? null
    : `"x-ref" to "${to}": its items need an "id" string to be pointed at.`;
}

/** `output.schema`: what the step returns, as the subset of JSON Schema it is written in. */
export const outputSchemaSchema = (objectAt(1) as unknown as z.ZodType<ObjectSchema>).superRefine(
  (schema, ctx) => {
    const objects = objectsOf(schema);
    const keys = objects.reduce((n, o) => n + Object.keys(o.schema.properties).length, 0);
    if (keys > MAX_SHAPE_KEYS) {
      ctx.addIssue({
        code: "custom",
        message: `A schema has at most ${MAX_SHAPE_KEYS} keys in all; this one has ${keys}.`,
      });
    }
    for (const o of objects) {
      const names = Object.keys(o.schema.properties);
      const required = o.schema.required;
      if (
        required &&
        (required.length !== names.length || names.some((n) => !required.includes(n)))
      ) {
        ctx.addIssue({
          code: "custom",
          message: '"required" names every property: a model fills each one.',
          path: [...o.at, "required"],
        });
      }
      for (const [k, p] of Object.entries(o.schema.properties)) {
        const leaf = p.type === "array" ? p.items : p;
        const ref = leaf.type === "string" ? leaf["x-ref"] : undefined;
        const problem = ref ? refProblem(schema, ref) : null;
        if (problem) {
          ctx.addIssue({ code: "custom", message: problem, path: [...o.at, "properties", k] });
        }
      }
    }
  },
);

const shapes = new WeakMap<ObjectSchema, ObjectShape>();

/** A schema as written, read as a shape: what everything that reads a step's data goes by. */
export function shapeOfSchema(schema: ObjectSchema): ObjectShape {
  const known = shapes.get(schema);
  if (known) {
    return known;
  }
  const named = (s: Titled): Named => ({
    ...(s.title ? { label: s.title } : {}),
    ...(s.description !== undefined ? { description: s.description } : {}),
  });
  const leaf = (s: LeafSchema | ObjectSchema): LeafShape | ObjectShape => {
    switch (s.type) {
      case "string":
        return s.enum
          ? { kind: "choice", ...named(s), options: s.enum }
          : s["x-ref"]
            ? { kind: "ref", ...named(s), to: s["x-ref"] }
            : { kind: "text", ...named(s), ...(s["x-long"] ? { long: true } : {}) };
      case "number":
        return { kind: "number", ...named(s), ...(s["x-unit"] ? { unit: s["x-unit"] } : {}) };
      case "boolean":
        return {
          kind: "yesno",
          ...named(s),
          ...(s["x-yes"] ? { yes: s["x-yes"] } : {}),
          ...(s["x-no"] ? { no: s["x-no"] } : {}),
        };
      case "object":
        return {
          kind: "object",
          ...named(s),
          fields: Object.fromEntries(
            Object.entries(s.properties).map(([k, p]) => [
              k,
              p.type === "array"
                ? { kind: "list", ...named(p), of: leaf(p.items) as ListShape["of"] }
                : (leaf(p) as LeafShape),
            ]),
          ),
        };
    }
  };
  const shape = leaf(schema) as ObjectShape;
  shapes.set(schema, shape);
  return shape;
}

/** An output field as `output.fields` writes it. */
interface ShortField {
  id: string;
  kind: string;
  description?: string;
  columns?: string[];
  options?: string[];
}

/** The short form as a shape: a field per key, a list of text, a table as it is. */
export function shapeOfFields(fields: ShortField[]): ObjectShape {
  const one = (f: ShortField): FieldShape => {
    const d = f.description ? { description: f.description } : {};
    switch (f.kind) {
      case "number":
        return { kind: "number", ...d };
      case "list":
        return { kind: "list", ...d, of: { kind: "text" } };
      case "yesno":
        return { kind: "yesno", ...d };
      case "choice":
        return { kind: "choice", ...d, options: f.options ?? [] };
      case "score":
        return { kind: "score", ...d, options: f.options ?? [] };
      case "table":
        return { kind: "table", ...d, ...(f.columns?.length ? { columns: f.columns } : {}) };
      default:
        return { kind: "text", ...d };
    }
  };
  return { kind: "object", fields: Object.fromEntries(fields.map((f) => [f.id, one(f)])) };
}

/** The key of an entry's title: its first short text other than its `id`. */
export function titleKey(shape: ObjectShape): string | undefined {
  return Object.entries(shape.fields).find(
    ([k, f]) => k !== "id" && f.kind === "text" && !f.long,
  )?.[0];
}

/** What people read for a key. */
export function labelOf(key: string, shape: FieldShape | ListShape["of"]): string {
  return shape.label ?? key;
}

/**
 * What the model reads about a value beside its title: its description (without label: its key),
 * its unit, a score's order, where a ref points. Undefined where the title says it all.
 */
function about(k: string, s: FieldShape | ListShape["of"]): string | undefined {
  const base = s.description ?? (s.label ? "" : k);
  const more =
    s.kind === "number" && s.unit
      ? `in ${s.unit}`
      : s.kind === "score"
        ? "lowest to highest"
        : s.kind === "ref"
          ? `the id of an entry of "${s.to}"`
          : "";
  return (base && more ? `${base} (${more})` : base || more) || undefined;
}

const CELL = z.union([z.string(), z.number(), z.null()]);

/** The data a shape describes, as Zod: what a model's answer is checked against. */
export function shapeZod(shape: FieldShape | ListShape["of"], k = "data"): z.ZodType {
  const description = about(k, shape);
  const meta = {
    ...(shape.label ? { title: shape.label } : {}),
    ...(description ? { description } : {}),
  };
  switch (shape.kind) {
    case "text":
    case "ref":
      return z.string().meta(meta);
    case "number":
      return z.number().meta(meta);
    case "yesno":
      return z.boolean().meta(meta);
    case "choice":
    case "score":
      return z.enum(shape.options as [string, ...string[]]).meta(meta);
    case "list":
      return z.array(shapeZod(shape.of, k)).meta(meta);
    case "object":
      return z
        .object(
          Object.fromEntries(Object.entries(shape.fields).map(([n, f]) => [n, shapeZod(f, n)])),
        )
        .meta(meta);
    case "table":
      return (
        shape.columns?.length
          ? z.array(z.object(Object.fromEntries(shape.columns.map((c) => [c, CELL]))))
          : // Free columns come as columns + rows, which a strict schema takes; stored as records.
            z.object({ columns: z.array(z.string()), rows: z.array(z.array(CELL)) })
      ).meta(meta);
  }
}

/**
 * The data as JSON Schema (draft 2020-12): every key required, no other keys — what a model's
 * structured output takes, and what developers read.
 */
export function shapeJsonSchema(shape: ObjectShape, title?: string): Record<string, unknown> {
  const schema = z.toJSONSchema(shapeZod(shape), { target: "draft-2020-12" }) as Record<
    string,
    unknown
  >;
  return title && !shape.label ? { ...schema, title } : schema;
}

/** A table cell as a table takes it: a list joined by spaces, anything else as text. */
function fitCell(value: unknown): string | number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string" || typeof value === "number") {
    return value;
  }
  if (Array.isArray(value) && value.every((v) => typeof v === "string" || typeof v === "number")) {
    return value.join(" ");
  }
  return typeof value === "boolean" ? String(value) : JSON.stringify(value);
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v);

/**
 * Data a model wrote itself, fitted to the shape before it is checked: a number where text
 * belongs as text, a number written as text as a number; in a table a cell's list joined and a
 * missing column empty. Lists stay lists everywhere else.
 */
export function fitData(shape: FieldShape | ListShape["of"], value: unknown): unknown {
  switch (shape.kind) {
    case "text":
    case "ref":
      return typeof value === "number" ? String(value) : value;
    case "number":
      return typeof value === "string" && value.trim() && Number.isFinite(Number(value))
        ? Number(value)
        : value;
    case "list":
      return Array.isArray(value) ? value.map((v) => fitData(shape.of, v)) : value;
    case "object":
      if (!isRecord(value)) {
        return value;
      }
      return {
        ...value,
        ...Object.fromEntries(
          Object.entries(shape.fields)
            .filter(([k]) => k in value)
            .map(([k, f]) => [k, fitData(f, value[k])]),
        ),
      };
    case "table": {
      const columns = shape.columns;
      return columns?.length && Array.isArray(value)
        ? value.map((row) =>
            isRecord(row) ? Object.fromEntries(columns.map((c) => [c, fitCell(row[c])])) : row,
          )
        : value;
    }
    default:
      return value;
  }
}

/** Tables with free columns come back as columns + rows and are stored as records. */
export function recordsOf(shape: FieldShape | ListShape["of"], value: unknown): unknown {
  if (shape.kind === "table" && !shape.columns?.length && isRecord(value)) {
    const t = value as { columns?: string[]; rows?: unknown[][] };
    if (t.columns && t.rows) {
      const columns = t.columns;
      return t.rows.map((row) => Object.fromEntries(columns.map((c, i) => [c, row[i] ?? null])));
    }
  }
  if (shape.kind === "object" && isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => {
        const f = shape.fields[k];
        return [k, f ? recordsOf(f, v) : v];
      }),
    );
  }
  if (shape.kind === "list" && Array.isArray(value)) {
    return value.map((v) => recordsOf(shape.of, v));
  }
  return value;
}

/** What a value of a shape is, in a word or two: "list of Rezept", "choice: a | b". */
function kindLine(s: FieldShape | ListShape["of"]): string {
  switch (s.kind) {
    case "choice":
    case "score":
      return `${s.kind}: ${s.options.join(" | ")}`;
    case "ref":
      return `ref → /${s.to}[].id`;
    case "table":
      return s.columns?.length ? `table: ${s.columns.join(", ")}` : "table";
    case "list":
      return s.of.kind === "object" ? "list of entries" : `list of ${s.of.kind}`;
    default:
      return s.kind;
  }
}

/** The shape as lines of paths a model binds to: "/recipes[]/title (text): Titel". */
export function shapeLines(shape: ObjectShape, at = ""): string[] {
  const out: string[] = [];
  for (const [k, f] of Object.entries(shape.fields)) {
    const path = `${at}/${k}`;
    const words = [f.label, f.description].filter(Boolean).join(" — ");
    out.push(`- ${path} (${kindLine(f)})${words ? `: ${words}` : ""}`);
    if (f.kind === "list" && f.of.kind === "object") {
      out.push(...shapeLines(f.of, `${path}[]`));
    }
  }
  return out;
}

/**
 * The shape at a path: keys of objects, an index (digits) into a list. `any` where the data can
 * hold anything (a table's row), undefined where the shape has nothing.
 */
export function shapeAt(
  shape: FieldShape | ListShape["of"],
  path: string[],
): FieldShape | ListShape["of"] | "any" | undefined {
  let at: FieldShape | ListShape["of"] = shape;
  for (const part of path) {
    if (at.kind === "object") {
      const next: FieldShape | undefined = at.fields[part];
      if (!next) {
        return undefined;
      }
      at = next;
    } else if (at.kind === "list" && /^\d+$/.test(part)) {
      at = at.of;
    } else if (at.kind === "table") {
      // A row, and in it whatever columns the model wrote.
      return /^\d+$/.test(part) ? "any" : undefined;
    } else {
      return undefined;
    }
  }
  return at;
}
