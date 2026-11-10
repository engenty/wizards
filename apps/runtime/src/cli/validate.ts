import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { parseWizard, type ValidationIssue } from "@engenty/wizards-shared/definition";
import { requiresProblem } from "@engenty/wizards-shared/requires";
import { inputSchemaOf, type JsonSchema, outputSchemaOf } from "@engenty/wizards-shared/run-schema";
import { wizardDataIssues } from "@engenty/wizards-shared/wizard-data";
import { PACKAGE_FILES, PACKAGE_MANIFEST } from "@engenty/wizards-shared/wizard-package";
import { WIZARD_SKILLS_DIR, wizardSkillIssues } from "@engenty/wizards-shared/wizard-skills";
import { json, readManifest, readPackage } from "../services/package-file.js";
import { bad, dim, ok } from "./ui.js";

/**
 * `wizards validate <path…>`: a wizard checked as the studio checks it on import, with no
 * running studio and no account. A path is a `.wizard` package, an unpacked one (its folder or
 * its wizard.json, with the workspace beside it under files/), or a definition on its own.
 *
 * What a space holds — its connectors, MCP servers and plugins — is checked on import. The SQL
 * of the wizard's own database is read too: its schema and migrations split into statements the
 * runtime runs.
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

interface Given {
  definition: unknown;
  files: string[];
  /** The text of each skill's `SKILL.md`, by its path in the workspace. */
  skillMds: Record<string, string>;
  /** A workspace file's text, or null where it is not there. */
  text: (path: string) => string | null;
}

/** The definition and the workspace's paths, read the way the import reads them. */
function read(path: string): Given {
  const folder = statSync(path).isDirectory()
    ? path
    : basename(path) === PACKAGE_MANIFEST
      ? dirname(path)
      : null;
  if (folder) {
    const manifest = readManifest(json(readFileSync(join(folder, PACKAGE_MANIFEST))));
    const files = workspace(folder);
    const skillMds = Object.fromEntries(
      files.filter(isSkillMd).map((f) => [f, readFileSync(join(folder, PACKAGE_FILES, f), "utf8")]),
    );
    return {
      definition: manifest.definition,
      files,
      skillMds,
      text: (p) =>
        files.includes(p) ? readFileSync(join(folder, PACKAGE_FILES, p), "utf8") : null,
    };
  }
  const { manifest, files } = readPackage(readFileSync(path));
  const skillMds = Object.fromEntries(
    files.filter((f) => isSkillMd(f.path)).map((f) => [f.path, new TextDecoder().decode(f.data)]),
  );
  return {
    definition: manifest.definition,
    files: files.map((f) => f.path),
    skillMds,
    text: (p) => {
      const file = files.find((f) => f.path === p);
      return file ? new TextDecoder().decode(file.data) : null;
    },
  };
}

export function validatePath(path: string): Checked {
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
  const parsed = parseWizard(given.definition, given.files);
  // `requires` says what the steps need: a file that says otherwise is out of date. The SQL of
  // the wizard's own database: each file splits into statements the runtime runs.
  const requires = parsed.ok ? requiresProblem(parsed.wizard) : null;
  const issues = [
    ...(requires ? [...parsed.issues, { message: requires }] : parsed.issues),
    ...wizardSkillIssues(given.files, given.skillMds),
    ...(parsed.ok
      ? wizardDataIssues(parsed.wizard, given.files, given.text).map((i) => ({
          message: i.message,
        }))
      : []),
  ];
  return {
    path,
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

export function validateCommand(paths: string[], asJson: boolean): number {
  if (!paths.length) {
    console.error("Give a path: a .wizard file, an unpacked package or a wizard JSON file.");
    return 2;
  }
  const results = paths.map(validatePath);
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
