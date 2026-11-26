import { createHash } from "node:crypto";
import type { KernelFile, ValidationIssue } from "@engenty/wizards-shared/definition";
import { stepFilesOf } from "@engenty/wizards-shared/kernel-file";
import type { WorkspaceFile } from "@engenty/wizards-shared/workspace";
import { snapshotFile } from "../services/files.js";
import { stepOutline } from "./outline.js";
import { compileIssues, type ReadCode } from "./wizard.js";

const STEP = /^steps\/([^/]+)\.[a-z]+$/;

/**
 * What the code of a wizard in version 0.3.0 has wrong, read without running it
 * (docs/plans/kernel.md): a step or eval file that does not compile for the sandbox, a step file
 * that exports no function, and a way a step's code takes that the file's map lacks. A run would
 * fail on each of them; here they are said before one starts.
 */
export async function kernelCodeIssues(
  file: KernelFile,
  paths: readonly string[],
  read: ReadCode,
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = (await compileIssues(paths, read)).map(({ path, message }) => {
    const stepId = STEP.exec(path)?.[1];
    return { ...(stepId ? { stepId } : {}), message };
  });
  const broken = new Set(issues.map((issue) => issue.stepId));
  for (const [id, path] of Object.entries(stepFilesOf(paths))) {
    // A file that does not compile is said once, by the compiler.
    if (broken.has(id)) continue;
    const step = await stepOutline((await read(path)) ?? "");
    if (step.error) {
      issues.push({ stepId: id, message: `${path}: ${step.error}` });
      continue;
    }
    const ways = file.edges[id] ?? [];
    for (const to of new Set(step.ways.flatMap((way) => (way.to ? [way.to] : [])))) {
      if (!ways.includes(to)) {
        issues.push({
          stepId: id,
          message: `${path} goes to "${to}", and the map has no such way from "${id}".`,
        });
      }
    }
  }
  return issues;
}

const checked = new Map<string, Promise<ValidationIssue[]>>();

/** `kernelCodeIssues` of a draft and its workspace, kept by what the files hold. */
export function draftCodeIssues(
  file: KernelFile,
  files: WorkspaceFile[],
): Promise<ValidationIssue[]> {
  const key = createHash("sha256")
    .update(JSON.stringify([file.edges, files.map((f) => [f.path, f.hash])]))
    .digest("hex");
  let issues = checked.get(key);
  if (!issues) {
    issues = kernelCodeIssues(
      file,
      files.map((f) => f.path),
      async (path) => (await snapshotFile(files, path))?.data.toString("utf8") ?? null,
    );
    checked.set(key, issues);
    issues.catch(() => checked.delete(key));
    if (checked.size > 200) {
      checked.delete(checked.keys().next().value as string);
    }
  }
  return issues;
}
