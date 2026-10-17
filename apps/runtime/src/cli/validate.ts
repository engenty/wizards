import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { parseWizard, type ValidationIssue } from "@engenty-wizards/shared/definition";
import { PACKAGE_FILES, PACKAGE_MANIFEST } from "@engenty-wizards/shared/wizard-package";
import { json, readManifest, readPackage } from "../services/package-file.js";
import { bad, dim, ok } from "./ui.js";

/**
 * `wizards validate <path…>`: a wizard checked as the studio checks it on import, with no
 * running studio and no account. A path is a `.wizard` package, an unpacked one (its folder or
 * its wizard.json, with the workspace beside it under files/), or a definition on its own.
 *
 * What a project holds — its connectors, MCP servers and plugins — is checked on import.
 */

interface Checked {
  path: string;
  ok: boolean;
  steps?: number;
  files?: number;
  issues: ValidationIssue[];
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

/** The definition and the workspace's paths, read the way the import reads them. */
function read(path: string): { definition: unknown; files: string[] } {
  const folder = statSync(path).isDirectory()
    ? path
    : basename(path) === PACKAGE_MANIFEST
      ? dirname(path)
      : null;
  if (folder) {
    const manifest = readManifest(json(readFileSync(join(folder, PACKAGE_MANIFEST))));
    return { definition: manifest.definition, files: workspace(folder) };
  }
  const { manifest, files } = readPackage(readFileSync(path));
  return { definition: manifest.definition, files: files.map((f) => f.path) };
}

export function validatePath(path: string): Checked {
  let given: { definition: unknown; files: string[] };
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
  return {
    path,
    ok: parsed.ok && parsed.issues.length === 0,
    steps: parsed.ok ? parsed.wizard.steps.length : undefined,
    files: given.files.length,
    issues: parsed.issues,
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
