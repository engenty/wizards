import {
  isSandboxToolPath,
  type SandboxToolDeclaration,
  sandboxToolFiles,
  sandboxToolHostsMissing,
  sandboxToolIssues,
  type WizardToolDeclaration,
  wizardCodeOf,
  wizardToolIssues,
  wizardToolPath,
  wizardToolsIn,
} from "@engenty/wizards-shared/wizard-code";
import { parse as parseYaml } from "yaml";
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

/** What a sandbox tool's call may take (../tools/wizard-sandbox.ts). */
export const SANDBOX_TOOL_LIMITS = {
  /** Wall time of the command, installs included. */
  timeoutMs: 300_000,
  /** Characters of the arguments as JSON. */
  inputChars: 100_000,
  /** Bytes of `output.json`. */
  outputBytes: 1_000_000,
  /** Characters of the result the model reads. */
  resultChars: 20_000,
  /** Characters of stderr and stdout handed back when it fails. */
  logChars: 2000,
  /** Files of `out/` that become the step's assets, and the bytes of each. */
  outFiles: 20,
  outFileBytes: 50 * 1024 * 1024,
};

/** A function tool as the run uses it: its declaration and its code as a function's body. */
export interface WizardTool extends WizardToolDeclaration {
  kind: "function";
  name: string;
  path: string;
  body: string;
}

/** A sandbox tool as the run uses it: its front matter, its body and the files of its folder. */
export interface SandboxTool extends SandboxToolDeclaration {
  kind: "sandbox";
  name: string;
  /** Its `TOOL.md`. */
  path: string;
  /** What the body of `TOOL.md` says of it, under the front matter. */
  body: string;
  /** Every workspace path under `tools/<name>/`, its `TOOL.md` too. */
  files: string[];
}

type Loaded<T> = { ok: true; tool: T } | { ok: false; issues: string[] };

type Declared = Loaded<WizardToolDeclaration>;

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

const FRONT_MATTER = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * A sandbox tool's `TOOL.md` read: its front matter as YAML (the schemas may be written as YAML
 * or as JSON, which YAML reads too) and the body under it, or what is wrong with it.
 */
export function declareSandboxTool(
  name: string,
  text: string,
): Loaded<SandboxToolDeclaration & { body: string }> {
  const at = `Tool "wizard.${name}"`;
  const m = FRONT_MATTER.exec(text);
  if (!m) {
    return { ok: false, issues: [`${at}: its TOOL.md has no front matter between --- lines.`] };
  }
  let front: unknown;
  try {
    front = parseYaml(m[1]);
  } catch (err) {
    const why = (err as Error).message.split("\n")[0];
    return { ok: false, issues: [`${at}: the front matter of its TOOL.md is no YAML: ${why}`] };
  }
  if (!front || typeof front !== "object" || Array.isArray(front)) {
    return { ok: false, issues: [`${at}: the front matter of its TOOL.md holds no keys.`] };
  }
  const read = front as Record<string, unknown>;
  const issues = sandboxToolIssues(name, read);
  for (const key of ["input", "output"] as const) {
    if (!issues.length && read[key] !== undefined) {
      try {
        schemaZod(read[key] as Record<string, unknown>);
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
      description: String(read.description).trim(),
      input: read.input as Record<string, unknown>,
      ...(read.output !== undefined ? { output: read.output as Record<string, unknown> } : {}),
      run: String(read.run).trim(),
      hosts: ((read.hosts as string[] | undefined) ?? []).map((h) => h.trim().toLowerCase()),
      body: text.slice(m[0].length).trim(),
    },
  };
}

/**
 * The tool `name` from a workspace, a function tool or a sandbox tool by its file: `paths` are
 * the workspace's files, `read` gives one's text. Null where it has no file.
 */
export async function loadWizardTool(
  name: string,
  paths: readonly string[],
  read: (path: string) => Promise<string | null>,
): Promise<Loaded<WizardTool | SandboxTool> | null> {
  const path = wizardToolPath(name, paths);
  const source = path ? await read(path) : null;
  if (!path || source === null) {
    return null;
  }
  if (isSandboxToolPath(path)) {
    const declared = declareSandboxTool(name, source);
    return declared.ok
      ? {
          ok: true,
          tool: {
            ...declared.tool,
            kind: "sandbox",
            name,
            path,
            files: sandboxToolFiles(name, paths),
          },
        }
      : declared;
  }
  const declared = await declareWizardTool(name, source);
  return declared.ok
    ? {
        ok: true,
        tool: {
          ...declared.tool,
          kind: "function",
          name,
          path,
          body: moduleBody(source) as string,
        },
      }
    : declared;
}

/**
 * What is wrong with the tools of a workspace, every one under `tools/` whether a step names it
 * or not: two files for one name, a file that doesn't load or lacks what it must say.
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
 * The steps that name a sandbox tool without listing every host it reaches in their `hosts`: the
 * run's sandbox reaches only the hosts of its grant, which are the steps'.
 */
export async function sandboxToolHostIssues(
  steps: readonly { id: string; type: string; tools?: string[]; hosts?: string[] }[],
  paths: readonly string[],
  read: (path: string) => Promise<string | null>,
): Promise<{ stepId: string; message: string }[]> {
  const issues: { stepId: string; message: string }[] = [];
  const loaded = new Map<string, Awaited<ReturnType<typeof loadWizardTool>>>();
  for (const step of steps) {
    for (const id of step.type === "agent" ? (step.tools ?? []) : []) {
      const code = wizardCodeOf(id);
      if (code?.kind !== "tool") {
        continue;
      }
      if (!loaded.has(code.name)) {
        loaded.set(code.name, await loadWizardTool(code.name, paths, read));
      }
      const tool = loaded.get(code.name);
      if (!(tool?.ok && tool.tool.kind === "sandbox")) {
        continue;
      }
      const missing = sandboxToolHostsMissing(tool.tool.hosts, step.hosts ?? []);
      if (missing.length) {
        issues.push({
          stepId: step.id,
          message: `Tool "${id}" reaches ${missing.join(", ")}: list ${missing.length === 1 ? "it" : "them"} in the step's "hosts" too.`,
        });
      }
    }
  }
  return issues;
}
