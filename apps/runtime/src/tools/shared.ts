import type { AssetRef } from "@engenty-wizards/shared/run";
import type { StepContext } from "../engine/types.js";
import { ServiceError } from "../services/errors.js";
import { type StoreScope, writeStoreFile } from "../store/index.js";

export const TEXT_LIMIT = 8000;

export function clip(s: string, limit = TEXT_LIMIT): string {
  return s.length > limit ? `${s.slice(0, limit)}\n…[truncated ${s.length - limit} chars]` : s;
}

/** What a tool answers when it failed: the message, and what a service's refusal says beside it. */
export type ToolError = { error: string } & Record<string, unknown>;

/**
 * A tool failure is something the model reads and reacts to, never a crashed step or turn. A
 * service's refusal brings its data along (`issues`, `fields`, `column`), so the model can fix
 * what it sent. The message is clipped to `limit` characters (400): a site or an API can answer
 * with a whole page; the studio's agents, whose failures are the runtime's own, pass `Infinity`.
 */
export async function attempt<T>(
  run: () => Promise<T>,
  { limit = 400 }: { limit?: number } = {},
): Promise<T | ToolError> {
  try {
    return await run();
  } catch (err) {
    const error = String((err as Error)?.message ?? err).slice(0, limit);
    return err instanceof ServiceError ? { error, ...err.data } : { error };
  }
}

/**
 * A tool's `toModelOutput` for a result that carries a picture: the base64 under `key` goes to the
 * model as an image (of `mime`, else PNG), the rest as text beside it – as JSON, or as `text`
 * makes it. A result without the picture, a failure among them, goes as JSON.
 */
export function imageOutput(
  key: string,
  text: (rest: Record<string, unknown>) => string = (rest) => JSON.stringify(rest),
) {
  return (out: any) => {
    if (!out || out.error || typeof out[key] !== "string" || !out[key]) {
      return { type: "json", value: out };
    }
    const { [key]: data, mime, ...rest } = out;
    return {
      type: "content",
      value: [
        { type: "text", text: text(rest) },
        { type: "image-data", data, mediaType: mime ?? "image/png" },
      ],
    };
  };
}

/**
 * Files a step collects go two places: the wizard's store (kept for next time) and the step's
 * result (this run's download). One keeper per step, so a file saved twice is one result.
 */
export class FileKeeper {
  private readonly kept = new Map<string, AssetRef>();

  constructor(
    private readonly ctx: StepContext,
    private readonly assets: AssetRef[],
  ) {}

  async keep(
    rawPath: string,
    data: Uint8Array,
    meta: { mime?: string; source?: string },
  ): Promise<{ path: string; mime: string; size: number }> {
    const scope: StoreScope = this.ctx.store;
    const file = await writeStoreFile(scope, rawPath, data, meta);
    if (!this.kept.has(file.path)) {
      const ref = await this.ctx.saveAsset({
        kind: "file",
        mime: file.mime,
        name: file.path.split("/").pop() ?? "file",
        data,
      });
      this.kept.set(file.path, ref);
      this.assets.push(ref);
    }
    return { path: file.path, mime: file.mime, size: file.size };
  }
}
