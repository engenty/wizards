import { createHash } from "node:crypto";
import { objects } from "./objects.js";

/** Content-addressed file store for workspaces: a blob never changes, so snapshots are just lists of hashes. */
const blobKey = (hash: string) => `blobs/${hash.slice(0, 2)}/${hash}`;

export async function putBlob(data: Uint8Array): Promise<string> {
  const hash = createHash("sha256").update(data).digest("hex");
  const key = blobKey(hash);
  if (!(await objects.has(key))) {
    await objects.put(key, data);
  }
  return hash;
}

export async function getBlob(hash: string): Promise<Buffer> {
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error("bad blob hash");
  }
  const data = await objects.get(blobKey(hash));
  if (!data) {
    throw new Error("blob missing");
  }
  return data;
}

/** Whether the store has the bytes of this hash. */
export async function hasBlob(hash: string): Promise<boolean> {
  return /^[a-f0-9]{64}$/.test(hash) && objects.has(blobKey(hash));
}

/** Keeps bytes that arrived for a hash, after checking they are what the hash says. */
export async function putBlobOf(hash: string, data: Uint8Array): Promise<void> {
  if (createHash("sha256").update(data).digest("hex") !== hash) {
    throw new Error("blob does not match its hash");
  }
  if (!(await objects.has(blobKey(hash)))) {
    await objects.put(blobKey(hash), data);
  }
}
