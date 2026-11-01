import { api } from "../../lib/api";

/**
 * „Hochladen“ of a whole folder (docs/plans/knowledge-base.md): its files with the folders they
 * stand in, from a folder picked (`<input webkitdirectory>`) or dropped. Each folder becomes a
 * folder of Knowledge, its `README.md` or `index.md` the folder's text; the files are uploaded
 * into their folders, once.
 */

/** A file and the folders it stands in, outermost first. */
export interface TreeFile {
  file: File;
  path: string[];
}

/** What uploads take: documents that become pages and tables, and pictures. */
const TAKEN = /\.(pdf|docx?|xlsx|csv|tsv|txt|md|json|html?|eml|png|jpe?g|gif|webp|svg|heic|avif)$/i;
/** Hidden files, a system's own and an editor's temporary ones. */
const SKIPPED = /^(\.|~\$|thumbs\.db$|desktop\.ini$)/i;
/** The text of a folder, where a folder has one. */
const FOLDER_TEXT = /^(readme|index)\.md$/i;
/** At most this many files in one upload. */
export const MAX_TREE_FILES = 500;

/** Whether a file is one an upload takes. */
export const taken = (name: string) => TAKEN.test(name) && !SKIPPED.test(name);

/** The files of a picked folder, by the path the browser gives each (`Kunden/A1/plan.pdf`). */
export function treeOfInput(files: File[]): TreeFile[] {
  return files.map((file) => {
    const parts = (file.webkitRelativePath || file.name).split("/").filter(Boolean);
    return { file, path: parts.slice(0, -1) };
  });
}

/** Whether a drop holds a folder: then it is walked, else its files are uploaded as they are. */
export function dropHoldsFolder(data: DataTransfer): boolean {
  return Array.from(data.items).some((item) => item.webkitGetAsEntry?.()?.isDirectory);
}

/** The files of what was dropped, folders walked, each with the folders it stands in. */
export async function treeOfDrop(data: DataTransfer): Promise<TreeFile[]> {
  const entries = Array.from(data.items)
    .map((item) => item.webkitGetAsEntry?.())
    .filter((e): e is FileSystemEntry => Boolean(e));
  const out: TreeFile[] = [];
  const walk = async (entry: FileSystemEntry, path: string[]): Promise<void> => {
    if (out.length > MAX_TREE_FILES || SKIPPED.test(entry.name)) {
      return;
    }
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) =>
        (entry as FileSystemFileEntry).file(resolve, reject),
      );
      out.push({ file, path });
      return;
    }
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // A directory reader gives its entries in batches until one comes back empty.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
        reader.readEntries(resolve, reject),
      );
      if (!batch.length) {
        break;
      }
      for (const child of batch) {
        await walk(child, [...path, entry.name]);
      }
    }
  };
  for (const entry of entries) {
    await walk(entry, []);
  }
  return out;
}

/** What an upload of a folder did: files taken, files left out, and what went wrong. */
export interface TreeResult {
  folders: number;
  files: number;
  skipped: number;
  /** The folder made for the top of what was uploaded, where there was one. */
  top: string | null;
}

/**
 * Makes the folders, with a `README.md` or `index.md` as a folder's text, then uploads every file
 * into its folder. `upload` takes one file and its folder; `progress` hears how far it got.
 */
export async function uploadTree(
  spaceId: string,
  parentId: string | null,
  tree: TreeFile[],
  upload: (file: File, parentId: string | null) => Promise<unknown>,
  progress: (done: number, of: number) => void,
): Promise<TreeResult> {
  const files = tree.filter((t) => taken(t.file.name)).slice(0, MAX_TREE_FILES);
  const skipped = tree.length - files.length;
  const key = (path: string[]) => path.join("/");
  const texts = new Map<string, File>();
  for (const t of files) {
    if (FOLDER_TEXT.test(t.file.name) && t.path.length && !texts.has(key(t.path))) {
      texts.set(key(t.path), t.file);
    }
  }
  const folders = new Map<string, string>();
  const paths = new Set<string>();
  for (const t of files) {
    for (let i = 1; i <= t.path.length; i++) {
      paths.add(key(t.path.slice(0, i)));
    }
  }
  const sorted = [...paths].sort((a, b) => a.split("/").length - b.split("/").length);
  for (const path of sorted) {
    const parts = path.split("/");
    const into = parts.length > 1 ? (folders.get(key(parts.slice(0, -1))) ?? null) : parentId;
    const text = texts.get(path);
    const made = await api.post<{ id: string }>(`/api/studio/spaces/${spaceId}/pages`, {
      title: parts[parts.length - 1],
      ...(into ? { parentId: into } : {}),
      ...(text ? { markdown: await text.text() } : {}),
    });
    folders.set(path, made.id);
  }
  const uploads = files.filter((t) => texts.get(key(t.path)) !== t.file);
  let done = 0;
  progress(done, uploads.length);
  for (const t of uploads) {
    await upload(t.file, t.path.length ? (folders.get(key(t.path)) ?? parentId) : parentId);
    progress(++done, uploads.length);
  }
  const tops = new Set(files.map((t) => t.path[0]).filter(Boolean));
  return {
    folders: folders.size,
    files: uploads.length,
    skipped,
    top: tops.size === 1 ? (folders.get([...tops][0]) ?? null) : null,
  };
}
