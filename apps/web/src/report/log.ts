/**
 * The last lines this page logged – its errors and warnings, a failed call – kept for "Report a
 * problem" (ReportDialog.tsx). Only what the person sends leaves the browser, and only masked.
 */

const KEEP = 100;
const lines: string[] = [];

export function keepLine(level: "error" | "warn", text: string) {
  const line = `${new Date().toISOString().slice(11, 19)} ${level} ${String(text).slice(0, 1500)}`;
  lines.push(line);
  if (lines.length > KEEP) {
    lines.shift();
  }
}

export const keptLines = (): string[] => [...lines];

/**
 * Text with what could name a person replaced: e-mail addresses, phone numbers, long numbers
 * (an IBAN, a card), and the values of an address's query (a ticket, a code).
 */
export function masked(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[email]")
    .replace(/\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,4})?\b/g, "[number]")
    .replace(/(\?|&)([\w-]+)=[^&\s#"']+/g, "$1$2=…")
    .replace(/\+?\d[\d\s()/-]{7,}\d/g, "[number]");
}

let hooked = false;

/** Keeps the console's errors and warnings as well, once. */
export function keepConsole() {
  if (hooked) {
    return;
  }
  hooked = true;
  for (const level of ["error", "warn"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      keepLine(
        level,
        args
          .map((a) =>
            a instanceof Error ? `${a.message}` : typeof a === "string" ? a : safeJson(a),
          )
          .join(" "),
      );
      original(...args);
    };
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)?.slice(0, 500) ?? String(value);
  } catch {
    return String(value);
  }
}
