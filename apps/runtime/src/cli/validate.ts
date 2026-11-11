import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import {
  parseWizard,
  type ValidationIssue,
  type WizardDefinition,
} from "@engenty/wizards-shared/definition";
import { requiresProblem } from "@engenty/wizards-shared/requires";
import { inputSchemaOf, type JsonSchema, outputSchemaOf } from "@engenty/wizards-shared/run-schema";
import { wizardAgentUseIssues } from "@engenty/wizards-shared/wizard-agents";
import { dataFiles, wizardDataIssues } from "@engenty/wizards-shared/wizard-data";
import { PACKAGE_FILES, PACKAGE_MANIFEST } from "@engenty/wizards-shared/wizard-package";
import { WIZARD_SKILLS_DIR, wizardSkillIssues } from "@engenty/wizards-shared/wizard-skills";
import {
  sandboxToolHostIssues,
  wizardAgentFiles,
  wizardToolFileIssues,
} from "../engine/wizard-code.js";
import { json, readManifest, readPackage } from "../services/package-file.js";
import { bad, dim, ok } from "./ui.js";

/**
 * `wizards validate <path…>`: a wizard checked as the studio checks it on import, with no
 * running studio and no account. A path is a `.wizard` package, an unpacked one (its folder or
 * its wizard.json, with the workspace beside it under files/), or a definition on its own.
 *
 * What a space holds — its connectors, MCP servers and plugins — is checked on import. The
 * wizard's tools (`files/tools/`) are read as a run reads them: a function tool's file in
 * QuickJS, a sandbox tool's `TOOL.md` with its front matter. Its agents (`files/agents/`) are
 * read as a run reads them. The SQL of the wizard's own database is read too: its schema and
 * migrations split into statements the runtime runs.
 */

interface Checked {
  path: string;
  ok: boolean;
  steps?: number;
  files?: number;
  issues: ValidationIssue[];
  /** What a run takes and gives, as JSON Schema; only for a definition that parses. */
  inputSchema?: JsonSchema;
  outputSchema?: JsonSchema;
}

function workspace(folder: string): string[] {
  const root = join(folder, PACKAGE_FILES);
  try {
    return readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name !== ".DS_Store")
      .map((entry) => relative(root, join(entry.parentPath, entry.name)).split("\\").join("/"));
  } catch {
    return [];
  }
}

const isSkillMd = (path: string) =>
  path.startsWith(WIZARD_SKILLS_DIR) && path.endsWith("/SKILL.md");

export interface Given {
  definition: unknown;
  files: string[];
  /** A workspace file's text, or null where it isn't there. */
  read: (path: string) => Promise<string | null>;
}

/** The definition and the workspace, read the way the import reads them. */
function read(path: string): Given {
  const folder = statSync(path).isDirectory()
    ? path
    : basename(path) === PACKAGE_MANIFEST
      ? dirname(path)
      : null;
  if (folder) {
    const manifest = readManifest(json(readFileSync(join(folder, PACKAGE_MANIFEST))));
    const files = workspace(folder);
    return {
      definition: manifest.definition,
      files,
      read: async (file) =>
        files.includes(file) ? readFileSync(join(folder, PACKAGE_FILES, file), "utf8") : null,
    };
  }
  const { manifest, files } = readPackage(readFileSync(path));
  return {
    definition: manifest.definition,
    files: files.map((f) => f.path),
    read: async (file) => {
      const found = files.find((f) => f.path === file);
      return found ? new TextDecoder().decode(found.data) : null;
    },
  };
}

/** The SQL files of the wizard's own database, read: each splits into statements the runtime runs. */
async function dataIssues(def: WizardDefinition, given: Given): Promise<ValidationIssue[]> {
  const files = dataFiles(def, given.files);
  const texts = new Map<string, string | null>();
  for (const file of files ? [files.schema, ...files.migrations] : []) {
    texts.set(file, await given.read(file));
  }
  return wizardDataIssues(def, given.files, (p) => texts.get(p) ?? null).map((i) => ({
    message: i.message,
  }));
}

export async function validatePath(path: string): Promise<Checked> {
  let given: Given;
  try {
    given = read(path);
  } catch (err) {
    const message =
      (err as NodeJS.ErrnoException).code === "ENOENT"
        ? "No such file or folder."
        : (err as Error).message;
    return { path, ok: false, issues: [{ message }] };
  }
  return { path, ...(await checkWizard(given)) };
}

/**
 * A wizard and its workspace checked as the studio checks it on import, wherever they come
 * from: a path here, or a definition sent to start a run (`POST /api/v1/spaces/:id/runs`).
 */
export async function checkWizard(given: Given): Promise<Omit<Checked, "path">> {
  const parsed = parseWizard(given.definition, given.files);
  const agents = await wizardAgentFiles(given.files, given.read);
  // `requires` says what the steps and the agents' files need: a file that says otherwise is out
  // of date. Where an agent's file is broken, that is said first.
  const requires =
    parsed.ok && !agents.issues.length
      ? requiresProblem(parsed.wizard, agents.agents, given.files)
      : null;
  const checked = [
    ...parsed.issues,
    ...(parsed.ok ? wizardAgentUseIssues(parsed.wizard, agents.agents) : []),
    ...(requires ? [{ message: requires }] : []),
  ];
  // A tool a step names is checked by the definition too: each message once.
  const said = new Set(checked.map((issue) => issue.message));
  const skillMds: Record<string, string> = {};
  for (const file of given.files.filter(isSkillMd)) {
    skillMds[file] = (await given.read(file)) ?? "";
  }
  const issues = [
    ...checked,
    ...[...(await wizardToolFileIssues(given.files, given.read)), ...agents.issues]
      .filter((message) => !said.has(message))
      .map((message) => ({ message })),
    ...wizardSkillIssues(given.files, skillMds),
    ...(parsed.ok ? await sandboxToolHostIssues(parsed.wizard.steps, given.files, given.read) : []),
    ...(parsed.ok ? await dataIssues(parsed.wizard, given) : []),
  ];
  return {
    ok: parsed.ok && issues.length === 0,
    steps: parsed.ok ? parsed.wizard.steps.length : undefined,
    files: given.files.length,
    issues,
    ...(parsed.ok
      ? {
          inputSchema: inputSchemaOf(parsed.wizard),
          outputSchema: outputSchemaOf(parsed.wizard),
        }
      : {}),
  };
}

export async function validateCommand(paths: string[], asJson: boolean): Promise<number> {
  if (!paths.length) {
    console.error("Give a path: a .wizard file, an unpacked package or a wizard JSON file.");
    return 2;
  }
  const results = await Promise.all(paths.map(validatePath));
  if (asJson) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const r of results) {
      if (r.ok) {
        console.log(
          `${ok} ${r.path} ${dim(`${r.steps} ${r.steps === 1 ? "step" : "steps"}, ${r.files} ${r.files === 1 ? "file" : "files"}`)}`,
        );
        continue;
      }
      const count = `${r.issues.length} ${r.issues.length === 1 ? "issue" : "issues"}`;
      console.log(`${bad} ${r.path} ${dim(count)}`);
      for (const issue of r.issues) {
        console.log(`  ${issue.message}`);
      }
    }
  }
  return results.every((r) => r.ok) ? 0 : 1;
}
