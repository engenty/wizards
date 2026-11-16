import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Case, check } from "./check.js";
import { compileWizard } from "./compile.js";
import { describe } from "./describe.js";
import { unused } from "./grant.js";
import { quickjsTurn } from "./quickjs.js";
import { typesOf } from "./types-of.js";

/**
 * The check of a wizard's folder, as `wizards check` runs it: the file against the step files,
 * every step and eval compiled for the sandbox, the types written from the file, and the
 * wizard's tests where it has some (`tests.json`: an input, an answer for each ask, what to
 * expect). It runs no model and costs nothing.
 */
export type Checked = {
  ok: boolean;
  /** What is wrong, each with where. */
  issues: string[];
  /** The tests that ran, and what the file declares and none of them asked for. */
  tests?: { name: string; ok: boolean; why?: string }[];
  untaken?: string[];
  unused?: string[];
};

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

export async function checkDir(
  dir: string,
  options: { writeTypes?: boolean } = {},
): Promise<Checked> {
  const issues: string[] = [];
  let file: Awaited<ReturnType<typeof compileWizard>>["file"];
  try {
    file = JSON.parse(await readFile(join(dir, "wizard.json"), "utf8"));
  } catch (error) {
    return { ok: false, issues: [`wizard.json: ${(error as Error).message}`] };
  }
  if (options.writeTypes !== false) await writeFile(join(dir, "wizard.d.ts"), typesOf(file));
  let wizard: Awaited<ReturnType<typeof compileWizard>> | undefined;
  try {
    wizard = await compileWizard(dir);
  } catch (error) {
    const errors = (
      error as { errors?: { text: string; location?: { file: string; line: number } }[] }
    ).errors;
    issues.push(
      ...(errors?.map(
        (e) => `${e.location ? `${e.location.file}:${e.location.line}: ` : ""}${e.text}`,
      ) ?? [(error as Error).message]),
    );
  }
  if (!wizard) return { ok: false, issues };
  issues.push(...describe(wizard));
  const testsPath = join(dir, "tests.json");
  if (!(await exists(testsPath))) return { ok: issues.length === 0, issues };
  const cases = JSON.parse(await readFile(testsPath, "utf8")) as Case[];
  const ran = await check(wizard, cases, quickjsTurn());
  const tests = ran.results.map((r) => ({
    name: r.name,
    ok: r.ok,
    ...(r.why ? { why: r.why } : {}),
  }));
  return {
    ok: issues.length === 0 && tests.every((t) => t.ok),
    issues,
    tests,
    untaken: ran.untaken,
    unused: unused(
      file,
      ran.results.flatMap((r) => r.run?.rows ?? []),
    ),
  };
}

/** `node check-dir.js <folder>`: prints what it found and ends with 1 when something is wrong. */
export async function main(argv: string[]): Promise<number> {
  const dir = argv[0];
  if (!dir) {
    console.error("Usage: wizards check <folder>");
    return 2;
  }
  const found = await checkDir(dir);
  for (const issue of found.issues) console.error(`✗ ${issue}`);
  for (const test of found.tests ?? [])
    console.log(`${test.ok ? "✓" : "✗"} ${test.name}${test.why ? `: ${test.why}` : ""}`);
  for (const edge of found.untaken ?? []) console.log(`· no test takes ${edge}`);
  for (const entry of found.unused ?? []) console.log(`· declared and never asked for: ${entry}`);
  console.log(found.ok ? "The wizard checks out." : "The wizard has issues.");
  return found.ok ? 0 : 1;
}
