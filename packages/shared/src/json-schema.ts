import { z } from "zod";
import { DEFINITION_VERSION, wizardSchema } from "./definition.js";
import { manifestSchema, PACKAGE_SCHEMA_URL, WIZARD_SCHEMA_URL } from "./wizard-package.js";

/**
 * The definition and the package's `wizard.json` as JSON Schema, for editors and for checks
 * outside this app. Written from the Zod schemas the app parses with (`pnpm schema`), so the two
 * cannot drift; a test compares the published files with a fresh run.
 *
 * What JSON Schema cannot say stays with the app: the schema's refinements and `validateWizard`
 * (ids, references between steps, templates). `wizards validate` checks both.
 */

type JsonSchema = Record<string, unknown>;

const DIALECT = "https://json-schema.org/draft/2020-12/schema";

/** `$comment` is the one place a validator ignores; an unknown `$license` keyword would trip Ajv's strict mode. */
const LICENSE_COMMENT = "MIT License. Copyright (c) 2026 Matthias Platzer.";

const SCHEMA_PROPERTY = {
  type: "string",
  description: "The JSON Schema an editor checks this file against; the app does not read it.",
};

/**
 * Objects take no other keys. The app drops an unknown key without a word, so a typo would
 * vanish on the first save; an editor says so instead. Loose objects (a surface component's
 * props) stay open.
 */
function closeObjects(ctx: { zodSchema: unknown; jsonSchema: JsonSchema }) {
  const def = (ctx.zodSchema as { _zod: { def: { type: string; catchall?: unknown } } })._zod.def;
  if (def.type === "object" && def.catchall === undefined) {
    ctx.jsonSchema.additionalProperties = false;
  }
}

function generate(schema: z.ZodType): JsonSchema {
  const { $schema: _, ...rest } = z.toJSONSchema(schema, {
    io: "input",
    target: "draft-2020-12",
    override: closeObjects,
  }) as JsonSchema;
  if (JSON.stringify(rest).includes('"$ref"')) {
    // The package schema embeds this one under $defs; a reference of its own would point wrong.
    throw new Error("The wizard schema has a $ref; embed it differently.");
  }
  return rest;
}

function withSchemaProperty(schema: JsonSchema): JsonSchema {
  const properties = schema.properties as Record<string, JsonSchema>;
  return { ...schema, properties: { $schema: SCHEMA_PROPERTY, ...properties } };
}

/** A wizard's definition: what `get_wizard` returns and `replace_wizard` takes. */
export function wizardJsonSchema(): JsonSchema {
  return {
    $schema: DIALECT,
    $id: WIZARD_SCHEMA_URL,
    $comment: LICENSE_COMMENT,
    title: "engenty.wizards wizard definition",
    description: `A wizard's definition, version ${DEFINITION_VERSION}. Checked by \`wizards validate\`, which also checks what this schema cannot say: ids, references between steps and templates.`,
    ...withSchemaProperty(generate(wizardSchema)),
  };
}

/** `wizard.json` in a `.wizard` package: the definition with what it needs from its project. */
export function packageJsonSchema(): JsonSchema {
  const manifest = generate(manifestSchema);
  const properties = manifest.properties as Record<string, JsonSchema>;
  return {
    $schema: DIALECT,
    $id: PACKAGE_SCHEMA_URL,
    $comment: LICENSE_COMMENT,
    title: "engenty.wizards package manifest (wizard.json)",
    description:
      "wizard.json in a .wizard package — a zip with this file and the wizard's workspace under files/.",
    ...manifest,
    properties: {
      ...properties,
      definition: { $ref: "#/$defs/definition" },
    },
    $defs: { definition: withSchemaProperty(generate(wizardSchema)) },
  };
}
