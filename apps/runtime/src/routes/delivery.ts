import { basePath } from "../env.js";

/** Uploads stay small; a clip from the phone's camera is the one thing that needs more room. */
export function uploadLimit(mime: string): number {
  return mime.startsWith("video/") ? 40_000_000 : 15_000_000;
}

/** `type/subtype` and nothing else: no commas, spaces or quotes a browser could read another type from. */
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

/** The bare type of a declared one ("audio/webm;codecs=opus" → "audio/webm"), or null if it is not one. */
export function bareMime(declared: string): string | null {
  const mime = declared.split(";")[0].trim().toLowerCase();
  return MIME.test(mime) ? mime : null;
}

/** What a person hands a wizard besides photos, recordings and clips: documents and tables. */
const DOCUMENT_TYPES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.presentation",
  "application/rtf",
  "application/json",
  "application/zip",
  "message/rfc822",
  "text/plain",
  "text/csv",
  "text/tab-separated-values",
  "text/markdown",
  "text/calendar",
  "text/vcard",
]);

/**
 * The type an upload is kept as: the browser's word for it, when it is a picture, a recording, a
 * clip or a document. Anything else (an HTML page, a script) is kept as plain bytes; reading it
 * goes by its name (documents/parse.ts).
 */
export function uploadMime(declared: string): string {
  const mime = bareMime(declared);
  return mime && (/^(image|audio|video)\//.test(mime) || DOCUMENT_TYPES.has(mime))
    ? mime
    : "application/octet-stream";
}

/** What a browser shows in place without running anything of the file's: photos, sound, film, PDFs. */
export function inlineSafe(mime: string): boolean {
  return (
    (/^(image|audio|video)\//.test(mime) && !mime.startsWith("image/svg")) ||
    mime === "application/pdf"
  );
}

/** `version`: the published one, so a new engenty or name reaches icons a phone has kept. */
export function wizardManifest(token: string, title: string, description: string, version = 0) {
  const start = `${basePath}/w/${token}`;
  const icon = (file: string) =>
    `${basePath}/api/public/wizards/${token}/icons/${file}?v=${version}`;
  return {
    id: start,
    name: title,
    short_name: title.length > 14 ? `${title.slice(0, 13).trimEnd()}…` : title,
    description,
    start_url: start,
    scope: `${basePath}/`,
    display: "standalone",
    background_color: "#faf8f5",
    theme_color: "#faf8f5",
    icons: [
      { src: icon("icon-192.png"), sizes: "192x192", type: "image/png", purpose: "any" },
      { src: icon("icon-512.png"), sizes: "512x512", type: "image/png", purpose: "any" },
      {
        src: icon("icon-maskable-512.png"),
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}

/**
 * One byte range of a file, as phones ask for audio and video: Safari plays a clip only from a
 * server that answers ranges. `null` = no (usable) range asked, send it whole.
 */
export function byteRange(header: string | undefined, size: number) {
  const m = header?.match(/^bytes=(\d*)-(\d*)$/);
  if (!m || (!m[1] && !m[2]) || size === 0) {
    return null;
  }
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  return start > end || start >= size ? ("unsatisfiable" as const) : { start, end };
}
