// Which viewer (viewers.tsx) shows a file, known before the viewers load.

export type ViewerKind = "pdf" | "image" | "sheet" | "html" | "text";

const SHEET = /\.(xlsx|xlsm|xls|ods|csv|tsv)$/i;
const HTML = /\.html?$/i;
const TEXT =
  /\.(md|markdown|txt|text|log|json|jsonl|ya?ml|xml|toml|ini|css|js|mjs|ts|tsx|jsx|py|rb|php|sh|sql|vtt|srt)$/i;

/** Which viewer shows a file; null when none does (Word, PowerPoint, …: its text as read). */
export function viewerKind(mime: string, name: string): ViewerKind | null {
  if (mime === "application/pdf" || /\.pdf$/i.test(name)) {
    return "pdf";
  }
  if (mime.startsWith("image/")) {
    return "image";
  }
  if (
    SHEET.test(name) ||
    mime === "text/csv" ||
    mime === "text/tab-separated-values" ||
    mime.includes("spreadsheet") ||
    mime === "application/vnd.ms-excel"
  ) {
    return "sheet";
  }
  if (mime === "text/html" || HTML.test(name)) {
    return "html";
  }
  if (mime.startsWith("text/") || mime === "application/json" || TEXT.test(name)) {
    return "text";
  }
  return null;
}
