import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { type Checked, checkDir } from "@engenty/wizards-kernel/check";
import { KERNEL_VERSION, kernelFileSchema, kernelIssues } from "@engenty/wizards-shared/definition";
import { PACKAGE_MANIFEST } from "@engenty/wizards-shared/wizard-package";
import { kernelCodeIssues } from "../kernel/check.js";
import { bad, dim, ok } from "./ui.js";
import { validateCommand } from "./validate.js";

/**
 * `wizards check <path…>`: a wizard in version 0.3.0 checked without the studio, a model or an
 * account (docs/plans/kernel.md). A folder as the format lays it out, `wizard.json` with the map
 * and `steps/` beside it, is checked as the studio checks a draft: the file against the step
 * files, every step and eval compiled for the sandbox, each way a step's code takes against the
 * map. A folder with nothing wrong then gets the kernel's own check: `wizard.d.ts` written from
 * the file, and the wizard's tests where it has some (`tests.json`). Any other path, a `.wizard`
 * package or an unpacked one, is checked as `wizards validate` checks it.
 */

/** Whether the folder holds a wizard as the format lays it out, not a package around one. */
function isKernelFolder(path: string): boolean {
  try {
    if (!statSync(path).isDirectory()) {
      return false;
    }
    const file = JSON.parse(readFileSync(join(path, PACKAGE_MANIFEST), "utf8"));
    // The format's own file holds the map; a package's holds a definition around it.
    return file.version === KERNEL_VERSION && "edges" in file && !("kernel" in file);
  } catch {
    return false;
  }
}

/** The folder's files by their path from it, as a workspace names them. */
function filesOf(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split("\\").join("/"))
    .filter((path) => !path.split("/").some((part) => part === "node_modules" || /^\./.test(part)));
}

async function checkFolder(dir: string): Promise<Checked> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dir, PACKAGE_MANIFEST), "utf8"));
  } catch (err) {
    return { ok: false, issues: [`${PACKAGE_MANIFEST}: ${(err as Error).message}`] };
  }
  const parsed = kernelFileSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map(
        (issue) => `${PACKAGE_MANIFEST}: ${issue.path.join(".") || "file"}: ${issue.message}`,
      ),
    };
  }
  const paths = filesOf(dir);
  const issues = [
    ...kernelIssues(parsed.data, paths),
    ...(await kernelCodeIssues(parsed.data, paths, async (path) =>
      paths.includes(path) ? readFileSync(join(dir, path), "utf8") : null,
    )),
  ].map((issue) => issue.message);
  // The tests run a wizard that reads well; one that does not is said first.
  return issues.length ? { ok: false, issues } : checkDir(dir);
}

function print(path: string, found: Checked) {
  const tests = found.tests ?? [];
  const count = found.issues.length + tests.filter((test) => !test.ok).length;
  console.log(
    found.ok
      ? `${ok} ${path} ${dim(tests.length ? `${tests.length} ${tests.length === 1 ? "test" : "tests"}` : "no tests")}`
      : `${bad} ${path} ${dim(`${count} ${count === 1 ? "issue" : "issues"}`)}`,
  );
  for (const issue of found.issues) {
    console.log(`  ${issue}`);
  }
  for (const test of tests) {
    console.log(`  ${test.ok ? ok : bad} ${test.name}${test.why ? `: ${test.why}` : ""}`);
  }
  for (const edge of found.untaken ?? []) {
    console.log(dim(`  No test takes ${edge}.`));
  }
  for (const entry of found.unused ?? []) {
    console.log(dim(`  Declared and never asked for: ${entry}.`));
  }
}

export async function checkCommand(paths: string[], asJson: boolean): Promise<number> {
  if (!paths.length) {
    console.error(
      "Give a path: a wizard’s folder with wizard.json and steps/, a .wizard file or an unpacked package.",
    );
    return 2;
  }
  const folders = paths.filter(isKernelFolder);
  const others = paths.filter((path) => !folders.includes(path));
  const checked = await Promise.all(
    folders.map(async (path) => ({ path, ...(await checkFolder(path)) })),
  );
  if (asJson && checked.length) {
    console.log(JSON.stringify(checked, null, 2));
  } else {
    for (const { path, ...found } of checked) {
      print(path, found);
    }
  }
  const rest = others.length ? await validateCommand(others, asJson) : 0;
  return checked.every((found) => found.ok) && rest === 0 ? 0 : 1;
}
