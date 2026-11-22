// Keeps the values of secrets out of text and data before a model, a message or a log sees them:
// a token an API echoes, an error that quotes the request, a URL with the key in its query.
// It matches the exact values it is given, as they are and as JSON, a URL and a form write them.
// Patterns that guess at secrets (a bearer header, an `sk-` key) are the caller's own.

export const REDACTED = "[secret]";

/** Values shorter than this are not looked for: they would match ordinary words and numbers. */
export const MIN_SECRET_LENGTH = 8;

export interface Redactor {
  /** The text with every form of every secret replaced. */
  text(value: string): string;
  /** A copy of the data with every string in it redacted, keys of objects included. */
  value<T>(value: T): T;
}

function forms(secret: string): string[] {
  const all = new Set<string>();
  for (const value of [secret, secret.trim()]) {
    if (value.length < MIN_SECRET_LENGTH) {
      continue;
    }
    all.add(value);
    all.add(JSON.stringify(value).slice(1, -1));
    all.add(encodeURIComponent(value));
    all.add(new URLSearchParams({ v: value }).toString().slice(2));
  }
  return [...all];
}

const literal = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A redactor for these secrets. Longer ones are replaced first, so one inside another goes whole. */
export function redactor(secrets: Iterable<string>, replacement = REDACTED): Redactor {
  const variants = [...new Set([...secrets].flatMap(forms))].sort((a, b) => b.length - a.length);
  const pattern = variants.length ? new RegExp(variants.map(literal).join("|"), "g") : null;
  const text = (value: string) => (pattern ? value.replace(pattern, replacement) : value);

  const walk = (value: unknown, seen: WeakMap<object, unknown>): unknown => {
    if (typeof value === "string") {
      return text(value);
    }
    if (value === null || typeof value !== "object") {
      return value;
    }
    if (seen.has(value)) {
      return seen.get(value);
    }
    if (Array.isArray(value)) {
      const copy: unknown[] = [];
      seen.set(value, copy);
      for (const item of value) {
        copy.push(walk(item, seen));
      }
      return copy;
    }
    if (value instanceof Date || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
      return value;
    }
    const copy: Record<string, unknown> = {};
    seen.set(value, copy);
    for (const [key, item] of Object.entries(value)) {
      copy[text(key)] = walk(item, seen);
    }
    return copy;
  };

  return {
    text,
    value: <T>(value: T) => (pattern ? (walk(value, new WeakMap()) as T) : value),
  };
}
