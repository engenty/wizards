/**
 * Where a run's wizard comes from (docs/plans/runs-on-their-own.md, phase 5): a folder with
 * `wizard.json` and its workspace under `files/`, a `.wizard` file (or a wizard's JSON on its
 * own), or an http(s) address that answers either file.
 *
 * Each is read the way the studio's import reads it (`@engenty/wizards-shared/wizard-package-read`)
 * and checked before anything starts, with the checks of `wizards validate`
 * (`@engenty/wizards-engine/wizard-check`). A wizard that fails them is refused with what is wrong;
 * nothing is started. What a space holds (connectors, MCP servers, plugins) is checked where the
 * run is placed at its tenant, not here.
 *
 * The three give the same wizard: the definition as it parses, and the workspace's files sorted by
 * path, each with its bytes and the SHA-256 the tenant's blob store files it under.
 */
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve as resolvePath } from "node:path";
import { checkWizard } from "@engenty/wizards-engine/wizard-check";
import type { ValidationIssue, WizardDefinition } from "@engenty/wizards-shared/definition";
import { note, type RunNote, saidText } from "@engenty/wizards-shared/run";
import {
  type Manifest,
  PACKAGE_FILES,
  PACKAGE_MANIFEST,
  PACKAGE_MAX_BYTES,
  PACKAGE_MIME,
} from "@engenty/wizards-shared/wizard-package";
import {
  PackageUnreadable,
  packageJson,
  readManifest,
  readPackage,
} from "@engenty/wizards-shared/wizard-package-read";
import {
  cleanPath,
  mimeForPath,
  WORKSPACE_LIMITS,
  type WorkspaceFile,
} from "@engenty/wizards-shared/workspace";

/** The most an address may answer: what a `.wizard` file may be (30 MB). */
export const ADDRESS_MAX_BYTES = PACKAGE_MAX_BYTES;
/** How long an address may take to answer in full. */
export const ADDRESS_TIMEOUT_MS = 30_000;

export type WizardSourceKind = "folder" | "file" | "url";

export interface WizardSource {
  kind: WizardSourceKind;
  /** The folder or file as an absolute path; the address as given. */
  where: string;
}

/** A workspace file of the wizard, with its bytes: whoever hands the run over stores them under `hash`. */
export interface ResolvedFile extends WorkspaceFile {
  data: Uint8Array;
}

export interface ResolvedWizard {
  definition: WizardDefinition;
  /** Sorted by path. */
  files: ResolvedFile[];
  source: WizardSource;
}

/** A source that is not a wizard that can run: what is wrong with it, one issue a line. */
export class WizardRefused extends Error {
  constructor(
    readonly source: WizardSource,
    readonly issues: ValidationIssue[],
  ) {
    super(
      [
        `${source.where} can’t run:`,
        ...issues.map((i) => `  ${i.stepId ? `${i.stepId}: ` : ""}${i.message}`),
      ].join("\n"),
    );
    this.name = "WizardRefused";
  }
}

export interface ResolveOptions {
  /** How an address is fetched; left out: the global `fetch`. */
  fetch?: typeof fetch;
  /** Left out: `ADDRESS_TIMEOUT_MS`. */
  timeoutMs?: number;
}

interface Read {
  manifest: Manifest;
  files: { path: string; data: Uint8Array }[];
}

/** Something that stops the source from being read, said in English. */
class Unread extends Error {}

const unread = (said: RunNote | string) => new Unread(saidText(said, "en"));

/**
 * The wizard at `source`: a folder, a file or an http(s) address. Throws `WizardRefused` when it
 * can't be read or fails the checks.
 */
export async function resolveWizard(
  source: string,
  options: ResolveOptions = {},
): Promise<ResolvedWizard> {
  const from = await sourceOf(source);
  let read: Read;
  try {
    read =
      from.kind === "url"
        ? await fromAddress(from.where, options)
        : from.kind === "folder"
          ? await fromFolder(from.where)
          : await fromFile(from.where);
  } catch (err) {
    if (err instanceof Unread) {
      throw new WizardRefused(from, [{ message: err.message }]);
    }
    if (err instanceof PackageUnreadable) {
      throw new WizardRefused(from, [{ message: saidText(err.said, "en") }]);
    }
    throw err;
  }
  const files = [...read.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const byPath = new Map(files.map((f) => [f.path, f.data]));
  const checked = await checkWizard({
    definition: read.manifest.definition,
    files: files.map((f) => f.path),
    read: async (path) => {
      const data = byPath.get(path);
      return data ? new TextDecoder().decode(data) : null;
    },
  });
  if (!checked.ok) {
    throw new WizardRefused(from, checked.issues);
  }
  return {
    definition: checked.wizard,
    files: files.map(({ path, data }) => ({
      path,
      hash: createHash("sha256").update(data).digest("hex"),
      mime: mimeForPath(path),
      size: data.byteLength,
      data,
    })),
    source: from,
  };
}

/** Which of the three `source` is. A path that isn't there is refused here. */
async function sourceOf(source: string): Promise<WizardSource> {
  const scheme = /^([a-z][a-z\d+.-]*):\/\//i.exec(source)?.[1]?.toLowerCase();
  if (scheme) {
    if (scheme !== "http" && scheme !== "https") {
      throw new WizardRefused({ kind: "url", where: source }, [
        { message: "Only an http or https address can be opened." },
      ]);
    }
    return { kind: "url", where: source };
  }
  const path = resolvePath(source);
  let isFolder: boolean;
  try {
    isFolder = (await stat(path)).isDirectory();
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
    throw new WizardRefused({ kind: "file", where: path }, [
      { message: missing ? "No such file or folder." : (err as Error).message },
    ]);
  }
  if (isFolder) {
    return { kind: "folder", where: path };
  }
  // An unpacked package named by its wizard.json: the folder around it.
  return basename(path) === PACKAGE_MANIFEST
    ? { kind: "folder", where: dirname(path) }
    : { kind: "file", where: path };
}

/** An unpacked package: `wizard.json`, and the workspace under `files/`, held to a package's limits. */
async function fromFolder(folder: string): Promise<Read> {
  let manifestData: Uint8Array;
  try {
    manifestData = await readFile(join(folder, PACKAGE_MANIFEST));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw unread(note("wizardJsonMissing"));
    }
    throw err;
  }
  const manifest = readManifest(packageJson(manifestData));
  const root = join(folder, PACKAGE_FILES);
  let entries: Awaited<ReturnType<typeof listed>>;
  try {
    entries = await listed(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { manifest, files: [] };
    }
    throw err;
  }
  const files: Read["files"] = [];
  let total = 0;
  for (const entry of entries) {
    const name = relative(root, entry).split("\\").join("/");
    const path = cleanPath(name);
    if (!path) {
      throw unread(note("notValidFilePath", { name }));
    }
    const size = (await stat(entry)).size;
    if (size > WORKSPACE_LIMITS.fileBytes) {
      throw unread(note("fileOver5Mb", { name }));
    }
    total += size;
    if (files.length + 1 > WORKSPACE_LIMITS.files) {
      throw unread(note("wizardFileTooLarge"));
    }
    if (total > WORKSPACE_LIMITS.totalBytes) {
      throw unread(note("workspaceWizardFileLarger"));
    }
    const data = await readFile(entry);
    // The bytes as a plain Uint8Array, as a file's unzipped ones are.
    files.push({ path, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) });
  }
  return { manifest, files };
}

/** The files under `root`, as `wizards validate` reads them: no folders, links or `.DS_Store`. */
async function listed(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name !== ".DS_Store")
    .map((entry) => join(entry.parentPath, entry.name));
}

/** A `.wizard` file, or a wizard's JSON on its own. */
async function fromFile(path: string): Promise<Read> {
  if ((await stat(path)).size > PACKAGE_MAX_BYTES) {
    throw unread(note("wizardFileTooLarge"));
  }
  return readPackage(await readFile(path));
}

/**
 * An address that answers a `.wizard` file or a wizard's JSON. Nothing but the address goes with
 * the request: no cookies, no authorization. Redirects are followed; an answer over
 * `ADDRESS_MAX_BYTES` or slower than the timeout is refused.
 */
async function fromAddress(address: string, options: ResolveOptions): Promise<Read> {
  const timeoutMs = options.timeoutMs ?? ADDRESS_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);
  const timedOut = () => unread(`${address} didn’t answer within ${timeoutMs / 1000} seconds.`);
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(address, {
      headers: { accept: `${PACKAGE_MIME}, application/zip, application/json;q=0.9, */*;q=0.5` },
      redirect: "follow",
      credentials: "omit",
      signal,
    });
  } catch (err) {
    if (signal.aborted) {
      throw timedOut();
    }
    throw unread(`${address} can’t be reached: ${(err as Error).message}`);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw unread(`${address} answered ${response.status} ${response.statusText}`.trim());
  }
  const length = Number(response.headers.get("content-length") ?? Number.NaN);
  if (length > ADDRESS_MAX_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw unread(note("wizardFileTooLarge"));
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    const reader = response.body?.getReader();
    while (reader) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > ADDRESS_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw unread(note("wizardFileTooLarge"));
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof Unread) {
      throw err;
    }
    if (signal.aborted) {
      throw timedOut();
    }
    throw unread(`${address} can’t be read: ${(err as Error).message}`);
  }
  const data = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    data.set(chunk, at);
    at += chunk.byteLength;
  }
  return readPackage(data);
}
