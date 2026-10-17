// Writes the JSON Schemas of a wizard's definition and of a package's wizard.json into the docs
// site's public folder, where engenty.ai/schema/v<version>/… serves them (apps/docs/next.config.mjs).
// Commit both; a test fails when they differ from the Zod schemas.
//
//   pnpm schema
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DEFINITION_VERSION } from "../src/definition.js";
import { packageJsonSchema, wizardJsonSchema } from "../src/json-schema.js";

const out = resolve(import.meta.dirname, "../../../apps/docs/public/schema");

function write(path: string, schema: unknown) {
  const file = join(out, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(schema, null, 2)}\n`);
  console.log(`wrote ${file}`);
}

write(`v${DEFINITION_VERSION}/wizard.json`, wizardJsonSchema());
write(`v${DEFINITION_VERSION}/wizard-package.json`, packageJsonSchema());
