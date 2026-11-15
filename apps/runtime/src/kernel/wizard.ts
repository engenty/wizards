import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { Wizard } from "@engenty/wizards-kernel";
import type { KernelFile } from "@engenty/wizards-shared/definition";
import { evalFilesOf, stepFilesOf } from "@engenty/wizards-shared/kernel-file";
import type { WorkspaceFile } from "@engenty/wizards-shared/workspace";
import { build, type Plugin } from "esbuild";
import { snapshotFile } from "../services/files.js";

/**
 * A wizard of version 0.3.0 as the kernel takes it (docs/plans/kernel.md): its file, and the code of
 * its steps and evals compiled from the workspace a run started with.
 *
 * `quickjs`: each step is one script for the sandbox. A step that imports anything but a file of
 * its own workspace does not compile: nothing else is there where it runs. `native`: each step is
 * a module of this process, for a runner that is one tenant's and code that is its own.
 */
export type StepMode = "quickjs" | "native";

const CODE = /\.(ts|js|mjs|json)$/;
const compiled = new Map<string, Promise<Wizard>>();

export class KernelCompileError extends Error {}

export function kernelWizard(
  file: KernelFile,
  files: WorkspaceFile[],
  mode: StepMode,
): Promise<Wizard> {
  const code = files.filter((f) => CODE.test(f.path)).sort((a, b) => a.path.localeCompare(b.path));
  const key = createHash("sha256")
    .update(JSON.stringify([mode, file, code.map((f) => [f.path, f.hash])]))
    .digest("hex");
  let wizard = compiled.get(key);
  if (!wizard) {
    wizard = compile(file, code, mode);
    compiled.set(key, wizard);
    // A wizard that does not compile is tried again when it is asked for again.
    wizard.catch(() => compiled.delete(key));
    if (compiled.size > 200) {
      compiled.delete(compiled.keys().next().value as string);
    }
  }
  return wizard;
}

async function compile(file: KernelFile, code: WorkspaceFile[], mode: StepMode): Promise<Wizard> {
  const paths = code.map((f) => f.path);
  const one = (path: string) => (mode === "quickjs" ? script(path, code) : module(path, code));
  const steps: Wizard["steps"] = {};
  for (const [id, path] of Object.entries(stepFilesOf(paths))) {
    steps[id] = await one(path);
  }
  const evals: NonNullable<Wizard["evals"]> = {};
  for (const [of, named] of Object.entries(evalFilesOf(paths))) {
    evals[of] = {};
    for (const [name, path] of Object.entries(named)) {
      evals[of][name] = await one(path);
    }
  }
  return { file: file as Wizard["file"], steps, evals };
}

/** The workspace as esbuild's file system: a file imports its neighbours and nothing else. */
function workspace(code: WorkspaceFile[], native: boolean): Plugin {
  const has = new Set(code.map((f) => f.path));
  return {
    name: "workspace",
    setup(b) {
      b.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === "entry-point") {
          return { path: args.path, namespace: "ws" };
        }
        if (!args.path.startsWith(".")) {
          if (native && args.path.startsWith("node:")) {
            return { path: args.path, external: true };
          }
          return {
            errors: [
              {
                text: `A step imports files of its own workspace only, not "${args.path}".`,
              },
            ],
          };
        }
        const base = posix.normalize(posix.join(posix.dirname(args.importer), args.path));
        const found = [
          base,
          `${base}.ts`,
          `${base}.js`,
          `${base}.mjs`,
          base.replace(/\.js$/, ".ts"),
        ].find((p) => has.has(p));
        return found
          ? { path: found, namespace: "ws" }
          : { errors: [{ text: `"${args.path}" is no file of the workspace.` }] };
      });
      b.onLoad({ filter: /.*/, namespace: "ws" }, async (args) => {
        const got = await snapshotFile(code, args.path);
        return {
          contents: got?.data.toString("utf8") ?? "",
          loader: args.path.endsWith(".json") ? "json" : args.path.endsWith(".ts") ? "ts" : "js",
        };
      });
    },
  };
}

async function bundle(path: string, code: WorkspaceFile[], native: boolean): Promise<string> {
  try {
    const out = await build({
      entryPoints: [path],
      bundle: true,
      write: false,
      logLevel: "silent",
      target: "es2022",
      plugins: [workspace(code, native)],
      ...(native
        ? { format: "esm" as const, platform: "node" as const }
        : { format: "iife" as const, globalName: "__step", platform: "neutral" as const }),
    });
    return out.outputFiles[0].text;
  } catch (err) {
    const errors = (
      err as { errors?: { text: string; location?: { file: string; line: number } | null }[] }
    ).errors;
    const first = errors?.[0];
    throw new KernelCompileError(
      first
        ? `${first.location ? `${first.location.file.replace(/^ws:/, "")}:${first.location.line}: ` : `${path}: `}${first.text}`
        : `${path}: ${(err as Error).message}`,
    );
  }
}

const script = (path: string, code: WorkspaceFile[]) => bundle(path, code, false);

async function module(path: string, code: WorkspaceFile[]) {
  const text = await bundle(path, code, true);
  const loaded = (await import(
    `data:text/javascript;base64,${Buffer.from(text).toString("base64")}`
  )) as { default?: unknown };
  if (typeof loaded.default !== "function") {
    throw new KernelCompileError(`${path}: a step exports one function as its default.`);
  }
  return loaded.default as never;
}
