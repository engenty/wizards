import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  allFields,
  parseWizard,
  validateWizard,
  type WizardDefinition,
  wizardSchema,
} from "@engenty/wizards-shared/definition";
import { inputSchemaOf, outputSchemaOf } from "@engenty/wizards-shared/run-schema";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
// @ts-expect-error: a plain script, with no types.
import { toVersion1 } from "../scripts/definition-v1.mjs";
import { EXAMPLE_WIZARD } from "../src/authoring/example";
import { readPackage } from "../src/services/package-file";

const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });

const wizard = (steps: unknown[], extra: Record<string, unknown> = {}): WizardDefinition =>
  wizardSchema.parse({ title: "Test", description: "", avatar: "round", steps, ...extra });

const result = (extra: Record<string, unknown> = {}) => ({
  id: "done",
  type: "result",
  title: "Done",
  deliverables: [],
  ...extra,
});

/** The example wizards of the repository, the starters of wizards.page, as version 1. */
function examples(): { name: string; def: WizardDefinition }[] {
  const root = join(import.meta.dirname, "../../../examples/wizards");
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".wizard"))
    .flatMap((e) => {
      const { manifest } = readPackage(readFileSync(join(e.parentPath, e.name)));
      const converted = toVersion1(structuredClone(manifest.definition));
      const parsed = parseWizard(converted.def ?? manifest.definition);
      return parsed.ok ? [{ name: e.name, def: parsed.wizard }] : [];
    });
}

describe("inputSchemaOf", () => {
  it("gives the authoring guide's example its fields, the required one required", () => {
    const schema = inputSchemaOf(EXAMPLE_WIZARD);
    expect(schema).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: "X post with an image",
      type: "object",
      required: ["topic"],
      additionalProperties: false,
      properties: {
        topic: { type: "string", title: "Topic or occasion" },
        tone: {
          type: "string",
          enum: ["Casual", "Professional", "Funny", "Inspiring"],
          default: "Casual",
        },
        link: { type: "string", format: "uri" },
      },
    });
  });

  it("maps every kind a client can give, and leaves out uploads, connections and lists", () => {
    const def = wizard(
      [
        {
          id: "ask",
          type: "form",
          title: "Ask",
          fields: [
            { id: "mail", label: "Mail", kind: "email", required: true, help: "Where we write" },
            { id: "day", label: "Day", kind: "date" },
            { id: "budget", label: "Budget", kind: "number", min: 100, max: 900 },
            { id: "tags", label: "Tags", kind: "multiselect", options: ["a", "b"] },
            { id: "from", label: "From", kind: "select", optionsFrom: "lists.places.name" },
            { id: "ok", label: "OK", kind: "toggle" },
            { id: "tint", label: "Tint", kind: "color" },
            {
              id: "lines",
              label: "Lines",
              kind: "items",
              columns: [
                { id: "what", label: "What", kind: "text" },
                { id: "price", label: "Price", kind: "money" },
              ],
            },
            { id: "where", label: "Where", kind: "location" },
            { id: "when", label: "When", kind: "slot", options: ["2026-12-01T09:00:00+01:00"] },
            { id: "photo", label: "Photo", kind: "image", required: true },
            { id: "doc", label: "Doc", kind: "file" },
            { id: "voice", label: "Voice", kind: "audio" },
            { id: "sign", label: "Sign", kind: "signature" },
          ],
        },
        result(),
      ],
      {
        lists: [
          {
            id: "places",
            title: "Places",
            columns: [{ id: "name", name: "Name", type: "text" }],
          },
        ],
      },
    );
    const schema = inputSchemaOf(def);
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(Object.keys(props)).toEqual([
      "mail",
      "day",
      "budget",
      "tags",
      "from",
      "ok",
      "tint",
      "lines",
      "where",
      "when",
    ]);
    expect(schema.required).toEqual(["mail"]);
    expect(props.mail).toEqual({
      title: "Mail",
      description: "Where we write",
      type: "string",
      format: "email",
    });
    expect(props.budget).toMatchObject({ type: "number", minimum: 100, maximum: 900 });
    expect(props.tags).toMatchObject({ type: "array", items: { enum: ["a", "b"] } });
    // Choices from earlier data are not known before the run.
    expect(props.from).toEqual({ title: "From", type: "string" });
    expect(props.lines).toMatchObject({
      type: "array",
      items: { properties: { what: { type: "string" }, price: { type: "number" } } },
    });
    expect(props.when).toMatchObject({ format: "date-time", enum: ["2026-12-01T09:00:00+01:00"] });
    const check = ajv.compile(schema);
    expect(check({ mail: "a@b.at", budget: 200, lines: [{ what: "x", price: 3 }] })).toBe(true);
    expect(check({ budget: 200 })).toBe(false);
    expect(check({ mail: "a@b.at", budget: 50 })).toBe(false);
    expect(check({ mail: "a@b.at", where: { lat: 47.8, lng: 13 } })).toBe(true);
    expect(check({ mail: "a@b.at", nope: 1 })).toBe(false);
  });

  it("asks for sure only what every run asks: no branch, no condition, no decision", () => {
    const def = wizard([
      {
        id: "first",
        type: "form",
        title: "First",
        fields: [
          { id: "name", label: "Name", kind: "text", required: true },
          { id: "kind", label: "Kind", kind: "select", options: ["firm", "private"], required: true },
          {
            id: "firm",
            label: "Firm",
            kind: "text",
            required: true,
            when: { field: "kind", op: "eq", value: "firm" },
          },
          { id: "phone", label: "Phone", kind: "text", required: true, group: "reach" },
          { id: "note", label: "Note", kind: "text", required: true, ask: "The person is upset" },
        ],
        groups: [{ id: "reach", instructions: "How do we reach them?" }],
        next: [{ when: { field: "kind", op: "eq", value: "private" }, goto: "home" }],
      },
      {
        id: "office",
        type: "form",
        title: "Office",
        fields: [{ id: "desk", label: "Desk", kind: "text", required: true }],
        next: [{ goto: "both" }],
      },
      {
        id: "home",
        type: "form",
        title: "Home",
        fields: [{ id: "garden", label: "Garden", kind: "toggle", required: true }],
      },
      {
        id: "both",
        type: "form",
        title: "Both",
        fields: [{ id: "budget", label: "Budget", kind: "number", required: true }],
      },
      {
        id: "boss",
        type: "form",
        title: "Boss",
        who: "owner",
        fields: [{ id: "ok", label: "OK", kind: "toggle", required: true }],
      },
      result(),
    ]);
    const schema = inputSchemaOf(def);
    expect(Object.keys(schema.properties as object)).toEqual([
      "name",
      "kind",
      "firm",
      "desk",
      "garden",
      "budget",
    ]);
    expect(schema.required).toEqual(["name", "kind", "budget"]);
  });

  it("takes a form after a branch to the end as optional", () => {
    const def = wizard([
      {
        id: "first",
        type: "form",
        title: "First",
        fields: [{ id: "go", label: "Go on?", kind: "toggle" }],
        next: [{ when: { field: "go", op: "eq", value: false }, goto: "end" }],
      },
      {
        id: "more",
        type: "form",
        title: "More",
        fields: [{ id: "detail", label: "Detail", kind: "text", required: true }],
      },
      result(),
    ]);
    expect(inputSchemaOf(def).required).toBeUndefined();
  });
});

describe("outputSchemaOf", () => {
  const steps = [
    {
      id: "ask",
      type: "form",
      title: "Ask",
      fields: [
        { id: "name", label: "Name", kind: "text", required: true },
        { id: "extra", label: "Extra", kind: "text" },
      ],
      next: [{ when: { field: "extra", op: "exists" }, goto: "more" }],
    },
    {
      id: "reply",
      type: "agent",
      title: "Reply",
      instructions: "Answer {{name}}.",
      output: { format: "text" },
      next: [{ goto: "check" }],
    },
    {
      id: "more",
      type: "agent",
      title: "More",
      instructions: "More on {{extra}}.",
      output: { format: "text" },
    },
    {
      id: "check",
      type: "decision",
      title: "Check",
      instructions: "Is {{name}} urgent?",
      output: { fields: [{ id: "urgent", kind: "yesno", description: "Is it urgent?" }] },
    },
    result({
      deliverables: [{ from: "reply", label: "Reply", formats: ["txt", "md"] }],
      data: {
        reply: "steps.reply",
        more: "steps.more",
        urgent: "steps.check.urgent",
        whole: "{{steps.check}}",
        name: "name",
        extra: "extra",
        brand: "brand.name",
      },
    }),
  ];

  it("gives the files, and the data with what each step hands on", () => {
    const def = wizard(steps);
    expect(validateWizard(def)).toEqual([]);
    const schema = outputSchemaOf(def);
    expect(schema.required).toEqual(["files", "data"]);
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(props.files).toMatchObject({
      properties: {
        reply: {
          title: "Reply",
          properties: { txt: { format: "uri" }, md: { format: "uri" } },
        },
      },
    });
    expect(props.data).toMatchObject({
      properties: {
        reply: { type: "string" },
        more: { type: "string" },
        urgent: { type: "boolean" },
        whole: { type: "object", properties: { urgent: { type: "boolean" } } },
        name: { type: "string", title: "Name" },
        extra: { type: "string" },
        brand: { type: "string" },
      },
    });
    // "reply" and "more" each run on one branch only, "extra" is not required.
    expect(props.data.required).toEqual(["urgent", "whole", "name", "brand"]);
    expect(ajv.validateSchema(schema)).toBe(true);
  });

  it("is the files alone without data", () => {
    const schema = outputSchemaOf(EXAMPLE_WIZARD);
    expect(Object.keys(schema.properties as object)).toEqual(["files"]);
  });
});

describe("data on the result step", () => {
  it("reads only what runs before the result", () => {
    const def = wizard([
      {
        id: "ask",
        type: "form",
        title: "Ask",
        fields: [{ id: "name", label: "Name", kind: "text" }],
      },
      result({
        data: {
          name: "name",
          gone: "nobody",
          later: "steps.later",
          rows: "lists.unknown",
          "bad-key": "name",
        },
      }),
    ]);
    expect(validateWizard(def).map((i) => i.message)).toEqual([
      '"{{nobody}}" refers to a field that is not asked before "done".',
      '"{{steps.later}}" refers to a step that has not run before "done".',
      'Result data reads an unknown list "unknown".',
      'Result data key "bad-key" is not an identifier.',
    ]);
  });
});

describe("the schemas of the example wizards", () => {
  const all = examples();

  it("are read from every example", () => {
    expect(all.length).toBeGreaterThan(5);
  });

  it.each(all.map((e) => [e.name, e.def] as const))("%s: valid JSON Schema", (_, def) => {
    const input = inputSchemaOf(def);
    const output = outputSchemaOf(def);
    expect(ajv.validateSchema(input), JSON.stringify(ajv.errors)).toBe(true);
    expect(ajv.validateSchema(output), JSON.stringify(ajv.errors)).toBe(true);
    const ids = new Set(allFields(def).map((f) => f.id));
    for (const key of Object.keys(input.properties as object)) {
      expect(ids.has(key)).toBe(true);
    }
    for (const key of (input.required as string[] | undefined) ?? []) {
      expect(Object.keys(input.properties as object)).toContain(key);
    }
    expect(Object.keys((output.properties as { files: { properties: object } }).files.properties))
      .toEqual([
        ...new Set(def.steps.flatMap((s) => (s.type === "result" ? s.deliverables : [])).map((d) => d.from)),
      ]);
  });
});
