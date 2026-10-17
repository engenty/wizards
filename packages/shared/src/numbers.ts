// SPDX-License-Identifier: FSL-1.1-MIT OR MIT

/**
 * Numbers as people write and read them: what a phone's number pad, a table cell or a document
 * gives, and an amount or a file's size as a page shows it. The server, the studio and the runner read and
 * show them the same way.
 */

/**
 * A number as a person types it: digits with at most one decimal mark, a point or a comma
 * alike, as a phone's number pad gives it in either language (`1.5`, `1,5`, `89,90`). There are
 * no thousands separators: `1.234` and `1,234` are 1.234, and anything with two marks
 * (`1.234,50`, `1.234.567`) is no number, since only the writer's language could say which mark
 * is which. Text that is not typed (a document, a website) is read by a model into numbers
 * before it gets here. With `units`, what stands around the number is dropped (`38 h`,
 * `19 %`); without, anything but the number makes it none. Null where there is no number.
 */
export function readNumber(value: unknown, opts: { units?: boolean } = {}): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string") {
    return null;
  }
  const s = opts.units ? value.replace(/[^\d,.-]/g, "") : value.trim();
  if (!/^-?(\d+([.,]\d*)?|[.,]\d+)$/.test(s)) {
    return null;
  }
  const n = Number(s.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/**
 * A file's size for a list, in decimal units as the operating systems show them: `1 KB` for
 * anything below a kilobyte but nothing (`0 KB`), `340 KB`, `2.4 MB`, `1.2 GB`.
 */
export function formatBytes(bytes: number): string {
  if (!(bytes > 0)) {
    return "0 KB";
  }
  if (bytes < 999_500) {
    return `${Math.max(1, Math.round(bytes / 1000))} KB`;
  }
  if (bytes < 999_950_000) {
    return `${(bytes / 1_000_000).toFixed(1)} MB`;
  }
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

/** An amount in a currency, as the language writes it (`1.234,50 €`); an unknown currency code as `1234.50 XYZ`. */
export function formatMoney(amount: number, currency: string, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}
