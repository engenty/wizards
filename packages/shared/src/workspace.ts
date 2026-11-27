/** A file in a wizard's workspace. The content lives in the blob store under its hash. */
export interface WorkspaceFile {
  path: string;
  hash: string;
  mime: string;
  size: number;
}

export const WORKSPACE_LIMITS = {
  fileBytes: 5_000_000,
  totalBytes: 25_000_000,
  files: 200,
};

const PATH_RE = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*(\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$/;

/** Relative, forward slashes, no `..`, no hidden files. Returns the normalised path or null. */
export function cleanPath(raw: string): string | null {
  const path = raw.trim().replace(/^\.?\/+/, "");
  if (path.length > 200 || !PATH_RE.test(path) || path.split("/").some((p) => p === "..")) {
    return null;
  }
  return path;
}

const MIME_BY_EXT: Record<string, string> = {
  html: "text/html",
  htm: "text/html",
  js: "text/javascript",
  mjs: "text/javascript",
  // A step file of a wizard in version 0.3.0: code to read and edit, as text.
  ts: "text/typescript",
  css: "text/css",
  json: "application/json",
  geojson: "application/geo+json",
  csv: "text/csv",
  txt: "text/plain",
  md: "text/markdown",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
  webm: "video/webm",
  pdf: "application/pdf",
};

export function mimeForPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

export function isTextMime(mime: string): boolean {
  return (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/geo+json" ||
    mime === "image/svg+xml"
  );
}
