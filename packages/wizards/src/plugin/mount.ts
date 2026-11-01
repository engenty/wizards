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
  /**
   * Files gone by the source's own id (`PluginMountEntry.id`), where the source tells only that:
   * a file deleted on a drive, or moved out of the mounted folder.
   */
  goneIds?: string[];
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
  /** The file's bytes. `id`: the source's id of it, where the runtime knows it from the listing. */
  read(path: string, opts?: { signal?: AbortSignal; id?: string }): Promise<Uint8Array>;
  /** The file as it is now, or null where there is none. */
  stat(path: string, opts?: { id?: string }): Promise<PluginMountEntry | null>;
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

/** A mount of a plugin's kind, as its reader is opened for it. */
export interface PluginMount {
  id: string;
  space: string;
  name: string;
  /** What the kind's `prepare` kept: a connection, a bucket, a folder's id. */
  source: Record<string, unknown>;
}

/**
 * A kind of mount a plugin brings (`registerMountKind`): a bucket, a drive's folder. The studio
 * half registers the same `kind` with its label and the form that connects the account and
 * picks the folder. Its mounts are listed, indexed, searched and opened as the computer's folders
 * are; everything they read goes through the kind's reader.
 */
export interface PluginMountKind {
  /** Lower case, digits and `-`, unique on the runtime: `s3`. */
  kind: string;
  /**
   * What the studio's form gave, checked before the mount is made: the source to keep (no
   * secret in plain text: seal it), the mount's name, and where it lives, in one line for the
   * studio (`s3://fotos/produkte/`). Throws, with the reason as its message, where it can't be
   * reached.
   */
  prepare(input: {
    space: string;
    source: Record<string, unknown>;
  }): Promise<{ source: Record<string, unknown>; name: string; where: string }>;
  /** The reader of a mount of this kind. */
  open(mount: PluginMount): PluginMountReader;
  /**
   * How often the runtime asks `changes` where the reader can't `watch`, in hours. Default 1.
   * A kind whose `changes` lists everything again (a bucket) asks less often.
   */
  everyHours?: number;
  /**
   * Whether the mount's account may write where it is mounted. False: the studio connects it
   * again, with the rights to write, before writing is turned on.
   */
  canWrite?(mount: PluginMount): Promise<boolean>;
}

/** The mounts of the plugin's kinds, for its own routes and jobs. */
export interface PluginMounts {
  /** The mounts of the plugin's kinds, of one space or of every space. */
  list(space?: string): Promise<(PluginMount & { kind: string })[]>;
  /** The source told of a change (a signal address, a webhook): the runtime asks `changes` now. */
  changed(id: string): Promise<void>;
}
