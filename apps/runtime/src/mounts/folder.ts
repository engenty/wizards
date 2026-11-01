import { type FSWatcher, watch } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type {
  PluginMountChanges,
  PluginMountEntry,
  PluginMountReader,
} from "@engenty/wizards/plugin";

/**
 * A folder on this computer as a mount: the first kind of Dateien. Its files are listed and read
 * where they are; `fs.watch` tells of changes (recursive on macOS, Windows and Linux), and the
 * runtime lists the whole tree again at start and hourly for what a watcher misses.
 */

/** Files a folder has that are nobody's content: hidden files, Office's lock files, caches. */
export function leftOut(name: string): boolean {
  return (
    name.startsWith(".") ||
    name.startsWith("~$") ||
    name === "Thumbs.db" ||
    name === "desktop.ini" ||
    name === "node_modules" ||
    name.endsWith(".tmp")
  );
}

/** Whether a path in the mount passes through a part that is left out. */
const leftOutPath = (path: string) => path.split("/").some(leftOut);

export class FolderReader implements PluginMountReader {
  readonly root: string;
  /** Paths fs.watch named since the last `changes`, or null after it overflowed or failed. */
  private touched: Set<string> | null = new Set();
  private watcher: FSWatcher | null = null;
  private turn = 0;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /** The absolute path of a path in the mount; never outside the folder. */
  private full(path: string): string {
    const full = resolve(this.root, path);
    if (full !== this.root && !full.startsWith(this.root + sep)) {
      throw new Error(`"${path}" is outside the folder.`);
    }
    return full;
  }

  private relativeOf(full: string): string {
    return relative(this.root, full).split(sep).join("/");
  }

  private async entryOf(path: string): Promise<PluginMountEntry | null> {
    const s = await stat(this.full(path)).catch(() => null);
    return s?.isFile()
      ? { path, size: s.size, modified: Math.floor(s.mtimeMs), version: null }
      : null;
  }

  async *list(path = "", opts: { signal?: AbortSignal } = {}): AsyncIterable<PluginMountEntry> {
    const dirs = [this.full(path)];
    while (dirs.length) {
      opts.signal?.throwIfAborted();
      const dir = dirs.pop() as string;
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        if (leftOut(e.name)) {
          continue;
        }
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          dirs.push(full);
        } else if (e.isFile()) {
          const entry = await this.entryOf(this.relativeOf(full));
          if (entry) {
            yield entry;
          }
        }
      }
    }
  }

  async changes(cursor: string | null): Promise<PluginMountChanges> {
    const next = String(++this.turn);
    if (cursor === null) {
      this.touched = new Set();
      return { changed: [], gone: [], cursor: next };
    }
    const touched = this.touched;
    this.touched = new Set();
    // Another turn's cursor, or the watcher lost events: only a whole listing says it.
    if (!touched || cursor !== String(this.turn - 1)) {
      return { changed: [], gone: [], cursor: next, relist: true };
    }
    const changed: PluginMountEntry[] = [];
    const gone: string[] = [];
    for (const path of touched) {
      const s = await stat(this.full(path)).catch(() => null);
      if (!s) {
        gone.push(path);
      } else if (s.isDirectory()) {
        // A folder moved in or renamed: everything under it.
        for await (const entry of this.list(path)) {
          changed.push(entry);
        }
      } else if (s.isFile()) {
        changed.push({ path, size: s.size, modified: Math.floor(s.mtimeMs), version: null });
      }
    }
    return { changed, gone, cursor: next };
  }

  async read(path: string): Promise<Uint8Array> {
    return readFile(this.full(path));
  }

  stat(path: string): Promise<PluginMountEntry | null> {
    return this.entryOf(path);
  }

  async write(
    path: string,
    data: Uint8Array,
    expected: PluginMountEntry | null,
  ): Promise<PluginMountEntry> {
    const now = await this.entryOf(path);
    if (expected ? !now || now.size !== expected.size || now.modified !== expected.modified : now) {
      throw Object.assign(new Error(`"${path}" changed in the folder.`), { code: "conflict" });
    }
    const full = this.full(path);
    await mkdir(dirname(full), { recursive: true });
    // Written beside it and moved over it: a reader never sees half a file.
    const temp = `${full}.~engenty`;
    await writeFile(temp, data);
    await rename(temp, full);
    return (await this.entryOf(path)) as PluginMountEntry;
  }

  watch(changed: () => void): () => void {
    try {
      this.watcher = watch(this.root, { recursive: true }, (_event, name) => {
        if (!name) {
          // The system dropped events: list everything next time.
          this.touched = null;
        } else {
          const path = String(name).split(sep).join("/");
          if (!leftOutPath(path)) {
            this.touched?.add(path);
          }
        }
        changed();
      });
      this.watcher.on("error", () => {
        this.touched = null;
        changed();
      });
    } catch {
      this.touched = null;
    }
    return () => this.close();
  }

  close() {
    this.watcher?.close();
    this.watcher = null;
  }
}
