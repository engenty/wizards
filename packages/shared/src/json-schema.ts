import { z } from "zod";
import {
  DEFINITION_VERSION,
  KERNEL_VERSION,
  kernelFileSchema,
  wizardShapeV020,
} from "./definition.js";
import { themeSchema } from "./theme.js";
import {
  manifestSchema,
  PACKAGE_SCHEMA_URL,
  THEME_SCHEMA_URL,
  WIZARD_SCHEMA_URL,
} from "./wizard-package.js";

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
    ...withSchemaProperty(generate(wizardShapeV020)),
  };
}

/** `wizard.json` in a `.wizard` package: the definition with what it needs from its space. */
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
    $defs: { definition: withSchemaProperty(generate(wizardShapeV020)) },
  };
}

/** Where the file of a wizard made of step files is described. */
export const KERNEL_SCHEMA_URL = `https://engenty.ai/schema/v${KERNEL_VERSION}/wizard.json`;

/**
 * `wizard.json` of a wizard in version 0.3.0: the file beside its `steps/<id>.ts`. What a step
 * does is in its file, not here (docs/plans/kernel.md).
 */
export function kernelJsonSchema(): JsonSchema {
  return {
    $schema: DIALECT,
    $id: KERNEL_SCHEMA_URL,
    $comment: LICENSE_COMMENT,
    title: "engenty.wizards wizard file (version 0.3.0)",
    description: `wizard.json of a wizard made of step files, version ${KERNEL_VERSION}: what it needs and may reach, its input, output and result page, and the map of its steps. Each step is a file steps/<id>.ts.`,
    ...withSchemaProperty(generate(kernelFileSchema)),
  };
}

/** A theme: how a wizard's pages look, values only (docs/plans/themes.md). Versioned apart from the wizard's. */
export function themeJsonSchema(): JsonSchema {
  return {
    $schema: DIALECT,
    $id: THEME_SCHEMA_URL,
    $comment: LICENSE_COMMENT,
    title: "engenty.wizards theme",
    description:
      "A theme of a space: colours for light and dark pages, fonts, shape and effects from the runner's library. Values only.",
    ...withSchemaProperty(generate(themeSchema)),
  };
}
