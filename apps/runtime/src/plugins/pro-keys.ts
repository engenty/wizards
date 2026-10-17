import { createPublicKey, type KeyObject, verify } from "node:crypto";
import { env } from "../env.js";

/**
 * The keys a Pro module's package must be signed with (docs/pro-modules.md).
 * Only the public halves are here; the private one signs in the build of the closed plugins and
 * is kept nowhere else. A new key is added beside the old one, which goes a release later.
 */
const SHIPPED = ["MCowBQYDK2VwAyEAqVQAptgVhkBtobNObBDHAZzKFdted0nH0I+LWAHGER8="];

let keys: KeyObject[] | null = null;

function trusted(): KeyObject[] {
  keys ??= [...SHIPPED, ...env.plugins.proKeys].map((der) =>
    createPublicKey({ key: Buffer.from(der, "base64"), format: "der", type: "spki" }),
  );
  return keys;
}

export interface SignedPackage {
  id: string;
  version: string;
  /** The runtime release it was built for: `v0.2.26`. */
  runtime: string;
  sha256: string;
  /** Base64. */
  signature: string;
}

/** What the signature covers; the packer of the closed plugins writes the same text. */
const message = (p: SignedPackage) =>
  `engenty-module:v1\n${p.id}\n${p.version}\n${p.runtime}\n${p.sha256}`;

/** Whether one of the trusted keys signed this package for this release. */
export function signedByUs(p: SignedPackage): boolean {
  let signature: Buffer;
  try {
    signature = Buffer.from(p.signature, "base64");
  } catch {
    return false;
  }
  const data = Buffer.from(message(p));
  return trusted().some((key) => {
    try {
      return verify(null, data, key, signature);
    } catch {
      return false;
    }
  });
}
