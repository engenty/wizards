import { readdir, readFile } from "node:fs/promises";
import { join, parse } from "node:path";
import { build } from "esbuild";
import type { Wizard } from "./types";

/**
 * A wizard's folder as the kernel takes it: `wizard.json`, and each `steps/<id>.ts` bundled into
 * one script for the sandbox, types stripped and shared helpers inlined. This is the save step;
 * it needs Node and is not part of what runs a wizard.
 */
export async function loadWizard(dir: string): Promise<Wizard> {
  const file = JSON.parse(await readFile(join(dir, "wizard.json"), "utf8"));
  const steps: Record<string, string> = {};
  for (const name of (await readdir(join(dir, "steps"))).sort()) {
    const out = await build({
      entryPoints: [join(dir, "steps", name)],
      bundle: true,
      write: false,
      format: "iife",
      globalName: "__step",
      platform: "neutral",
      target: "es2022",
    });
    steps[parse(name).name] = out.outputFiles[0].text;
  }
  return { file, steps };
}
