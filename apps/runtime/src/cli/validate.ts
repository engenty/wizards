import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { checkWizard, type WizardGiven } from "@engenty/wizards-engine/wizard-check";
import type { ValidationIssue } from "@engenty/wizards-shared/definition";
import { inputSchemaOf, type JsonSchema, outputSchemaOf } from "@engenty/wizards-shared/run-schema";
import { PACKAGE_FILES, PACKAGE_MANIFEST } from "@engenty/wizards-shared/wizard-package";
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

/** The definition and the workspace, read the way the import reads them. */
function read(path: string): WizardGiven {
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

export async function validatePath(path: string): Promise<Checked> {
  let given: WizardGiven;
  try {
    given = read(path);
  } catch (err) {
    const message =
      (err as NodeJS.ErrnoException).code === "ENOENT"
        ? "No such file or folder."
        : (err as Error).message;
    return { path, ok: false, issues: [{ message }] };
  }
  const checked = await checkWizard(given);
  return {
    path,
    ok: checked.ok,
    steps: checked.wizard?.steps.length,
    files: given.files.length,
    issues: checked.issues,
    ...(checked.wizard
      ? {
          inputSchema: inputSchemaOf(checked.wizard),
          outputSchema: outputSchemaOf(checked.wizard),
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
