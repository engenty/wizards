import { note, type Said } from "@engenty-wizards/shared/run";
import {
  type Manifest,
  manifestSchema,
  PACKAGE_FILES,
  PACKAGE_FORMAT,
  PACKAGE_MANIFEST,
  PACKAGE_MAX_BYTES,
} from "@engenty-wizards/shared/wizard-package";
import { cleanPath, WORKSPACE_LIMITS } from "@engenty-wizards/shared/workspace";
import { strFromU8, unzipSync } from "fflate";
import { ServiceError } from "./errors.js";

/**
 * Reading a `.wizard` package, with nothing of a project or a database: the studio's import and
 * `wizards validate` both start here.
 */

const invalid = (said: Said) => new ServiceError("invalid", said);

export function json(data: Uint8Array): unknown {
  try {
    return JSON.parse(strFromU8(data));
  } catch {
    throw invalid(note("wizardJsonUnreadable"));
  }
}

/** A manifest, or a bare definition: a wizard without workspace is fully told by its JSON. */
export function readManifest(raw: unknown): Manifest {
  if ((raw as { format?: unknown } | null)?.format !== PACKAGE_FORMAT) {
    return { format: PACKAGE_FORMAT, version: 1, definition: raw, connectors: [], mcpServers: [] };
  }
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw invalid(note("wizardFileComesNewer"));
  }
  return parsed.data;
}

/** The package's content, checked against the workspace limits before anything is unpacked. */
export function readPackage(data: Uint8Array): {
  manifest: Manifest;
  files: { path: string; data: Uint8Array }[];
} {
  const zipped = data[0] === 0x50 && data[1] === 0x4b;
  if (!zipped) {
    return { manifest: readManifest(json(data)), files: [] };
  }
  let total = 0;
  let count = 0;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(data, {
      filter: (file) => {
        // Folders, and what the Finder adds when a package is zipped by hand.
        if (file.name.endsWith("/") || /(^|\/)(__MACOSX\/|\.DS_Store$)/.test(file.name)) {
          return false;
        }
        total += file.originalSize;
        count += 1;
        if (file.originalSize > WORKSPACE_LIMITS.fileBytes) {
          throw invalid(note("fileOver5Mb", { name: file.name }));
        }
        if (count > WORKSPACE_LIMITS.files + 1 || total > PACKAGE_MAX_BYTES) {
          throw invalid(note("wizardFileTooLarge"));
        }
        return true;
      },
    });
  } catch (err) {
    throw err instanceof ServiceError ? err : invalid(note("wizardFileNotOpened"));
  }
  // A package unpacked and zipped again often sits in a folder of its own.
  const manifestPath = Object.keys(entries)
    .filter((name) => name === PACKAGE_MANIFEST || name.endsWith(`/${PACKAGE_MANIFEST}`))
    .sort((a, b) => a.length - b.length)[0];
  if (manifestPath === undefined) {
    throw invalid(note("wizardJsonMissing"));
  }
  const root = manifestPath.slice(0, -PACKAGE_MANIFEST.length);
  const files = Object.entries(entries)
    .filter(([name]) => name.startsWith(root + PACKAGE_FILES))
    .map(([name, content]) => {
      const path = cleanPath(name.slice(root.length + PACKAGE_FILES.length));
      if (!path) {
        throw invalid(note("notValidFilePath", { name }));
      }
      return { path, data: content };
    });
  if (files.reduce((n, f) => n + f.data.byteLength, 0) > WORKSPACE_LIMITS.totalBytes) {
    throw invalid(note("workspaceWizardFileLarger"));
  }
  return { manifest: readManifest(json(entries[manifestPath])), files };
}
