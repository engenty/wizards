import { createGuardedFetch } from "../engenty/connections-external/net/guarded-fetch.js";
import { ServiceError } from "../services/errors.js";
import type { ServerKey } from "../texts.js";
import { MAX_ARCHIVE_MB } from "./read.js";

/**
 * A public repository on GitHub as a zip (docs/plans/capabilities-next.md, piece 4). The address
 * is one a person copies from the browser: the repository, or a folder of it on a branch or tag.
 * The archive comes from GitHub's own download host through the guarded fetch, which follows no
 * redirect into a private network, and is refused before it is read whole where it is too large.
 */

const refuse = (server: ServerKey, params?: Record<string, string | number>) =>
  new ServiceError("invalid", { server, params });

export interface RepoAddress {
  /** `owner/name`. */
  repo: string;
  /** A branch, a tag or a commit; null: the repository's own branch. */
  ref: string | null;
  /** A folder in it; `""`: the repository itself. */
  path: string;
}

const PART = /^[A-Za-z0-9_.-]{1,100}$/;

/**
 * A repository's address on GitHub: `https://github.com/owner/name`, with `.git` or without, and
 * a folder as `…/tree/<branch>/<folder>`. A branch whose name has a slash cannot be told from a
 * folder: its first part is read as the branch. Null for any other address.
 */
export function parseRepoAddress(address: string): RepoAddress | null {
  const typed = address.trim();
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `https://${typed}`);
  } catch {
    return null;
  }
  if (!/^(www\.)?github\.com$/i.test(url.hostname) || !/^https?:$/.test(url.protocol)) {
    return null;
  }
  const [owner, rawName, kind, ref, ...rest] = url.pathname.split("/").filter(Boolean);
  const name = rawName?.replace(/\.git$/i, "");
  if (!(owner && name && PART.test(owner) && PART.test(name))) {
    return null;
  }
  const folder = kind === "tree" || kind === "blob";
  let path: string[];
  try {
    path = folder ? rest.map((part) => decodeURIComponent(part)) : [];
  } catch {
    return null;
  }
  if (path.some((part) => part === ".." || part === "." || part.includes("\\"))) {
    return null;
  }
  return {
    repo: `${owner}/${name}`,
    ref: folder && ref ? decodeURIComponent(ref) : null,
    path: path.join("/"),
  };
}

/** The address a person opens to look at the origin. */
export function repoUrl(address: RepoAddress): string {
  const tail =
    address.ref || address.path
      ? `/tree/${address.ref ?? "HEAD"}${address.path ? `/${address.path}` : ""}`
      : "";
  return `https://github.com/${address.repo}${tail}`;
}

/** The repository as a zip, as it is on its branch or tag now. */
export async function fetchRepoZip(address: RepoAddress): Promise<Uint8Array> {
  const guarded = createGuardedFetch();
  const url = `https://codeload.github.com/${address.repo}/zip/${encodeURIComponent(address.ref ?? "HEAD")}`;
  let res: Response;
  try {
    res = await guarded(url, {
      headers: { accept: "application/zip", "user-agent": "engenty-wizards" },
      signal: AbortSignal.timeout(45_000),
    });
  } catch {
    throw new ServiceError("refused", { server: "bundleRepoDown" });
  }
  if (res.status === 404) {
    throw refuse("bundleRepoNotFound", { repo: address.repo });
  }
  if (!res.ok) {
    throw new ServiceError("refused", { server: "bundleRepoDown" });
  }
  const max = MAX_ARCHIVE_MB * 1_000_000;
  const tooLarge = () => refuse("bundleTooLarge", { mb: MAX_ARCHIVE_MB });
  if (Number(res.headers.get("content-length")) > max) {
    throw tooLarge();
  }
  const reader = res.body?.getReader();
  if (!reader) {
    const all = new Uint8Array(await res.arrayBuffer());
    if (all.length > max) {
      throw tooLarge();
    }
    return all;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > max) {
        throw tooLarge();
      }
      chunks.push(value);
    }
  } catch (err) {
    await reader.cancel().catch(() => undefined);
    throw err instanceof ServiceError
      ? err
      : new ServiceError("refused", { server: "bundleRepoDown" });
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.byteLength;
  }
  return all;
}
