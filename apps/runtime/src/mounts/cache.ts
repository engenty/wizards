import { mkdirSync } from "node:fs";
import { readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ParsedDocument } from "../documents/parse.js";
import { env } from "../env.js";

/**
 * What was read of mounted files' originals, by their hash: a mount keeps no text (decision D3),
 * so a search's snippets, a step's read and the vectors read the original again, and this keeps
 * the last of them. Bounded: past MAX_BYTES the least recently used go first. Rebuildable,
 * never backed up.
 */

const DIR = join(env.dataDir, "parsed", "m");
const MAX_BYTES = 2 * 1024 ** 3;

let size: number | null = null;

const fileOf = (hash: string) => join(DIR, `${hash}.json`);

async function sizeNow(): Promise<number> {
  if (size === null) {
    mkdirSync(DIR, { recursive: true });
    let total = 0;
    for (const name of await readdir(DIR)) {
      total += (await stat(join(DIR, name)).catch(() => null))?.size ?? 0;
    }
    size = total;
  }
  return size;
}

/** The oldest out until the cache is under nine tenths of its bound. */
async function trim() {
  const files = await Promise.all(
    (await readdir(DIR)).map(async (name) => {
      const s = await stat(join(DIR, name)).catch(() => null);
      return { name, size: s?.size ?? 0, at: s?.mtimeMs ?? 0 };
    }),
  );
  files.sort((a, b) => a.at - b.at);
  let total = files.reduce((n, f) => n + f.size, 0);
  for (const f of files) {
    if (total <= MAX_BYTES * 0.9) {
      break;
    }
    await rm(join(DIR, f.name), { force: true });
    total -= f.size;
  }
  size = total;
}

/**
 * The text of the bytes `hash`: from the cache, else made by `read` and kept. Null when the file
 * has no text (a photo, a scan OCR couldn't read); that is kept too, so it is not read again,
 * unless `again` asks for another try at a kept read without text.
 */
export async function cachedText(
  hash: string,
  read: () => Promise<ParsedDocument | null>,
  again = false,
): Promise<ParsedDocument | null> {
  await sizeNow();
  const file = fileOf(hash);
  const kept = await readFile(file, "utf8").catch(() => null);
  const parsed = kept === null ? undefined : (JSON.parse(kept) as ParsedDocument | null);
  if (parsed !== undefined && !(again && !parsed?.markdown.trim())) {
    const now = new Date();
    await utimes(file, now, now).catch(() => undefined);
    return parsed;
  }
  const made = await read();
  const json = JSON.stringify(made);
  await writeFile(file, json);
  size = (size ?? 0) + Buffer.byteLength(json);
  if (size > MAX_BYTES) {
    await trim();
  }
  return made;
}

/** The text kept for `hash`, without reading the original; undefined where none is kept. */
export async function keptText(hash: string): Promise<ParsedDocument | null | undefined> {
  const kept = await readFile(fileOf(hash), "utf8").catch(() => null);
  return kept === null ? undefined : (JSON.parse(kept) as ParsedDocument | null);
}
