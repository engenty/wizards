/**
 * Code a wizard brings in its own workspace (docs/plans/wizard-code.md): function tools under
 * `tools/<name>.ts`, sandbox tools under `tools/<name>/TOOL.md`, later agents under
 * `agents/<name>.md`. A step names them in `tools` with a prefix: `wizard.<name>`,
 * `agent.<name>`. The prefixes are no plugin ids.
 *
 * Shared by the definition's checks, the runtime, `wizards validate` and the studio, so the ids
 * and paths are read the same everywhere.
 */

/** The prefixes of a step's tool id that name the wizard's own code. */
export const WIZARD_CODE_PREFIXES = ["wizard", "agent"] as const;
export type WizardCodeKind = "tool" | "agent";

/** A name of a wizard's tool or agent: what follows the prefix, and its file name. */
export const WIZARD_CODE_NAME = /^[a-z][a-z0-9_]{0,39}$/;

/** The folder of the workspace that holds the wizard's function and sandbox tools. */
export const WIZARD_TOOLS_DIR = "tools/";
/** The files a function tool may be written in. */
export const WIZARD_TOOL_EXTENSIONS = [".ts", ".js"] as const;
/** The file that makes a folder under `tools/` a sandbox tool; its scripts are beside it. */
export const SANDBOX_TOOL_FILE = "TOOL.md";

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

/**
 * The tool a workspace path declares: a function tool's `tools/<name>.ts` or `.js`, directly in
 * `tools/`, or a sandbox tool's `tools/<name>/TOOL.md`. Null for any other file, a sandbox tool's
 * scripts among them.
 */
export function wizardToolOfPath(path: string): string | null {
  if (!path.startsWith(WIZARD_TOOLS_DIR)) {
    return null;
  }
  const file = path.slice(WIZARD_TOOLS_DIR.length);
  const folder = file.endsWith(`/${SANDBOX_TOOL_FILE}`)
    ? file.slice(0, -SANDBOX_TOOL_FILE.length - 1)
    : null;
  if (folder !== null) {
    return WIZARD_CODE_NAME.test(folder) ? folder : null;
  }
  const ext = WIZARD_TOOL_EXTENSIONS.find((e) => file.endsWith(e));
  if (!ext || file.includes("/")) {
    return null;
  }
  const name = file.slice(0, -ext.length);
  return WIZARD_CODE_NAME.test(name) ? name : null;
}

/** Whether a tool's path is a sandbox tool's `TOOL.md`, not a function tool's code. */
export const isSandboxToolPath = (path: string) => path.endsWith(`/${SANDBOX_TOOL_FILE}`);

/** The tools in a workspace, by name, each with the paths that declare it (one, if well made). */
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

/**
 * The file of the tool `name`: `tools/<name>.ts`, else `tools/<name>.js`, else
 * `tools/<name>/TOOL.md`.
 */
export function wizardToolPath(name: string, paths: readonly string[]): string | null {
  return wizardToolsIn(paths).get(name)?.sort()[0] ?? null;
}

/** The files of the sandbox tool `name`: every path under `tools/<name>/`, its TOOL.md too. */
export function sandboxToolFiles(name: string, paths: readonly string[]): string[] {
  const folder = `${WIZARD_TOOLS_DIR}${name}/`;
  return paths.filter((path) => path.startsWith(folder)).sort();
}

/** The wizard's sandbox tools its steps name, by name: they need a sandbox that runs a shell. */
export function sandboxToolsUsed(
  def: { steps: readonly { type: string; tools?: string[] }[] },
  paths: readonly string[],
): string[] {
  const tools = wizardToolsIn(paths);
  return wizardToolsUsed(def).filter((name) => {
    const files = tools.get(name);
    return files?.length === 1 && isSandboxToolPath(files[0]);
  });
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
 * What a tool's declaration lacks, whatever it is written in: a `description` and an `input`
 * schema of an object, an optional `output` schema. `has` is how the messages say it holds one.
 */
function declarationIssues(
  at: string,
  has: string,
  read: { description?: unknown; input?: unknown; output?: unknown },
): string[] {
  const issues: string[] = [];
  if (typeof read.description !== "string" || !read.description.trim()) {
    issues.push(`${at} ${has} no "description": a sentence of what it does.`);
  } else if (read.description.length > 1000) {
    issues.push(`${at}: the description is longer than 1000 characters.`);
  }
  if (read.input === undefined) {
    issues.push(`${at} ${has} no "input": the JSON Schema of its arguments.`);
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
  const issues = declarationIssues(at, "exports", read);
  if (read.run !== "function") {
    issues.push(`${at} exports no function run(input, { fetch, tools }).`);
  }
  return issues;
}

/** What a sandbox tool's `TOOL.md` says in its front matter, as read from it. */
export interface SandboxToolDeclaration extends WizardToolDeclaration {
  /** The command that runs it, in its folder in the sandbox. */
  run: string;
  /** The hosts it reaches; the step lists them in its `hosts` too. */
  hosts: string[];
}

/** A host a tool may name: a DNS name, `*.` allowed in front. */
const TOOL_HOST = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;

/**
 * What a sandbox tool's front matter lacks: a `description`, an `input` schema of an object, an
 * optional `output` schema, a `run` command, `hosts` as a list of host names. Empty when fine.
 */
export function sandboxToolIssues(
  name: string,
  front: {
    description?: unknown;
    input?: unknown;
    output?: unknown;
    run?: unknown;
    hosts?: unknown;
  },
): string[] {
  const at = `Tool "wizard.${name}"`;
  const issues = declarationIssues(at, "has", front);
  if (typeof front.run !== "string" || !front.run.trim()) {
    issues.push(`${at} has no "run": the command that runs it, such as python3 convert.py.`);
  } else if (front.run.includes("\n")) {
    issues.push(`${at}: "run" is one command on one line.`);
  }
  if (front.hosts !== undefined) {
    if (!Array.isArray(front.hosts) || front.hosts.some((h) => typeof h !== "string")) {
      issues.push(`${at}: "hosts" is a list of host names.`);
    } else {
      for (const host of front.hosts as string[]) {
        if (!TOOL_HOST.test(host.trim().toLowerCase())) {
          issues.push(`${at}: "${host}" is no host name, such as api.example.com.`);
        }
      }
    }
  }
  return issues;
}

/** The sandbox tool's hosts that a step using it doesn't list in its `hosts`. */
export function sandboxToolHostsMissing(
  toolHosts: readonly string[],
  stepHosts: readonly string[],
): string[] {
  const listed = stepHosts.map((h) => h.trim().toLowerCase());
  return toolHosts.filter((host) => {
    const h = host.trim().toLowerCase();
    return !listed.some((entry) =>
      entry.startsWith("*.") ? h === entry || h.endsWith(entry.slice(1)) : h === entry,
    );
  });
}
