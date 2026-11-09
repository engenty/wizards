// SPDX-License-Identifier: FSL-1.1-MIT OR MIT
import { z } from "zod";
import {
  dataRef,
  declaredShape,
  type Field,
  type FormStep,
  isDecidedField,
  listRef,
  type Step,
  stepShape,
  type WizardDefinition,
} from "./definition.js";
import { type FieldShape, type ListShape, shapeJsonSchema, shapeZod } from "./shape.js";

/**
 * What a wizard takes and what it gives, as JSON Schema (draft 2020-12): for whoever starts a
 * run without a person, an MCP client, the API, a start (docs/plans/run-schemas.md). Both are
 * worked out from the definition and never written by hand: the forms say what a run takes, the
 * result step's `deliverables` and `data` what it gives.
 */

export type JsonSchema = Record<string, unknown>;

const DIALECT = "https://json-schema.org/draft/2020-12/schema";

/** Where every run ends up: past the last step, at `end` or at a result. */
const END = "\u0000end";

/**
 * The steps every run passes on its way to the end (`to: "end"`) or to a result step
 * (`to: "result"`): left out, the way there closes. Every rule's `goto` counts as a way, whatever
 * its condition, and so does `onFail`.
 */
function alwaysPassed(def: Pick<WizardDefinition, "steps">, to: "end" | "result"): Set<string> {
  const ways = new Map<string, string[]>();
  def.steps.forEach((step, i) => {
    if (step.type === "result") {
      ways.set(step.id, [END]);
      return;
    }
    const after = def.steps[i + 1]?.id ?? END;
    const rules = step.next ?? [];
    const gotos = rules.map((r) => (r.goto === "end" ? END : r.goto));
    const otherwise = rules.some((r) => r.when === undefined && r.ask === undefined);
    const out = [...gotos, ...(otherwise ? [] : [after]), ...(step.onFail ? [step.onFail] : [])];
    // Only a result counts as the end of a run that gives something back.
    ways.set(step.id, to === "result" ? out.filter((id) => id !== END) : out);
  });
  const start = def.steps[0]?.id;
  const reaches = (without: string | null): boolean => {
    if (!start || start === without) {
      return false;
    }
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length) {
      const id = queue.shift() as string;
      for (const next of ways.get(id) ?? []) {
        if (next === END) {
          return true;
        }
        if (next !== without && !seen.has(next) && ways.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    return false;
  };
  if (!reaches(null)) {
    return new Set();
  }
  return new Set(def.steps.map((s) => s.id).filter((id) => !reaches(id)));
}

/** Whether the run's own person answers the form: forms of the owner or the team are asked during the run. */
function personsForm(step: Step): step is FormStep {
  return step.type === "form" && (step.who ?? "person") === "person";
}

/** Choices a field takes for sure: its `options`, unless they only stand in for earlier data. */
function fixedOptions(field: Field): string[] | undefined {
  return field.optionsFrom || !field.options?.length ? undefined : field.options;
}

/** A field's answer as JSON Schema; null for what a client can't give (files, connections, lists). */
export function fieldJsonSchema(field: Field): JsonSchema | null {
  const value = ((): JsonSchema | null => {
    const options = fixedOptions(field);
    switch (field.kind) {
      case "text":
      case "textarea":
        return { type: "string" };
      case "email":
        return { type: "string", format: "email" };
      case "url":
        return { type: "string", format: "uri" };
      case "date":
        return { type: "string", format: "date" };
      case "number":
        return {
          type: "number",
          ...(field.min === undefined ? {} : { minimum: field.min }),
          ...(field.max === undefined ? {} : { maximum: field.max }),
        };
      case "select":
        return { type: "string", ...(options ? { enum: options } : {}) };
      case "multiselect":
        return {
          type: "array",
          items: { type: "string", ...(options ? { enum: options } : {}) },
          uniqueItems: true,
        };
      case "toggle":
        return { type: "boolean" };
      case "color":
        return { type: "string", pattern: "^#[0-9a-fA-F]{6}$" };
      case "items":
        return {
          type: "array",
          items: {
            type: "object",
            properties: Object.fromEntries(
              (field.columns ?? []).map((c) => [
                c.id,
                { title: c.label, type: c.kind === "text" ? "string" : "number" },
              ]),
            ),
            additionalProperties: false,
          },
        };
      case "location":
        return {
          anyOf: [
            { type: "string", description: "An address or a place." },
            {
              type: "object",
              properties: {
                lat: { type: "number", minimum: -90, maximum: 90 },
                lng: { type: "number", minimum: -180, maximum: 180 },
                label: { type: "string" },
              },
              required: ["lat", "lng"],
              additionalProperties: false,
            },
          ],
        };
      case "slot":
        return { type: "string", format: "date-time", ...(options ? { enum: options } : {}) };
      default:
        // image, file, audio, signature: an upload; connection and list: the person's own.
        return null;
    }
  })();
  if (!value) {
    return null;
  }
  return {
    title: field.label,
    ...(field.help ? { description: field.help } : {}),
    ...value,
    ...(field.default === undefined ? {} : { default: field.default }),
  };
}

/** A field that must be answered in every run: required, always shown, on a form every run reaches. */
function alwaysAsked(field: Field, form: FormStep, passed: Set<string>): boolean {
  return Boolean(field.required) && !field.when && !isDecidedField(field) && passed.has(form.id);
}

/**
 * What a run takes at its start: one property per field the run's own person answers, under the
 * field's id. Fields a decision picks, forms of the owner or the team, and uploads are left out:
 * they are asked during the run. An answer that is missing waits for the person.
 */
export function inputSchemaOf(def: Pick<WizardDefinition, "title" | "steps">): JsonSchema {
  const passed = alwaysPassed(def, "end");
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const step of def.steps) {
    if (!personsForm(step)) {
      continue;
    }
    for (const field of step.fields) {
      const schema = isDecidedField(field) ? null : fieldJsonSchema(field);
      if (!schema) {
        continue;
      }
      properties[field.id] = schema;
      if (alwaysAsked(field, step, passed)) {
        required.push(field.id);
      }
    }
  }
  return {
    $schema: DIALECT,
    title: def.title,
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  };
}

function zodJson(schema: z.ZodType): JsonSchema {
  const { $schema: _, ...rest } = z.toJSONSchema(schema, {
    target: "draft-2020-12",
  }) as JsonSchema;
  return rest;
}

const ANY: JsonSchema = {};
const ASSET: JsonSchema = { type: "string", description: "The id of a file of the run." };

/** One field of a step's output, as JSON Schema. */
function shapeFieldSchema(shape: FieldShape | ListShape["of"]): JsonSchema {
  return zodJson(shapeZod(shape));
}

/**
 * What a reference of the result's `data` gives, as the runner fills it (engine/surface.ts
 * `surfaceData`), and the step whose run it needs, if any.
 */
function refSchema(
  def: Pick<WizardDefinition, "steps" | "lists">,
  raw: string,
): { schema: JsonSchema; step?: string; field?: { field: Field; form: FormStep } } {
  const ref = dataRef(raw);
  const list = listRef(ref);
  if (list) {
    const columns = def.lists?.find((l) => l.id === list)?.columns ?? [];
    return {
      schema: {
        type: "array",
        items: {
          type: "object",
          properties: Object.fromEntries(columns.map((c) => [c.id, { title: c.name }])),
        },
      },
    };
  }
  const [head, id, key, ...more] = ref.split(".");
  if (head === "brand" || head === "today") {
    return { schema: { type: "string" } };
  }
  if (head !== "steps") {
    for (const step of def.steps) {
      const field = step.type === "form" ? step.fields.find((f) => f.id === ref) : undefined;
      if (field && step.type === "form") {
        return { schema: fieldJsonSchema(field) ?? ANY, field: { field, form: step } };
      }
    }
    return { schema: ANY };
  }
  const step = def.steps.find((s) => s.id === id);
  if (!step) {
    return { schema: ANY };
  }
  const at = { step: step.id };
  if (key === undefined) {
    switch (step.type) {
      case "agent":
        if (step.output.format !== "json") {
          return { ...at, schema: { type: "string" } };
        }
        if (step.each) {
          return { ...at, schema: { type: "object", properties: { rows: ROWS } } };
        }
        if (step.call && !declaredShape(step)) {
          return { ...at, schema: ANY };
        }
        return { ...at, schema: dropDialect(shapeJsonSchema(stepShape(step))) };
      case "decision":
        return { ...at, schema: dropDialect(shapeJsonSchema(stepShape(step))) };
      case "generate":
        return { ...at, schema: step.each ? { type: "array", items: ASSET } : ASSET };
      case "widget":
        return { ...at, schema: ASSET };
      default:
        return { ...at, schema: ANY };
    }
  }
  if (more.length) {
    return { ...at, schema: ANY };
  }
  if (step.type === "agent" || step.type === "decision") {
    if (step.type === "agent" && step.each && key === "rows") {
      return { ...at, schema: ROWS };
    }
    const shape = declaredShape(step)?.fields[key];
    return { ...at, schema: shape ? shapeFieldSchema(shape) : ANY };
  }
  if (step.type === "review" && key === "approved") {
    return { ...at, schema: { type: "boolean" } };
  }
  if ((step.type === "review" && key === "note") || key === "timedOut") {
    return { ...at, schema: key === "timedOut" ? { type: "boolean" } : { type: "string" } };
  }
  return { ...at, schema: ANY };
}

const ROWS: JsonSchema = { type: "array", items: { type: "object" } };

function dropDialect(schema: JsonSchema): JsonSchema {
  const { $schema: _, ...rest } = schema;
  return rest;
}

/**
 * What a finished run gives: `files`, the deliverables by where they come from, each with its
 * formats; and `data`, one property per key of the result's `data`. A key whose step some runs
 * skip, or whose field some runs leave empty, is optional. Without `data` the output is the
 * files alone.
 */
export function outputSchemaOf(
  def: Pick<WizardDefinition, "title" | "steps" | "lists">,
): JsonSchema {
  const results = def.steps.filter((s) => s.type === "result");
  const passed = alwaysPassed(def, "result");
  const files: Record<string, JsonSchema> = {};
  const data: Record<string, JsonSchema> = {};
  const counts = new Map<string, number>();
  const unsure = new Set<string>();
  for (const result of results) {
    for (const d of result.deliverables) {
      const formats = files[d.from]?.properties as Record<string, JsonSchema> | undefined;
      files[d.from] = {
        type: "object",
        ...(d.label ? { title: d.label } : {}),
        properties: {
          ...formats,
          ...Object.fromEntries(
            d.formats.map((f) => [f, { type: "string", format: "uri", description: `${f} file` }]),
          ),
        },
      };
    }
    for (const [key, raw] of Object.entries(result.data ?? {})) {
      const found = refSchema(def, raw);
      data[key] ??= found.schema;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      const given = found.field
        ? alwaysAsked(found.field.field, found.field.form, passed)
        : found.step
          ? passed.has(found.step)
          : true;
      if (!given) {
        unsure.add(key);
      }
    }
  }
  // A key that one result gives and another doesn't is optional.
  const required = Object.keys(data).filter(
    (key) => !unsure.has(key) && counts.get(key) === results.length,
  );
  const properties: Record<string, JsonSchema> = {
    files: { type: "object", properties: files, additionalProperties: false },
  };
  if (Object.keys(data).length) {
    properties.data = {
      type: "object",
      properties: data,
      ...(required.length ? { required } : {}),
      additionalProperties: false,
    };
  }
  return {
    $schema: DIALECT,
    title: def.title,
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}
