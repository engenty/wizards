/**
 * A file tree another party owns, as Dateien reads it (docs/plans/media-and-files.md, section
 * 3): a folder on this computer, a bucket, a drive's folder. Every mount implements this one
 * reader. The runtime lists the tree, follows its changes, reads a file when it indexes, opens or
 * hands it to a step, and writes only where the mount allows it; it keeps no copy of the bytes.
 */

/** A file of a mount, as its source tells it. Folders are no entries: the paths say them. */
export interface PluginMountEntry {
  /** Its path in the mount, with `/` and without a leading one: `Kunden/A1/angebot.pdf`. */
  path: string;
  size: number;
  /** When it last changed, in milliseconds. */
  modified: number;
  /** Its type where the source says it; else the runtime goes by the name. */
  mime?: string;
  /**
   * What the source changes with the bytes, where it has one: an ETag, Drive's `md5Checksum`,
   * OneDrive's `cTag`. Null: size and time say it (a folder on a computer), and the runtime
   * hashes the bytes where those changed.
   */
  version: string | null;
  /** The source's own id where it keeps one across a move (Drive, OneDrive): the row follows it. */
  id?: string;
}

/** What changed since a cursor. */
export interface PluginMountChanges {
  /** Files new or changed. */
  changed: PluginMountEntry[];
  /** Paths gone; a folder's path stands for everything under it. */
  gone: string[];
  /** What to ask from next time. */
  cursor: string;
  /** The source can't say what changed since that cursor: the runtime lists the whole tree. */
  relist?: boolean;
}

export interface PluginMountReader {
  /** Every file under `path`, or in the whole tree, in no particular order. */
  list(path?: string, opts?: { signal?: AbortSignal }): AsyncIterable<PluginMountEntry>;
  /** What changed since `cursor`. Null asks where to start: no changes, and the cursor. */
  changes(cursor: string | null): Promise<PluginMountChanges>;
  /** The file's bytes. */
  read(path: string, opts?: { signal?: AbortSignal }): Promise<Uint8Array>;
  /** The file as it is now, or null where there is none. */
  stat(path: string): Promise<PluginMountEntry | null>;
  /**
   * Writes the file, where the mount allows writing. `expected` is the entry it was read as:
   * changed at the source since, the write is refused with an error whose `code` is `conflict`.
   * Null writes a new file and is refused where one stands.
   */
  write(
    path: string,
    data: Uint8Array,
    expected: PluginMountEntry | null,
  ): Promise<PluginMountEntry>;
  /**
   * Where the source tells of changes: calls `changed` soon after one, and the runtime asks
   * `changes`. Gives what stops it. Without it the runtime asks on its own, hourly.
   */
  watch?(changed: () => void): () => void;
  /** Lets go of what it holds: a watcher, a connection. */
  close?(): void;
}
