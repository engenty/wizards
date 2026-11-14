import { readdir, readFile, stat } from "node:fs/promises";
import { join, parse } from "node:path";
import { build } from "esbuild";
import type { Wizard } from "./types";

/**
 * A wizard's folder for QuickJS: each `steps/<id>.ts` and `evals/<step>/<name>.ts` bundled into
 * one script that sets `__step`, types stripped and helpers the file imports inlined. A step that
 * imports one of Node's own modules does not compile: there is none where it runs.
 *
 * This is the save step. It needs Node and is not part of what runs a wizard.
 */
export async function compileWizard(dir: string): Promise<Wizard> {
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

/** One file as a script for QuickJS. */
export async function compileStep(path: string): Promise<string> {
  const out = await build({
    entryPoints: [path],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "__step",
    platform: "neutral",
    target: "es2022",
    logLevel: "silent",
  });
  return out.outputFiles[0].text;
}

async function folder(dir: string): Promise<Record<string, string>> {
  const scripts: Record<string, string> = {};
  for (const name of (await readdir(dir)).sort())
    scripts[parse(name).name] = await compileStep(join(dir, name));
  return scripts;
}
