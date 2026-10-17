import {
  parseWizard,
  type ValidationIssue,
  type WizardDefinition,
} from "@engenty-wizards/shared/definition";
import { type StandaloneFit, standaloneEntry } from "@engenty-wizards/shared/fit";
import {
  PACKAGE_FILES,
  PACKAGE_FORMAT,
  PACKAGE_MANIFEST,
} from "@engenty-wizards/shared/wizard-package";
import { strFromU8, unzipSync } from "fflate";
import { t } from "./i18n.js";

/**
 * The check a host runs on a `.wizard` package before it keeps it: the definition read, its
 * shape checked, and whether it runs on its own (packages/shared/src/fit.ts). The WordPress
 * plugin's import runs this in the browser; the studio computes the same on its server.
 */

export { PACKAGE_EXTENSION, PACKAGE_MIME } from "@engenty-wizards/shared/wizard-package";

export interface PackageFile {
  path: string;
  data: Uint8Array;
  mime: string;
}

export interface CheckedPackage {
  definition: WizardDefinition;
  files: PackageFile[];
  /** What the validator has to say: an issue with a step blocks the import. */
  issues: ValidationIssue[];
  fit: StandaloneFit;
}

export class PackageError extends Error {
  constructor(
    message: string,
    readonly issues: ValidationIssue[] = [],
  ) {
    super(message);
  }
}

const MIME: Record<string, string> = {
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  json: "application/json",
  md: "text/markdown",
  txt: "text/plain",
  csv: "text/csv",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  zip: "application/zip",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  woff2: "font/woff2",
};

export function mimeOf(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return MIME[ext] ?? "application/octet-stream";
}

function json(data: Uint8Array): unknown {
  try {
    return JSON.parse(strFromU8(data));
  } catch {
    throw new PackageError(t("package.badJson"));
  }
}

/** A manifest, or a bare definition: a wizard without workspace is fully told by its JSON. */
function definitionOf(raw: unknown): unknown {
  const manifest = raw as { format?: unknown; definition?: unknown } | null;
  return manifest?.format === PACKAGE_FORMAT ? manifest.definition : raw;
}

/** Reads the package's bytes: the manifest and the workspace files under `files/`. */
export function readPackage(data: Uint8Array): { definition: unknown; files: PackageFile[] } {
  const zipped = data[0] === 0x50 && data[1] === 0x4b;
  if (!zipped) {
    return { definition: definitionOf(json(data)), files: [] };
  }
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(data, {
      filter: (file) =>
        !file.name.endsWith("/") && !file.name.startsWith("__MACOSX/") && !/\/\./.test(file.name),
    });
  } catch {
    throw new PackageError(t("package.unreadable"));
  }
  const manifest = entries[PACKAGE_MANIFEST];
  if (!manifest) {
    throw new PackageError(t("package.noManifest"));
  }
  const files = Object.entries(entries)
    .filter(([name]) => name.startsWith(PACKAGE_FILES))
    .map(([name, bytes]) => ({
      path: name.slice(PACKAGE_FILES.length),
      data: bytes,
      mime: mimeOf(name),
    }));
  return { definition: definitionOf(json(manifest)), files };
}

/** The package checked: a definition this app reads, its workspace, and whether it runs on its own. */
export function checkPackage(data: Uint8Array): CheckedPackage {
  const { definition, files } = readPackage(data);
  const parsed = parseWizard(
    definition,
    files.map((f) => f.path),
  );
  if (!parsed.ok) {
    throw new PackageError(t("package.newer"), parsed.issues);
  }
  return {
    definition: parsed.wizard,
    files,
    issues: parsed.issues,
    fit: standaloneEntry(parsed.wizard),
  };
}

export { type Need, type StepNeed, standaloneFit } from "@engenty-wizards/shared/fit";
export { type StandaloneFit, standaloneEntry };
