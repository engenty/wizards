/**
 * Pictures from the web in what a step shows. A generated page may load nothing from the
 * network (see render/guard.ts), so an <img src="https://…"> a model wrote, or a photo URL a
 * widget's data carries, would stay blank. Before the page is kept, each such picture is fetched
 * once, saved as an asset of the run and referred to as asset://ID — inlined wherever the page
 * is shown or converted, and still there when the site has taken the picture down.
 */
import type { AssetRef } from "@engenty/wizards-shared/run";
import { safeFetch } from "../tools/net-guard.js";
import type { SaveAssetInput } from "./storage.js";

/** Pictures one step may take from the web, and how large one may be. */
const MAX_IMAGES = 40;
const MAX_BYTES = 8_000_000;
const TIMEOUT_MS = 10_000;
const PARALLEL = 4;

const IMAGE_EXT = /\.(?:jpe?g|png|webp|gif|avif|svg)(?:[?#]|$)/i;
/** A key whose value is likely a picture: the extension of its URL may be hidden behind a token. */
const IMAGE_KEY = /image|photo|picture|thumb|cover|logo|avatar|img|poster|banner/i;

export type SaveImage = (input: Omit<SaveAssetInput, "runId">) => Promise<AssetRef>;

interface Snapshot {
  /** URL → asset://ID for every picture that could be fetched. */
  refs: Map<string, string>;
}

/** Fetches one picture; null when it is no image, too large, unreachable or private. */
export async function fetchWebImage(
  url: string,
  signal?: AbortSignal,
): Promise<{ mime: string; data: Buffer } | null> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  try {
    const res = await safeFetch(url, {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { accept: "image/*" },
    });
    const mime = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    const length = Number(res.headers.get("content-length") ?? 0);
    if (!res.ok || !mime.startsWith("image/") || length > MAX_BYTES) {
      await res.body?.cancel();
      return null;
    }
    const data = Buffer.from(await res.arrayBuffer());
    return data.byteLength && data.byteLength <= MAX_BYTES ? { mime, data } : null;
  } catch {
    return null;
  }
}

/** Takes the pictures behind `urls` into the run, a few at a time. */
async function snapshot(
  urls: Iterable<string>,
  save: SaveImage,
  stepId: string | undefined,
  signal?: AbortSignal,
): Promise<Snapshot> {
  const refs = new Map<string, string>();
  const list = [...new Set(urls)].slice(0, MAX_IMAGES);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(PARALLEL, list.length) }, async () => {
      while (next < list.length && !signal?.aborted) {
        const url = list[next++];
        const image = await fetchWebImage(url, signal);
        if (!image) {
          continue;
        }
        const ref = await save({
          stepId,
          kind: "web-image",
          mime: image.mime,
          name: new URL(url).pathname.split("/").pop()?.slice(0, 120) || "image",
          data: image.data,
        });
        refs.set(url, `asset://${ref.id}`);
      }
    }),
  );
  return { refs };
}

const IMG_SRC = /(<img\b[^>]*?\ssrc\s*=\s*)(["'])(https?:\/\/[^"']+)\2/gi;

/** The pictures a generated page loads from the web, kept as assets; its <img> tags then point at them. */
export async function snapshotHtmlImages(
  html: string,
  save: SaveImage,
  stepId?: string,
  signal?: AbortSignal,
): Promise<string> {
  const urls = [...html.matchAll(IMG_SRC)].map((m) => m[3]);
  if (!urls.length) {
    return html;
  }
  const { refs } = await snapshot(urls, save, stepId, signal);
  return html.replace(IMG_SRC, (m, head: string, q: string, url: string) => {
    const ref = refs.get(url);
    return ref ? `${head}${q}${ref}${q}` : m;
  });
}

function isImageUrl(value: string, key: string): boolean {
  if (!/^https?:\/\/\S+$/.test(value) || value.length > 2000) {
    return false;
  }
  return IMAGE_EXT.test(new URL(value).pathname + new URL(value).search) || IMAGE_KEY.test(key);
}

function walk(value: unknown, key: string, visit: (url: string, key: string) => unknown): unknown {
  if (typeof value === "string") {
    return isImageUrl(value, key) ? visit(value, key) : value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => walk(v, key, visit));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, walk(v, k, visit)]),
    );
  }
  return value;
}

/**
 * The pictures a widget's data points to on the web (a listing's photos, a product's cover),
 * kept as assets; the data then carries asset://ID where the page expects the URL.
 */
export async function snapshotDataImages<T>(
  data: T,
  save: SaveImage,
  stepId?: string,
  signal?: AbortSignal,
): Promise<T> {
  const urls: string[] = [];
  walk(data, "", (url) => {
    urls.push(url);
    return url;
  });
  if (!urls.length) {
    return data;
  }
  const { refs } = await snapshot(urls, save, stepId, signal);
  return walk(data, "", (url) => refs.get(url) ?? url) as T;
}
