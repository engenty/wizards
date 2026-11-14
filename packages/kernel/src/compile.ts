import { readdir, readFile, stat } from "node:fs/promises";
import { join, parse } from "node:path";
import { build } from "esbuild";
import type { Wizard } from "./types";

/**
 * A wizard's folder as the kernel takes it: `wizard.json`, and each `steps/<id>.ts` and
 * `evals/<step>/<name>.ts` bundled into one script for the sandbox, types stripped and shared
 * helpers inlined. This is the save step;
 * it needs Node and is not part of what runs a wizard.
 */
export async function loadWizard(dir: string): Promise<Wizard> {
  const file = JSON.parse(await readFile(join(dir, "wizard.json"), "utf8"));
  const steps = await folder(join(dir, "steps"));
  const evals: Record<string, Record<string, string>> = {};
  if (await exists(join(dir, "evals")))
    for (const of of (await readdir(join(dir, "evals"))).sort())
      evals[of] = await folder(join(dir, "evals", of));
  return { file, steps, evals };
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** Each file of a folder as one script for the sandbox, by its name. */
async function folder(dir: string): Promise<Record<string, string>> {
  const scripts: Record<string, string> = {};
  for (const name of (await readdir(dir)).sort()) {
    const out = await build({
      entryPoints: [join(dir, name)],
      bundle: true,
      write: false,
      format: "iife",
      globalName: "__step",
      platform: "neutral",
      target: "es2022",
    });
    scripts[parse(name).name] = out.outputFiles[0].text;
  }
  return scripts;
}
