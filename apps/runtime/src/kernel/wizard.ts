import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { Wizard } from "@engenty/wizards-kernel";
import type { KernelFile } from "@engenty/wizards-shared/definition";
import { evalFilesOf, stepFilesOf } from "@engenty/wizards-shared/kernel-file";
import type { WorkspaceFile } from "@engenty/wizards-shared/workspace";
import { build, type Plugin } from "esbuild";
import { objects } from "../files/objects.js";
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

/**
 * The files a compile reads, by path. Declarations (`wizard.d.ts`) are left out: no step's code
 * comes of them, so writing them leaves what is compiled as it was.
 */
const codeOf = (files: WorkspaceFile[]) =>
  files
    .filter((f) => CODE.test(f.path) && !f.path.endsWith(".d.ts"))
    .sort((a, b) => a.path.localeCompare(b.path));
const compiled = new Map<string, Promise<Wizard>>();

/** A workspace file's text by its path; null where there is none. */
export type ReadCode = (path: string) => Promise<string | null>;

/** The code files of a workspace a run started with, read from where files are kept. */
const stored =
  (code: WorkspaceFile[]): ReadCode =>
  async (path) =>
    (await snapshotFile(code, path))?.data.toString("utf8") ?? null;

export class KernelCompileError extends Error {}

export function kernelWizard(
  file: KernelFile,
  files: WorkspaceFile[],
  mode: StepMode,
): Promise<Wizard> {
  const code = codeOf(files);
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
  const { texts, issues } = await compiledCode(code, mode);
  if (!texts) {
    throw new KernelCompileError(issues[0].message);
  }
  const one = (path: string, text: string) => (mode === "native" ? load(path, text) : text);
  const steps: Wizard["steps"] = {};
  for (const [id, text] of Object.entries(texts.steps)) {
    steps[id] = await one(`steps/${id}`, text);
  }
  const evals: NonNullable<Wizard["evals"]> = {};
  for (const [of, named] of Object.entries(texts.evals)) {
    evals[of] = {};
    for (const [name, text] of Object.entries(named)) {
      evals[of][name] = await one(`evals/${of}/${name}`, text);
    }
  }
  return { file: file as Wizard["file"], steps, evals };
}

/** The compiled code of a wizard's steps and evals, each as the text the step mode runs. */
type Texts = { steps: Record<string, string>; evals: Record<string, Record<string, string>> };

type Compiled = { texts: Texts | null; issues: { path: string; message: string }[] };

/** Compiles every step and eval file; `texts` only when all of them compile. */
async function compileAll(
  paths: readonly string[],
  read: ReadCode,
  native: boolean,
): Promise<Compiled> {
  const code = paths.filter((path) => CODE.test(path));
  const texts: Texts = { steps: {}, evals: {} };
  const issues: Compiled["issues"] = [];
  const one = async (path: string) => {
    try {
      return await bundle(path, code, read, native);
    } catch (err) {
      if (!(err instanceof KernelCompileError)) {
        throw err;
      }
      issues.push({ path, message: err.message });
      return "";
    }
  };
  for (const [id, path] of Object.entries(stepFilesOf(code))) {
    texts.steps[id] = await one(path);
  }
  for (const [of, named] of Object.entries(evalFilesOf(code))) {
    texts.evals[of] = {};
    for (const [name, path] of Object.entries(named)) {
      texts.evals[of][name] = await one(path);
    }
  }
  return { texts: issues.length ? null : texts, issues };
}

/**
 * The step and eval files that do not compile for the sandbox, each with what is wrong and
 * where. Nothing runs: this is the compile a run does at its start, for every file at once.
 */
export async function compileIssues(
  paths: readonly string[],
  read: ReadCode,
): Promise<{ path: string; message: string }[]> {
  return (await compileAll(paths, read, false)).issues;
}

/** Where the compiled code of a workspace is kept in the object store. */
export const compiledKey = (files: WorkspaceFile[], mode: StepMode) =>
  `compiled/${mode}/${createHash("sha256")
    .update(JSON.stringify(codeOf(files).map((f) => [f.path, f.hash])))
    .digest("hex")}.json`;

/**
 * The compiled code of a workspace, kept in the object store beside the blobs by the hash of its
 * code files: compiled once, at the first save that has it, and found there by every run and
 * every runtime after. Code that does not compile is not kept; its issues come back each time.
 */
export async function compiledCode(files: WorkspaceFile[], mode: StepMode): Promise<Compiled> {
  const code = codeOf(files);
  const key = compiledKey(files, mode);
  const kept = await objects.get(key);
  if (kept) {
    return { texts: JSON.parse(kept.toString("utf8")) as Texts, issues: [] };
  }
  const made = await compileAll(
    code.map((f) => f.path),
    stored(code),
    mode === "native",
  );
  if (made.texts) {
    await objects.put(key, Buffer.from(JSON.stringify(made.texts), "utf8"));
  }
  return made;
}

/** The workspace as esbuild's file system: a file imports its neighbours and nothing else. */
function workspace(paths: readonly string[], read: ReadCode, native: boolean): Plugin {
  const has = new Set(paths);
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
        return {
          contents: (await read(args.path)) ?? "",
          loader: args.path.endsWith(".json") ? "json" : args.path.endsWith(".ts") ? "ts" : "js",
        };
      });
    },
  };
}

async function bundle(
  path: string,
  paths: readonly string[],
  read: ReadCode,
  native: boolean,
): Promise<string> {
  try {
    const out = await build({
      entryPoints: [path],
      bundle: true,
      write: false,
      logLevel: "silent",
      target: "es2022",
      plugins: [workspace(paths, read, native)],
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

/** A step compiled for this process, loaded as a module of it. */
async function load(path: string, text: string) {
  const loaded = (await import(
    `data:text/javascript;base64,${Buffer.from(text).toString("base64")}`
  )) as { default?: unknown };
  if (typeof loaded.default !== "function") {
    throw new KernelCompileError(`${path}: a step exports one function as its default.`);
  }
  return loaded.default as never;
}
