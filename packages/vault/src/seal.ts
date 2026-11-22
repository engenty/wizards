import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

// A sealed value is AES-256-GCM under one key of a key ring, bound to where it belongs.
//
//   v2.<key id>.<nonce>.<tag>.<ciphertext>      each part base64url
//
// The binding (an owner, a table, a row, a purpose: whatever the caller names) and the key id are
// the additional data of the cipher, so a value copied to another row, another owner or another
// purpose doesn't open, and neither does one whose key id was changed. Nothing of the binding is
// stored in the sealed value: the caller knows it from where the value is kept.

const FORMAT = "v2";
const AAD_PREFIX = "engenty-vault";
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;

/** A key of a ring: 32 bytes and the id sealed values name it by. */
export interface VaultKey {
  id: string;
  key: Buffer;
}

/** The key that seals, and the earlier ones that still open what they sealed. */
export interface KeyRing {
  current: VaultKey;
  previous: readonly VaultKey[];
}

export type VaultErrorReason =
  /** The text is not a sealed value of this format. */
  | "format"
  /** The value names a key the ring doesn't hold. */
  | "unknown-key"
  /** The key or the binding is not the one it was sealed with, or the value was changed. */
  | "not-opened";

export class VaultError extends Error {
  readonly reason: VaultErrorReason;

  constructor(reason: VaultErrorReason, message: string) {
    super(message);
    this.name = "VaultError";
    this.reason = reason;
  }
}

function checkKey(key: VaultKey): VaultKey {
  if (!KEY_ID.test(key.id)) {
    throw new Error(`A key id is 1 to 32 letters, digits, "-" or "_": "${key.id}" is not.`);
  }
  if (!Buffer.isBuffer(key.key) || key.key.length !== 32) {
    throw new Error(`The key "${key.id}" must be 32 bytes.`);
  }
  return key;
}

/** A ring from the key that seals and the earlier keys that still open. */
export function keyRing(current: VaultKey, ...previous: VaultKey[]): KeyRing {
  const all = [current, ...previous].map(checkKey);
  const ids = new Set(all.map((k) => k.id));
  if (ids.size !== all.length) {
    throw new Error("Two keys of a ring have the same id.");
  }
  return { current, previous };
}

/**
 * A key of its own for one purpose, made from a longer-lived secret with HKDF-SHA256: one secret
 * of an install gives a key per purpose (stored secrets, short-lived state) or per owner (a team,
 * a person), and none of them opens what another sealed.
 */
export function deriveKey(secret: Buffer | string, purpose: string, id = "k1"): VaultKey {
  const material = typeof secret === "string" ? Buffer.from(secret, "utf8") : secret;
  if (material.length < 16) {
    throw new Error("The secret a key is derived from must be at least 16 bytes.");
  }
  if (!purpose) {
    throw new Error("A derived key needs a purpose.");
  }
  const key = Buffer.from(hkdfSync("sha256", material, AAD_PREFIX, purpose, 32));
  return checkKey({ id, key });
}

function additionalData(keyId: string, binding: readonly string[]): Buffer {
  return Buffer.from(JSON.stringify([AAD_PREFIX, keyId, ...binding]), "utf8");
}

/** Seals `value` with the ring's current key, bound to `binding`. */
export function seal(ring: KeyRing, binding: readonly string[], value: string): string {
  const { id, key } = ring.current;
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(additionalData(id, binding));
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [FORMAT, id, nonce, cipher.getAuthTag(), body]
    .map((part) => (typeof part === "string" ? part : part.toString("base64url")))
    .join(".");
}

interface Parts {
  keyId: string;
  nonce: Buffer;
  tag: Buffer;
  body: Buffer;
}

function parse(sealed: string): Parts {
  const parts = sealed.split(".");
  const [format, keyId, nonce, tag, body] = parts;
  if (
    parts.length !== 5 ||
    format !== FORMAT ||
    !keyId ||
    !KEY_ID.test(keyId) ||
    !nonce ||
    !tag ||
    body === undefined
  ) {
    throw new VaultError("format", "This is not a sealed value.");
  }
  const parsed = {
    keyId,
    nonce: Buffer.from(nonce, "base64url"),
    tag: Buffer.from(tag, "base64url"),
    body: Buffer.from(body, "base64url"),
  };
  if (parsed.nonce.length !== 12 || parsed.tag.length !== 16) {
    throw new VaultError("format", "This is not a sealed value.");
  }
  return parsed;
}

/** The id of the key a value was sealed with. */
export function keyIdOf(sealed: string): string {
  return parse(sealed).keyId;
}

/**
 * Opens a sealed value. It throws a `VaultError` when it can't, and never answers something
 * else in its place: a caller that can't open a secret must not carry on as if there were none.
 */
export function unseal(ring: KeyRing, binding: readonly string[], sealed: string): string {
  const { keyId, nonce, tag, body } = parse(sealed);
  const found = [ring.current, ...ring.previous].find((k) => k.id === keyId);
  if (!found) {
    throw new VaultError(
      "unknown-key",
      `The value was sealed with the key "${keyId}", which the ring doesn't hold.`,
    );
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", found.key, nonce, { authTagLength: 16 });
    decipher.setAAD(additionalData(keyId, binding));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    throw new VaultError("not-opened", "The value doesn't open with this key and binding.");
  }
}

/** Whether a value was sealed with a key other than the ring's current one. */
export function needsReseal(ring: KeyRing, sealed: string): boolean {
  return keyIdOf(sealed) !== ring.current.id;
}

/** The value sealed again with the ring's current key; a value sealed with it already comes back as it is. */
export function reseal(ring: KeyRing, binding: readonly string[], sealed: string): string {
  return needsReseal(ring, sealed) ? seal(ring, binding, unseal(ring, binding, sealed)) : sealed;
}

const CHECK_TEXT = "engenty-vault key check";

/**
 * A key check: a known text sealed for `owner`, kept beside the owner's secrets. Before a store
 * reads or writes a secret it checks the ring against it (`keyCheckHolds`). A wrong or missing
 * key then stops the store before it writes anything another key can't open.
 */
export function sealKeyCheck(ring: KeyRing, owner: string): string {
  return seal(ring, ["key-check", owner], CHECK_TEXT);
}

/** Whether the ring opens the owner's key check. */
export function keyCheckHolds(ring: KeyRing, owner: string, sealed: string): boolean {
  try {
    return unseal(ring, ["key-check", owner], sealed) === CHECK_TEXT;
  } catch (error) {
    if (error instanceof VaultError) {
      return false;
    }
    throw error;
  }
}
