import type { FileRead, FileSave, FilesService } from "@engenty/wizards-shared/run-services";
import { type RunRow, type StepContext, StepError } from "../engine/types.js";
import { extFor, loadAsset, saveAsset } from "../files/storage.js";
import { snapshotHtmlImages } from "../files/web-images.js";
import { signedUrl } from "../secrets/signing.js";
import { assertPublicUrl, safeFetch } from "../tools/net-guard.js";
import { personUploads, type UploadRef } from "../tools/store.js";

export type { UploadRef };
export { extFor };

/**
 * The run's files inside the runtime. Beyond `FilesService`, as step code needs them today:
 * a read says which run the file belongs to, the files the person gave on earlier pages, and the
 * web pictures of a page kept as files of the run.
 */
export interface InProcessFiles extends FilesService {
  /** `runId`: the run the file belongs to; null: a file of no run. */
  read(ref: string): Promise<(FileRead & { runId: string | null }) | null>;
  /** Files the person gave on earlier pages: `upload:<id>` is how tools address them. */
  uploads(): Promise<UploadRef[]>;
  /** The page with each picture it loads from the web saved as a file of the step. */
  keepWebImages(html: string, stepId: string): Promise<string>;
}

export function filesService(run: RunRow, ctx: () => StepContext): InProcessFiles {
  const save = async (file: FileSave) => {
    const { mime, data } = "url" in file ? await fetched(file, ctx().signal) : file;
    return saveAsset({
      runId: run.id,
      stepId: file.stepId ?? ctx().stepId,
      kind: file.kind,
      mime,
      name: file.name,
      data,
      ...(file.ai ? { ai: file.ai } : {}),
    });
  };
  return {
    async read(ref) {
      const found = await loadAsset(ref);
      if (!found) {
        return null;
      }
      const { row, data } = found;
      return {
        ref: { id: row.id, kind: row.kind, mime: row.mime, name: row.name },
        data: new Uint8Array(data),
        runId: row.runId,
      };
    },
    save,
    link: async (ref) => signedUrl(`/api/runs/${run.id}/assets/${ref}`),
    uploads: () => personUploads(ctx()),
    keepWebImages: (html, stepId) => snapshotHtmlImages(html, save, stepId, ctx().signal),
  };
}

/** A file saved by its address: fetched from the open web, never from this network. */
async function fetched(file: Extract<FileSave, { url: string }>, signal: AbortSignal) {
  const url = await assertPublicUrl(file.url);
  const res = await safeFetch(url.toString(), {
    signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
  });
  if (!res.ok) {
    throw new StepError(`${url.hostname} answered ${res.status}.`);
  }
  const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  return {
    mime: file.mime ?? (type || "application/octet-stream"),
    data: new Uint8Array(await res.arrayBuffer()),
  };
}
