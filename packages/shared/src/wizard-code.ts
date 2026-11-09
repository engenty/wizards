/**
 * Code a wizard brings in its own workspace (docs/plans/wizard-code.md): function tools under
 * `tools/<name>.ts`, later agents under `agents/<name>.md`. A step names them in `tools` with a
 * prefix: `wizard.<name>`, `agent.<name>`. The prefixes are no plugin ids.
 *
 * Shared by the definition's checks, the runtime, `wizards validate` and the studio, so the ids
 * and paths are read the same everywhere.
 */

/** The prefixes of a step's tool id that name the wizard's own code. */
export const WIZARD_CODE_PREFIXES = ["wizard", "agent"] as const;
export type WizardCodeKind = "tool" | "agent";

/** A name of a wizard's tool or agent: what follows the prefix, and its file name. */
export const WIZARD_CODE_NAME = /^[a-z][a-z0-9_]{0,39}$/;

/** The folder of the workspace that holds the wizard's function tools. */
export const WIZARD_TOOLS_DIR = "tools/";
/** The files a function tool may be written in. */
export const WIZARD_TOOL_EXTENSIONS = [".ts", ".js"] as const;

/** What a step's tool id names of the wizard's own code; null for a built-in or a plugin's tool. */
export function wizardCodeOf(id: string): { kind: WizardCodeKind; name: string } | null {
  const [prefix, name, ...rest] = id.split(".");
  if (name === undefined || rest.length || !WIZARD_CODE_NAME.test(name)) {
    return null;
  }
  return prefix === "wizard"
    ? { kind: "tool", name }
    : prefix === "agent"
      ? { kind: "agent", name }
      : null;
}

/** Whether a tool id starts with one of the prefixes, well formed or not. */
export function hasWizardCodePrefix(id: string): boolean {
  return WIZARD_CODE_PREFIXES.some((prefix) => id.startsWith(`${prefix}.`));
}

/** The step's tool id of the wizard's function tool `name`. */
export const wizardToolId = (name: string) => `wizard.${name}`;

/** The tool's name as the model calls it: tool names take no dot. */
export const wizardToolCallName = (name: string) => `wizard_${name}`;

/** The function tool a workspace path holds: `tools/<name>.ts` or `.js`, directly in `tools/`. */
export function wizardToolOfPath(path: string): string | null {
  if (!path.startsWith(WIZARD_TOOLS_DIR)) {
    return null;
  }
  const file = path.slice(WIZARD_TOOLS_DIR.length);
  const ext = WIZARD_TOOL_EXTENSIONS.find((e) => file.endsWith(e));
  if (!ext || file.includes("/")) {
    return null;
  }
  const name = file.slice(0, -ext.length);
  return WIZARD_CODE_NAME.test(name) ? name : null;
}

/** The function tools in a workspace, by name, each with the paths that hold it (one, if well made). */
export function wizardToolsIn(paths: readonly string[]): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const path of paths) {
    const name = wizardToolOfPath(path);
    if (name) {
      found.set(name, [...(found.get(name) ?? []), path]);
    }
  }
  return found;
}

/** The file of the function tool `name`: `tools/<name>.ts`, else `tools/<name>.js`. */
export function wizardToolPath(name: string, paths: readonly string[]): string | null {
  return wizardToolsIn(paths).get(name)?.sort()[0] ?? null;
}

/** The wizard's function tools its steps name, by name. */
export function wizardToolsUsed(def: { steps: readonly { type: string; tools?: string[] }[] }) {
  const names = new Set<string>();
  for (const step of def.steps) {
    for (const id of step.type === "agent" ? (step.tools ?? []) : []) {
      const code = wizardCodeOf(id);
      if (code?.kind === "tool") {
        names.add(code.name);
      }
    }
  }
  return [...names].sort();
}

/** What a function tool's file exports, as read from it. */
export interface WizardToolDeclaration {
  description: string;
  /** JSON Schema of its arguments: an object. */
  input: Record<string, unknown>;
  /** JSON Schema of what `run` returns, when given. */
  output?: Record<string, unknown>;
}

const SCHEMA_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const isRecord = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v);

/**
 * What is wrong with a JSON Schema, as far as a tool's arguments and results need: known types,
 * `properties` and `items` that are schemas, `required` names of properties, `enum` a list.
 * Empty when it is fine. `where` names the place in the messages.
 */
export function jsonSchemaIssues(schema: unknown, where: string, depth = 0): string[] {
  if (typeof schema === "boolean") {
    return [];
  }
  if (!isRecord(schema)) {
    return [`${where} is no JSON Schema: an object.`];
  }
  if (depth > 12) {
    return [`${where} nests more than twelve levels.`];
  }
  const issues: string[] = [];
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  for (const type of schema.type === undefined ? [] : types) {
    if (typeof type !== "string" || !SCHEMA_TYPES.has(type)) {
      issues.push(`${where}: "${String(type)}" is no JSON Schema type.`);
    }
  }
  if (schema.properties !== undefined) {
    if (!isRecord(schema.properties)) {
      issues.push(`${where}: "properties" is an object of schemas.`);
    } else {
      for (const [key, value] of Object.entries(schema.properties)) {
        issues.push(...jsonSchemaIssues(value, `${where}.${key}`, depth + 1));
      }
    }
  }
  if (schema.required !== undefined) {
    const props = isRecord(schema.properties) ? schema.properties : {};
    if (!Array.isArray(schema.required) || schema.required.some((r) => typeof r !== "string")) {
      issues.push(`${where}: "required" is a list of property names.`);
    } else {
      for (const name of schema.required as string[]) {
        if (!(name in props)) {
          issues.push(`${where}: "${name}" is required but no property.`);
        }
      }
    }
  }
  if (schema.items !== undefined) {
    issues.push(...jsonSchemaIssues(schema.items, `${where}[]`, depth + 1));
  }
  if (schema.additionalProperties !== undefined) {
    issues.push(...jsonSchemaIssues(schema.additionalProperties, `${where}.*`, depth + 1));
  }
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    if (schema[key] === undefined) {
      continue;
    }
    if (!Array.isArray(schema[key])) {
      issues.push(`${where}: "${key}" is a list of schemas.`);
    } else {
      schema[key].forEach((s, i) => {
        issues.push(...jsonSchemaIssues(s, `${where}.${key}[${i}]`, depth + 1));
      });
    }
  }
  if (schema.enum !== undefined && !Array.isArray(schema.enum)) {
    issues.push(`${where}: "enum" is a list.`);
  }
  return issues;
}

/**
 * What a function tool's exports lack, by what was read from the file: a `description`, an
 * `input` schema of an object, an optional `output` schema, a function `run`. Empty when fine.
 */
export function wizardToolIssues(
  name: string,
  read: { description?: unknown; input?: unknown; output?: unknown; run?: unknown },
): string[] {
  const at = `Tool "wizard.${name}"`;
  const issues: string[] = [];
  if (typeof read.description !== "string" || !read.description.trim()) {
    issues.push(`${at} exports no "description": a sentence of what it does.`);
  } else if (read.description.length > 1000) {
    issues.push(`${at}: the description is longer than 1000 characters.`);
  }
  if (read.input === undefined) {
    issues.push(`${at} exports no "input": the JSON Schema of its arguments.`);
  } else {
    const found = jsonSchemaIssues(read.input, "input");
    issues.push(...found.map((issue) => `${at}: ${issue}`));
    if (!found.length && (!isRecord(read.input) || read.input.type !== "object")) {
      issues.push(`${at}: "input" describes an object ("type": "object").`);
    }
  }
  if (read.output !== undefined) {
    issues.push(...jsonSchemaIssues(read.output, "output").map((issue) => `${at}: ${issue}`));
  }
  if (read.run !== "function") {
    issues.push(`${at} exports no function run(input, { fetch, tools }).`);
  }
  return issues;
}
