import { readdir, readFile, stat } from "node:fs/promises";
import { join, parse } from "node:path";
import { pathToFileURL } from "node:url";
import type { Wizard } from "./types";

/**
 * A wizard's folder as the kernel takes it: `wizard.json`, the default export of each
 * `steps/<id>.ts`, and of each `evals/<step>/<name>.ts`. A runner in Node loads its wizard this
 * way; one that is bundled, a Worker for example, imports the same files when it is built.
 */
export async function loadWizard(dir: string): Promise<Wizard> {
  const file = JSON.parse(await readFile(join(dir, "wizard.json"), "utf8"));
  const steps = await folder(join(dir, "steps"));
  const evals: Wizard["evals"] = {};
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

/** The default export of each file of a folder, by the file's name. */
async function folder(dir: string): Promise<Record<string, any>> {
  const exports: Record<string, any> = {};
  for (const name of (await readdir(dir)).sort())
    exports[parse(name).name] = (
      await import(/* @vite-ignore */ pathToFileURL(join(dir, name)).href)
    ).default;
  return exports;
}
