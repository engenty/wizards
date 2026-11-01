import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * What the portal keeps in the browser, sealed: the session's tokens and the sign-in's state.
 * AES-256-GCM with a key from the portal's secret; a value that was changed or sealed with another
 * key opens to nothing.
 */

const keyOf = (secret: string) => createHash("sha256").update(`portal:${secret}`).digest();

export function seal(secret: string, value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyOf(secret), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

export function unseal<T>(secret: string, sealed: string | undefined | null): T | null {
  if (!sealed) {
    return null;
  }
  try {
    const raw = Buffer.from(sealed, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", keyOf(secret), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const text = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString(
      "utf8",
    );
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
