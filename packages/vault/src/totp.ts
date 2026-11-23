import { createHmac } from "node:crypto";

// Authenticator keys (TOTP, RFC 6238): the setup key a website shows beside its QR code, or the
// `otpauth://` link. The home keeps it in the canonical link form and makes the current code.

type Algorithm = "SHA1" | "SHA256" | "SHA512";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32(value: string): string | undefined {
  const secret = value.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
  if (secret.length < 16 || secret.length > 256 || !/^[A-Z2-7]+$/.test(secret)) return undefined;
  if (![0, 2, 4, 5, 7].includes(secret.length % 8)) return undefined;
  return secret;
}

function bytesOf(secret: string): Buffer {
  const bytes: number[] = [];
  let bits = 0;
  let buffer = 0;
  for (const char of secret) {
    buffer = (buffer << 5) | ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

const linkOf = (secret: string, algorithm: string, digits: number, period: number) =>
  `otpauth://totp/?secret=${secret}&algorithm=${algorithm}&digits=${digits}&period=${period}`;

/** The key in its canonical form, or undefined when it is no authenticator key. */
export function authenticatorKey(value: string): string | undefined {
  const text = value.trim();
  if (!/^otpauth:\/\//i.test(text)) {
    const secret = base32(text);
    return secret ? linkOf(secret, "SHA1", 6, 30) : undefined;
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.hostname.toLowerCase() !== "totp") return undefined;
  const secret = base32(url.searchParams.get("secret") ?? "");
  const algorithm = (url.searchParams.get("algorithm") ?? "SHA1").toUpperCase();
  const digits = Number(url.searchParams.get("digits") ?? 6);
  const period = Number(url.searchParams.get("period") ?? 30);
  if (!secret || !["SHA1", "SHA256", "SHA512"].includes(algorithm)) return undefined;
  if (![6, 7, 8].includes(digits) || !Number.isInteger(period) || period < 1 || period > 300)
    return undefined;
  return linkOf(secret, algorithm, digits, period);
}

/** The code of `key` at `now`. */
export function authenticatorCode(key: string, now = Date.now()): string {
  const canonical = authenticatorKey(key);
  if (!canonical) throw new Error("The authenticator key is not valid.");
  const params = new URL(canonical).searchParams;
  const algorithm = params.get("algorithm") as Algorithm;
  const digits = Number(params.get("digits"));
  const period = Number(params.get("period"));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / period)));
  const digest = createHmac(algorithm.toLowerCase(), bytesOf(params.get("secret") as string))
    .update(counter)
    .digest();
  const offset = (digest.at(-1) as number) & 0x0f;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits).padStart(digits, "0");
}
