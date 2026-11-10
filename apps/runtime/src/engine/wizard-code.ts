import { parseWizardAgent, type WizardAgent } from "@engenty/wizards-shared/wizard-agents";
import {
  WIZARD_AGENTS_DIR,
  type WizardToolDeclaration,
  wizardAgentOfPath,
  wizardAgentPath,
  wizardToolIssues,
  wizardToolPath,
  wizardToolsIn,
} from "@engenty/wizards-shared/wizard-code";
import { z } from "zod";
import { moduleBody, quickJs } from "./quickjs.js";

/**
 * A wizard's own code read from its workspace (docs/plans/wizard-code.md): what the run and
 * `wizards validate` share. The ids and paths are in shared/wizard-code.ts; this reads the files.
 * No database here: the CLI reads a package from disk with it.
 */

export const WIZARD_TOOL_LIMITS = {
  /** Wall time of one call, its requests and tool calls included, as a code step's run. */
  timeoutMs: 10_000,
  /** Reading what the file exports. */
  declareMs: 2000,
  /** Requests and tool calls one call may make. */
  maxCalls: 20,
  /** Characters of a response body or a tool's answer the function takes in. */
  answerChars: 200_000,
  /** Characters of the arguments as JSON. */
  inputChars: 100_000,
  /** Characters of the result the model reads. */
  resultChars: 20_000,
  /** Characters of `console.log` output kept with an error. */
  logChars: 2000,
};

/** A function tool as the run uses it: its declaration and its code as a function's body. */
export interface WizardTool extends WizardToolDeclaration {
  name: string;
  path: string;
  body: string;
}

type Declared = { ok: true; tool: WizardToolDeclaration } | { ok: false; issues: string[] };

/** A JSON Schema as Zod: what the model is shown and what the call is checked with. */
export function schemaZod(schema: Record<string, unknown>): z.ZodType {
  return z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
}

/**
 * What a function tool's file exports, read by running its top level in QuickJS: the declaration,
 * or what is wrong with it.
 */
export async function declareWizardTool(name: string, source: string): Promise<Declared> {
  const at = `Tool "wizard.${name}"`;
  const body = moduleBody(source);
  if (body === null) {
    return { ok: false, issues: [`${at} imports: a function tool has no modules.`] };
  }
  const read = (key: string) => `${key}: typeof ${key} === "undefined" ? undefined : ${key}`;
  const ran = await quickJs().run({
    program: `${body}\nreturn { ${["description", "input", "output"].map(read).join(", ")}, run: typeof run };`,
    toolIds: [],
    dispatch: async () => {
      throw new Error("Reading a tool calls nothing.");
    },
    timeout: WIZARD_TOOL_LIMITS.declareMs,
  });
  if (!ran.success) {
    return { ok: false, issues: [`${at} doesn't load: ${ran.error?.message ?? "unknown error"}`] };
  }
  const exported = (ran.result ?? {}) as Record<string, unknown>;
  const issues = wizardToolIssues(name, exported);
  for (const key of ["input", "output"] as const) {
    if (!issues.length && exported[key] !== undefined) {
      try {
        schemaZod(exported[key] as Record<string, unknown>);
      } catch (err) {
        issues.push(`${at}: "${key}" can't be read: ${(err as Error).message}`);
      }
    }
  }
  if (issues.length) {
    return { ok: false, issues };
  }
  return {
    ok: true,
    tool: {
      description: exported.description as string,
      input: exported.input as Record<string, unknown>,
      ...(exported.output !== undefined
        ? { output: exported.output as Record<string, unknown> }
        : {}),
    },
  };
}

/**
 * The function tool `name` from a workspace: `paths` are its files, `read` gives one's text.
 * Null where it has no file.
 */
export async function loadWizardTool(
  name: string,
  paths: readonly string[],
  read: (path: string) => Promise<string | null>,
): Promise<{ ok: true; tool: WizardTool } | { ok: false; issues: string[] } | null> {
  const path = wizardToolPath(name, paths);
  const source = path ? await read(path) : null;
  if (!path || source === null) {
    return null;
  }
  const declared = await declareWizardTool(name, source);
  return declared.ok
    ? { ok: true, tool: { ...declared.tool, name, path, body: moduleBody(source) as string } }
    : declared;
}

/**
 * What is wrong with the function tools of a workspace, every file under `tools/` whether a step
 * names it or not: two files for one name, a file that doesn't load or lacks an export.
 */
export async function wizardToolFileIssues(
  paths: readonly string[],
  read: (path: string) => Promise<string | null>,
): Promise<string[]> {
  const issues: string[] = [];
  for (const [name, files] of wizardToolsIn(paths)) {
    if (files.length > 1) {
      issues.push(
        `Tool "wizard.${name}" has two files: keep one of ${[...files].sort().join(", ")}.`,
      );
    }
    const loaded = await loadWizardTool(name, paths, read);
    if (loaded && !loaded.ok) {
      issues.push(...loaded.issues);
    }
  }
  return issues;
}

/**
 * The agent `name` from a workspace (`agents/<name>.md`): the agent, or what is wrong with its
 * file. Null where it has no file.
 */
export async function loadWizardAgent(
  name: string,
  paths: readonly string[],
  read: (path: string) => Promise<string | null>,
): Promise<{ ok: true; agent: WizardAgent } | { ok: false; issues: string[] } | null> {
  const path = wizardAgentPath(name);
  const text = paths.includes(path) ? await read(path) : null;
  return text === null ? null : parseWizardAgent(name, text, paths);
}

/**
 * Every agent of a workspace, whether a step names it or not: the ones that parse, by name, and
 * what is wrong with the others, a file in `agents/` whose name is none among them.
 */
export async function wizardAgentFiles(
  paths: readonly string[],
  read: (path: string) => Promise<string | null>,
): Promise<{ agents: Map<string, WizardAgent>; issues: string[] }> {
  const agents = new Map<string, WizardAgent>();
  const issues: string[] = [];
  for (const path of paths) {
    if (!path.startsWith(WIZARD_AGENTS_DIR) || !path.endsWith(".md")) {
      continue;
    }
    const name = wizardAgentOfPath(path);
    if (!name) {
      issues.push(
        `Agent "${path}": a file directly in agents/, named in lowercase letters, digits and _, starting with a letter.`,
      );
      continue;
    }
    const loaded = await loadWizardAgent(name, paths, read);
    if (loaded?.ok) {
      agents.set(name, loaded.agent);
    } else if (loaded) {
      issues.push(...loaded.issues);
    }
  }
  return { agents, issues };
}
