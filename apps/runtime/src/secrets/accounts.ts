import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
  randomBytes,
} from "node:crypto";
import { env } from "../env.js";

/*
 * Connected accounts (`store_secret`, a space connection's `secret`, a person's sign-in to one)
 * are sealed with a public key and opened with a private key (docs/plans/runs-on-their-own.md,
 * 7.1). `ACCOUNTS_KEY` is the private key: a cloud sets it on the broker alone and gives every
 * other process `ACCOUNTS_PUBLIC_KEY`, so they seal a new sign-in but open none. A runtime that
 * sets neither derives the pair from `STORE_ENC_KEY` (or the app secret): its one process holds
 * both. `wizards reseal-accounts` seals what `seal()` sealed before once more this way.
 */

/** The DER prefixes of a raw X25519 key: PKCS #8 for the private one, SPKI for the public one. */
const PKCS8 = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI = Buffer.from("302a300506032b656e032100", "hex");

const privateOf = (raw: Buffer) =>
  createPrivateKey({ key: Buffer.concat([PKCS8, raw]), format: "der", type: "pkcs8" });
const publicOf = (raw: Buffer) =>
  createPublicKey({ key: Buffer.concat([SPKI, raw]), format: "der", type: "spki" });
const rawPublic = (key: KeyObject) =>
  (key.export({ format: "der", type: "spki" }) as Buffer).subarray(SPKI.length);
const rawPrivate = (key: KeyObject) =>
  (key.export({ format: "der", type: "pkcs8" }) as Buffer).subarray(PKCS8.length);

function keysHere(): { open: KeyObject | null; seal: KeyObject } {
  if (env.accountsKey) {
    const open = privateOf(Buffer.from(env.accountsKey, "base64url"));
    const seal = createPublicKey(open);
    if (
      env.accountsPublicKey &&
      !rawPublic(seal).equals(Buffer.from(env.accountsPublicKey, "base64url"))
    ) {
      throw new Error("ACCOUNTS_PUBLIC_KEY is not the public key of ACCOUNTS_KEY.");
    }
    return { open, seal };
  }
  if (env.accountsPublicKey) {
    return { open: null, seal: publicOf(Buffer.from(env.accountsPublicKey, "base64url")) };
  }
  const derived = hkdfSync(
    "sha256",
    env.storeKey || env.authSecret,
    "engenty-wizards",
    "account-secrets",
    32,
  );
  const open = privateOf(Buffer.from(derived));
  return { open, seal: createPublicKey(open) };
}

const keys = keysHere();
const sealTo = rawPublic(keys.seal);

/** The AES key of one sealed value: from the shared secret, bound to both public keys. */
const aesKey = (shared: Buffer, ephemeral: Buffer) =>
  Buffer.from(
    hkdfSync("sha256", shared, Buffer.concat([ephemeral, sealTo]), "engenty-wizards accounts", 32),
  );

/** `v2.<ephemeral public key>.<iv>.<tag>.<body>`: X25519 to this runtime's key, then AES-256-GCM. */
export function sealAccount(value: unknown): string {
  const ephemeral = generateKeyPairSync("x25519");
  const epk = rawPublic(ephemeral.publicKey);
  const key = aesKey(
    diffieHellman({ privateKey: ephemeral.privateKey, publicKey: keys.seal }),
    epk,
  );
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return ["v2", ...[epk, iv, cipher.getAuthTag(), body].map((b) => b.toString("base64url"))].join(
    ".",
  );
}

/** Whether this process holds the private key: the broker, or a runtime that runs alone. */
export function opensAccounts(): boolean {
  return keys.open !== null;
}

/**
 * What `sealAccount` sealed; null when it is something else or was changed. Throws in a process
 * without the private key: only the broker opens a connected account.
 */
export function unsealAccount<T>(sealed: string): T | null {
  if (!keys.open) {
    throw new Error("Connected accounts are opened by the broker, not by this process.");
  }
  const [version, epk, iv, tag, body] = sealed.split(".");
  if (version !== "v2" || !epk || !iv || !tag || !body) {
    return null;
  }
  try {
    const ephemeral = Buffer.from(epk, "base64url");
    const key = aesKey(
      diffieHellman({ privateKey: keys.open, publicKey: publicOf(ephemeral) }),
      ephemeral,
    );
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(body, "base64url")),
      decipher.final(),
    ]);
    return JSON.parse(plain.toString("utf8")) as T;
  } catch {
    return null;
  }
}

/** A new pair for a cloud: `ACCOUNTS_KEY` for the broker, `ACCOUNTS_PUBLIC_KEY` for the rest. */
export function newAccountsKey(): { key: string; publicKey: string } {
  const pair = generateKeyPairSync("x25519");
  return {
    key: rawPrivate(pair.privateKey).toString("base64url"),
    publicKey: rawPublic(pair.publicKey).toString("base64url"),
  };
}
